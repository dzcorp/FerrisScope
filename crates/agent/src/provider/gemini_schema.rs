//! JSON Schema → Gemini function-declaration schema.
//!
//! Gemini takes a small OpenAPI-style dialect for tool parameters and rejects
//! the whole request (HTTP 400, naming `function_declarations[N]`) when any one
//! tool strays outside it. This follows what opencode ships in production,
//! which is two passes over each tool schema:
//!
//! 1. **sanitize** — opencode's `ProviderTransform.schema` Gemini branch:
//!    enum members become strings (and the type with them), `type` arrays
//!    split into `anyOf`, `required` is cut to declared properties, arrays get
//!    an `items`, scalars lose `properties` / `required`;
//! 2. **convert** — `@ai-sdk/google`'s `convertJSONSchemaToOpenAPISchema`:
//!    copies only the keys Gemini understands and drops everything else
//!    (`additionalProperties`, `$ref`, `pattern`, …).
//!
//! Where this deliberately goes further than opencode — each can only turn a
//! would-be 400 into a working request:
//!
//! - local `$ref`s are inlined (pydantic / zod emit them for nested models);
//! - a node with no `type` (a bare `{}` from `any`, or a leftover `$ref`) gets
//!   one inferred from its keywords, because Gemini answers "schema didn't
//!   specify the schema type field";
//! - `format` is kept only where Gemini accepts it (`date-time`, `enum`,
//!   `int32`/`int64`, `float`/`double`); `uri`, `uuid`, `email` are a 400.
//!
//! One deliberate non-change: a *nested* object with no properties stays
//! `{ "type": "object" }`. Dropping it (as opencode's newer experimental
//! `packages/llm` path does) silently deletes the property, and for an array of
//! generic objects deletes `items` — exactly the "items: missing field" 400.

use serde_json::{Map, Value};

/// Keywords that mean "this node says something about the value's shape".
const INTENT_KEYS: &[&str] = &[
    "type",
    "properties",
    "items",
    "prefixItems",
    "enum",
    "const",
    "$ref",
    "additionalProperties",
    "patternProperties",
    "required",
    "not",
    "if",
    "then",
    "else",
];

/// How deep `$ref` inlining follows definitions before giving up with a
/// generic object (also the cycle guard for self-referential schemas).
const MAX_REF_DEPTH: usize = 8;

/// Convert a tool's JSON Schema into Gemini's dialect. `None` when the tool
/// takes no parameters, in which case the function declaration must omit
/// `parameters` altogether.
pub fn convert(schema: &Value) -> Option<Value> {
    let obj = schema.as_object()?;
    // Nothing to describe: no parameters (not a typeless "string").
    if !has_intent(schema) && !has_combiner(obj) {
        return None;
    }
    let resolved = resolve_refs(schema);
    let mut out = to_openapi(&sanitize(&resolved), true)?;
    repair(&mut out);
    // Function parameters are an object; any other root (a `$ref` that
    // resolved to a scalar, a root `anyOf`) can't be one, so the tool is
    // declared without parameters rather than with a declaration Gemini rejects.
    (out.get("type").and_then(Value::as_str) == Some("object")).then_some(out)
}

/// Last line of defence: enforce the invariants Gemini's validator checks on
/// the *output*, whatever shape the input had. The earlier passes should leave
/// nothing to do here; this exists so that a schema we mishandled degrades to a
/// slightly vaguer declaration instead of a 400 that disables the whole chat.
fn repair(node: &mut Value) {
    let Some(o) = node.as_object_mut() else {
        return;
    };
    let combiner = has_combiner(o);

    if !o.contains_key("type") && !combiner {
        o.insert("type".into(), Value::String("string".into()));
    }
    // Enums are string enums.
    if let Some(Value::Array(members)) = o.get_mut("enum") {
        for m in members.iter_mut() {
            *m = enum_member_to_string(m);
        }
        o.insert("type".into(), Value::String("string".into()));
    }
    let ty = o.get("type").and_then(Value::as_str).map(str::to_owned);

    if ty.as_deref() == Some("array") && o.get("items").is_none_or(Value::is_null) {
        let mut items = Map::new();
        items.insert("type".into(), Value::String("string".into()));
        o.insert("items".into(), Value::Object(items));
    }
    if ty.as_deref().is_some_and(|t| t != "object") && !combiner {
        o.remove("properties");
        o.remove("required");
    }
    if let Some(Value::String(f)) = o.get("format").cloned() {
        if !format_allowed(ty.as_deref(), &f) {
            o.remove("format");
        }
    }

    // Recurse, then reconcile `required` with what is left of `properties`.
    if let Some(Value::Object(props)) = o.get_mut("properties") {
        for v in props.values_mut() {
            repair(v);
        }
    }
    match o.get_mut("items") {
        Some(Value::Array(tuple)) => tuple.iter_mut().for_each(repair),
        Some(items) => repair(items),
        None => {}
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(Value::Array(members)) = o.get_mut(key) {
            members.iter_mut().for_each(repair);
        }
    }
    let declared: Option<Vec<String>> = o
        .get("properties")
        .and_then(Value::as_object)
        .map(|p| p.keys().cloned().collect());
    if let Some(Value::Array(req)) = o.get_mut("required") {
        match &declared {
            Some(names) => {
                req.retain(|r| r.as_str().is_some_and(|s| names.iter().any(|n| n == s)));
            }
            None => req.clear(),
        }
    }
    if declared.is_none()
        && o.get("required")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
    {
        o.remove("required");
    }
}

fn has_combiner(node: &Map<String, Value>) -> bool {
    ["anyOf", "oneOf", "allOf"]
        .iter()
        .any(|k| node.get(*k).is_some_and(Value::is_array))
}

fn has_intent(node: &Value) -> bool {
    node.as_object()
        .is_some_and(|o| has_combiner(o) || INTENT_KEYS.iter().any(|k| o.contains_key(*k)))
}

/// JS `String(v)` for an enum member.
fn enum_member_to_string(v: &Value) -> Value {
    match v {
        Value::String(_) => v.clone(),
        Value::Null => Value::String("null".into()),
        Value::Number(n) => Value::String(n.to_string()),
        Value::Bool(b) => Value::String(b.to_string()),
        other => Value::String(other.to_string()),
    }
}

// ─── $ref inlining ──────────────────────────────────────────────────────────

fn resolve_refs(root: &Value) -> Value {
    let mut defs = Map::new();
    if let Some(o) = root.as_object() {
        for key in ["$defs", "definitions"] {
            if let Some(Value::Object(d)) = o.get(key) {
                for (name, schema) in d {
                    defs.insert(format!("#/{key}/{name}"), schema.clone());
                }
            }
        }
    }
    let mut stack = Vec::new();
    let mut out = deref(root, &defs, &mut stack);
    if let Some(o) = out.as_object_mut() {
        o.remove("$defs");
        o.remove("definitions");
    }
    out
}

fn deref(node: &Value, defs: &Map<String, Value>, stack: &mut Vec<String>) -> Value {
    match node {
        Value::Array(items) => Value::Array(items.iter().map(|n| deref(n, defs, stack)).collect()),
        Value::Object(o) => {
            if let Some(Value::String(target)) = o.get("$ref") {
                return inline_ref(o, target, defs, stack);
            }
            Value::Object(
                o.iter()
                    .map(|(k, v)| (k.clone(), deref(v, defs, stack)))
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

fn inline_ref(
    node: &Map<String, Value>,
    target: &str,
    defs: &Map<String, Value>,
    stack: &mut Vec<String>,
) -> Value {
    let generic = || {
        let mut m = Map::new();
        m.insert("type".into(), Value::String("object".into()));
        if let Some(d) = node.get("description") {
            m.insert("description".into(), d.clone());
        }
        Value::Object(m)
    };
    let Some(def) = defs.get(target) else {
        return generic();
    };
    // A definition that (transitively) contains itself, or just nests too
    // deep, collapses to a generic object rather than recursing forever.
    if stack.len() >= MAX_REF_DEPTH || stack.iter().any(|t| t == target) {
        return generic();
    }
    stack.push(target.to_string());
    let mut resolved = deref(def, defs, stack);
    stack.pop();
    // Siblings of `$ref` (a description, usually) refine the definition.
    if let Some(r) = resolved.as_object_mut() {
        for (k, v) in node {
            if k != "$ref" {
                r.insert(k.clone(), deref(v, defs, stack));
            }
        }
    }
    resolved
}

// ─── pass 1: sanitize ───────────────────────────────────────────────────────

/// The type a schema with none must have had, judged by its other keywords.
/// Gemini refuses a node without one, so a guess beats a 400; `string` is the
/// fallback for a bare `{}` (opencode applies the same default to `items`).
fn infer_type(o: &Map<String, Value>) -> &'static str {
    let has = |keys: &[&str]| keys.iter().any(|k| o.contains_key(*k));
    if has(&[
        "properties",
        "required",
        "additionalProperties",
        "patternProperties",
    ]) {
        "object"
    } else if has(&["items", "prefixItems"]) {
        "array"
    } else if has(&[
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
    ]) {
        "number"
    } else if let Some(c) = o.get("const") {
        match c {
            Value::Bool(_) => "boolean",
            Value::Number(n) if n.is_i64() || n.is_u64() => "integer",
            Value::Number(_) => "number",
            _ => "string",
        }
    } else {
        match o.get("format").and_then(Value::as_str) {
            Some("int32" | "int64") => "integer",
            Some("float" | "double") => "number",
            _ => "string",
        }
    }
}

/// Keywords whose value is a single subschema (or, for `items`, one or a tuple).
const SCHEMA_KEYS: &[&str] = &[
    "items",
    "additionalProperties",
    "not",
    "if",
    "then",
    "else",
    "contains",
    "propertyNames",
];
/// Keywords whose value is an array of subschemas.
const SCHEMA_LIST_KEYS: &[&str] = &["anyOf", "oneOf", "allOf", "prefixItems"];
/// Keywords whose value is a map of name → subschema. The map itself is not a
/// schema; treating it as one would "fix" an empty `properties` into a string.
const SCHEMA_MAP_KEYS: &[&str] = &[
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
];

/// The keywords that only mean something for one `type`.
fn type_keywords(ty: &str) -> &'static [&'static str] {
    match ty {
        "object" => &[
            "properties",
            "required",
            "additionalProperties",
            "patternProperties",
        ],
        "array" => &["items", "prefixItems", "minItems", "maxItems"],
        "string" => &["format", "minLength", "maxLength", "pattern"],
        "integer" | "number" => &["format", "minimum", "maximum", "multipleOf"],
        _ => &[],
    }
}

/// Walk only the places a schema can sit; everything else (`enum`, `const`,
/// `default`, `examples`, `required`, …) is data and is left exactly as is.
fn sanitize(node: &Value) -> Value {
    let obj = match node {
        Value::Object(o) => o,
        Value::Array(items) => return Value::Array(items.iter().map(sanitize).collect()),
        other => return other.clone(),
    };

    let mut result: Map<String, Value> = obj
        .iter()
        .map(|(k, v)| {
            let key = k.as_str();
            let v = if SCHEMA_KEYS.contains(&key) {
                sanitize(v)
            } else if SCHEMA_LIST_KEYS.contains(&key) {
                v.as_array().map_or_else(
                    || v.clone(),
                    |a| Value::Array(a.iter().map(sanitize).collect()),
                )
            } else if SCHEMA_MAP_KEYS.contains(&key) {
                v.as_object().map_or_else(
                    || v.clone(),
                    |m| Value::Object(m.iter().map(|(n, s)| (n.clone(), sanitize(s))).collect()),
                )
            } else {
                v.clone()
            };
            (k.clone(), v)
        })
        .collect();

    // Gemini enums are string enums: stringify the members, and a `const` is a
    // one-member enum. The type follows, or the declaration is a 400.
    if let Some(Value::Array(members)) = result.get("enum").cloned() {
        result.insert(
            "enum".into(),
            Value::Array(members.iter().map(enum_member_to_string).collect()),
        );
    } else if let Some(c) = result.remove("const") {
        result.insert("enum".into(), Value::Array(vec![enum_member_to_string(&c)]));
    }
    if result.get("enum").is_some_and(Value::is_array)
        && matches!(
            result.get("type").and_then(Value::as_str),
            Some("integer" | "number" | "boolean")
        )
    {
        result.insert("type".into(), Value::String("string".into()));
    }

    // Gemini wants a single `type`. Split a type array into an `anyOf` of
    // single-type schemas and lift `null` into `nullable`. Each member takes
    // the keywords that belong to its type (an `array` member needs the
    // node's `items`) and is sanitized like any other schema — otherwise the
    // generated `{type: "array"}` has no `items`, which Gemini rejects.
    if let Some(Value::Array(types)) = result.get("type").cloned() {
        let has_null = types.iter().any(|t| t.as_str() == Some("null"));
        let non_null: Vec<String> = types
            .iter()
            .filter_map(|t| t.as_str())
            .filter(|t| *t != "null")
            .map(str::to_owned)
            .collect();
        if non_null.is_empty() {
            result.insert("type".into(), Value::String("null".into()));
        } else if result.contains_key("anyOf") {
            // An explicit `anyOf` already says what the node may be.
            result.remove("type");
            if has_null {
                result.insert("nullable".into(), Value::Bool(true));
            }
        } else {
            result.remove("type");
            let mut moved: Vec<&str> = Vec::new();
            let members: Vec<Value> = non_null
                .iter()
                .map(|t| {
                    let mut m = Map::new();
                    m.insert("type".into(), Value::String(t.clone()));
                    for key in type_keywords(t) {
                        if let Some(v) = result.get(*key) {
                            m.insert((*key).to_owned(), v.clone());
                            moved.push(key);
                        }
                    }
                    if t == "string" {
                        if let Some(e) = result.get("enum") {
                            m.insert("enum".into(), e.clone());
                            moved.push("enum");
                        }
                    }
                    sanitize(&Value::Object(m))
                })
                .collect();
            for key in moved {
                result.remove(key);
            }
            result.insert("anyOf".into(), Value::Array(members));
            if has_null {
                result.insert("nullable".into(), Value::Bool(true));
            }
        }
    }

    let combiner = has_combiner(&result);
    let type_str = result
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_owned);

    // A typeless node (not a combiner) gets the type its keywords imply.
    let type_str = match type_str {
        None if !combiner => {
            let t = infer_type(&result);
            result.insert("type".into(), Value::String(t.into()));
            Some(t.to_string())
        }
        other => other,
    };

    // `required` may only name declared properties.
    if type_str.as_deref() == Some("object") {
        if let (Some(Value::Object(props)), Some(Value::Array(required))) =
            (result.get("properties"), result.get("required"))
        {
            let kept: Vec<Value> = required
                .iter()
                .filter(|r| r.as_str().is_some_and(|s| props.contains_key(s)))
                .cloned()
                .collect();
            result.insert("required".into(), Value::Array(kept));
        }
    }

    // Arrays need `items`; an `items` that says nothing needs a type.
    if type_str.as_deref() == Some("array") && !combiner {
        let items = match result.remove("items") {
            None | Some(Value::Null) => Value::Object(Map::new()),
            Some(other) => other,
        };
        let items = match items {
            Value::Object(o) if !has_intent(&Value::Object(o.clone())) => {
                let mut o = o;
                o.insert("type".into(), Value::String("string".into()));
                Value::Object(o)
            }
            other => other,
        };
        result.insert("items".into(), items);
    }

    // Scalars carry no `properties` / `required`.
    if type_str.as_deref().is_some_and(|t| t != "object") && !combiner {
        result.remove("properties");
        result.remove("required");
    }

    Value::Object(result)
}

// ─── pass 2: convert ────────────────────────────────────────────────────────

fn truthy_str(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| v.as_str().is_none_or(|s| !s.is_empty()))
}

/// JS truthiness for `additionalProperties`.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(_) => true,
    }
}

/// An object schema that declares nothing.
fn is_empty_object(o: &Map<String, Value>) -> bool {
    o.get("type").and_then(Value::as_str) == Some("object")
        && o.get("properties")
            .and_then(Value::as_object)
            .is_none_or(Map::is_empty)
        && !truthy(o.get("additionalProperties"))
}

/// `format` values Gemini accepts, by type; anything else is a 400.
fn format_allowed(type_str: Option<&str>, format: &str) -> bool {
    match type_str {
        Some("string") => matches!(format, "enum" | "date-time"),
        Some("integer") => matches!(format, "int32" | "int64"),
        Some("number") => matches!(format, "float" | "double"),
        _ => false,
    }
}

fn to_openapi(node: &Value, is_root: bool) -> Option<Value> {
    if node.is_null() {
        return None;
    }
    if let Value::Bool(allowed) = node {
        // The JSON Schema boolean form: `true` is "anything", `false` "nothing".
        // The SDK emits `{type: boolean, properties: {}}` for both, which says
        // neither; "anything" is a string here (our fallback for an untyped
        // node) and a property that allows nothing is simply left out.
        return allowed.then(|| serde_json::json!({ "type": "string" }));
    }
    let o = node.as_object()?;

    if is_empty_object(o) {
        // Parameter-less at the root; a real (if opaque) object when nested.
        if is_root {
            return None;
        }
        let mut m = Map::new();
        m.insert("type".into(), Value::String("object".into()));
        if let Some(d) = truthy_str(o.get("description")) {
            m.insert("description".into(), d.clone());
        }
        if o.get("nullable") == Some(&Value::Bool(true)) {
            m.insert("nullable".into(), Value::Bool(true));
        }
        return Some(Value::Object(m));
    }

    let mut out = Map::new();
    if let Some(d) = truthy_str(o.get("description")) {
        out.insert("description".into(), d.clone());
    }
    if let Some(r) = o.get("required").filter(|r| !r.is_null()) {
        out.insert("required".into(), r.clone());
    }

    let type_str = o.get("type").and_then(Value::as_str);
    if let Some(Value::String(f)) = o.get("format") {
        if format_allowed(type_str, f) {
            out.insert("format".into(), Value::String(f.clone()));
        }
    }
    if let Some(c) = o.get("const") {
        out.insert("enum".into(), Value::Array(vec![c.clone()]));
    }
    if let Some(t) = type_str {
        out.insert("type".into(), Value::String(t.into()));
    }
    if let Some(e) = o.get("enum") {
        out.insert("enum".into(), e.clone());
    }
    if o.get("nullable") == Some(&Value::Bool(true)) {
        out.insert("nullable".into(), Value::Bool(true));
    }

    if let Some(Value::Object(props)) = o.get("properties") {
        let converted: Map<String, Value> = props
            .iter()
            .filter_map(|(k, v)| to_openapi(v, false).map(|c| (k.clone(), c)))
            .collect();
        out.insert("properties".into(), Value::Object(converted));
    }

    match o.get("items") {
        Some(Value::Array(items)) => {
            out.insert(
                "items".into(),
                Value::Array(items.iter().filter_map(|i| to_openapi(i, false)).collect()),
            );
        }
        Some(items) if !items.is_null() => {
            if let Some(c) = to_openapi(items, false) {
                out.insert("items".into(), c);
            }
        }
        _ => {}
    }

    if let Some(Value::Array(members)) = o.get("allOf") {
        out.insert("allOf".into(), convert_all(members));
    }
    if let Some(Value::Array(members)) = o.get("anyOf") {
        convert_any_of(&mut out, members);
    }
    if let Some(Value::Array(members)) = o.get("oneOf") {
        out.insert("oneOf".into(), convert_all(members));
    }
    if let Some(n) = o.get("minLength") {
        out.insert("minLength".into(), n.clone());
    }
    Some(Value::Object(out))
}

fn convert_all(members: &[Value]) -> Value {
    Value::Array(
        members
            .iter()
            .filter_map(|m| to_openapi(m, false))
            .collect(),
    )
}

fn is_null_schema(v: &Value) -> bool {
    v.as_object()
        .is_some_and(|o| o.get("type").and_then(Value::as_str) == Some("null"))
}

/// `anyOf` with a `null` member becomes `nullable`; a single remaining member
/// is merged into the node (the SDK's `Object.assign`), several stay in `anyOf`.
fn convert_any_of(out: &mut Map<String, Value>, members: &[Value]) {
    if !members.iter().any(is_null_schema) {
        out.insert("anyOf".into(), convert_all(members));
        return;
    }
    let non_null: Vec<&Value> = members.iter().filter(|m| !is_null_schema(m)).collect();
    if let [only] = non_null.as_slice() {
        if let Some(Value::Object(converted)) = to_openapi(only, false) {
            out.insert("nullable".into(), Value::Bool(true));
            out.extend(converted);
        }
    } else {
        let converted = non_null
            .iter()
            .filter_map(|m| to_openapi(m, false))
            .collect();
        out.insert("anyOf".into(), Value::Array(converted));
        out.insert("nullable".into(), Value::Bool(true));
    }
}

#[cfg(test)]
mod tests;
