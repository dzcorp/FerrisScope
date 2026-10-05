use super::*;
use pretty_assertions::assert_eq;
use serde_json::json;

// ─── the Gemini contract ────────────────────────────────────────────────────
//
// What Gemini's function-declaration validator enforces, as far as we know it
// (each rule is a 400 that fails the whole request). The corpus below is run
// through `convert` and held to it, so a conversion change that reintroduces a
// rejected shape fails here instead of in a user's chat.

const ALLOWED_KEYS: &[&str] = &[
    "description",
    "required",
    "format",
    "type",
    "nullable",
    "enum",
    "properties",
    "items",
    "allOf",
    "anyOf",
    "oneOf",
    "minLength",
];
const TYPES: &[&str] = &[
    "string", "number", "integer", "boolean", "array", "object", "null",
];

fn assert_valid(node: &Value, path: &str) {
    let o = node
        .as_object()
        .unwrap_or_else(|| panic!("{path}: schema node is not an object: {node}"));
    for k in o.keys() {
        assert!(
            ALLOWED_KEYS.contains(&k.as_str()),
            "{path}: unsupported key `{k}`"
        );
    }
    let combiner = ["anyOf", "oneOf", "allOf"]
        .iter()
        .any(|k| o.contains_key(*k));
    let ty = o.get("type").and_then(Value::as_str);
    assert!(
        ty.is_some() || combiner,
        "{path}: schema didn't specify the schema type field: {node}"
    );
    if let Some(t) = ty {
        assert!(TYPES.contains(&t), "{path}: bad type `{t}`");
    }
    if ty == Some("array") {
        let items = o
            .get("items")
            .unwrap_or_else(|| panic!("{path}.items: missing field: {node}"));
        match items {
            Value::Array(tuple) => {
                for (i, t) in tuple.iter().enumerate() {
                    assert_valid(t, &format!("{path}.items[{i}]"));
                }
            }
            single => assert_valid(single, &format!("{path}.items")),
        }
    }
    if let Some(Value::Object(props)) = o.get("properties") {
        for (k, v) in props {
            assert_valid(v, &format!("{path}.properties[{k}]"));
        }
        if let Some(Value::Array(req)) = o.get("required") {
            for r in req {
                assert!(
                    props.contains_key(r.as_str().unwrap_or("")),
                    "{path}: required `{r}` has no property"
                );
            }
        }
    }
    if let Some(Value::Array(e)) = o.get("enum") {
        assert_eq!(ty, Some("string"), "{path}: enum only on string");
        assert!(
            e.iter().all(Value::is_string),
            "{path}: enum members must be strings"
        );
    }
    if let Some(Value::String(f)) = o.get("format") {
        assert!(
            format_allowed(ty, f),
            "{path}: format `{f}` not accepted for {ty:?}"
        );
    }
    if ty.is_some_and(|t| t != "object") && !combiner {
        assert!(
            !o.contains_key("properties") && !o.contains_key("required"),
            "{path}: scalar with properties/required"
        );
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(Value::Array(members)) = o.get(key) {
            for (i, m) in members.iter().enumerate() {
                assert_valid(m, &format!("{path}.{key}[{i}]"));
            }
        }
    }
}

fn converted(schema: &Value) -> Value {
    let out = convert(schema).unwrap_or_else(|| panic!("expected parameters for {schema}"));
    assert_eq!(out["type"], "object", "root must be an object: {out}");
    assert_valid(&out, "parameters");
    out
}

// ─── the reported failure ───────────────────────────────────────────────────

#[test]
fn array_of_generic_objects_keeps_its_items() {
    // `function_declarations[5].parameters.properties[queries].items: missing
    // field` — an array of free-form objects, as MCP servers emit them.
    let out = converted(&json!({
        "type": "object",
        "properties": { "queries": { "type": "array", "items": { "type": "object" } } },
        "required": ["queries"]
    }));
    assert_eq!(
        out["properties"]["queries"],
        json!({ "type": "array", "items": { "type": "object" } })
    );
}

#[test]
fn regression_type_array_with_array_member_gets_items() {
    // `fs_resources_apply`: `patch: { type: ["object", "array"] }` →
    // `function_declarations[148].parameters.properties[patch].any_of[1].items:
    // missing field`.
    let out = converted(&json!({
        "type": "object",
        "properties": {
            "patch": { "description": "merge_patch → object; json_patch → array", "type": ["object", "array"] }
        }
    }));
    assert_eq!(
        out["properties"]["patch"],
        json!({
            "description": "merge_patch → object; json_patch → array",
            "anyOf": [{ "type": "object" }, { "type": "array", "items": { "type": "string" } }]
        })
    );
}

#[test]
fn split_type_members_take_the_keywords_that_belong_to_them() {
    let out = converted(&json!({
        "type": "object",
        "properties": {
            "v": {
                "type": ["array", "object", "null"],
                "items": { "type": "integer" },
                "properties": { "a": { "type": "string" } },
                "required": ["a"]
            },
            "s": { "type": ["string", "null"], "format": "date-time", "enum": ["x"] }
        }
    }));
    assert_eq!(
        out["properties"]["v"],
        json!({
            "nullable": true,
            "anyOf": [
                { "type": "array", "items": { "type": "integer" } },
                { "type": "object", "properties": { "a": { "type": "string" } }, "required": ["a"] }
            ]
        })
    );
    assert_eq!(
        out["properties"]["s"],
        json!({ "nullable": true, "anyOf": [{ "type": "string", "format": "date-time", "enum": ["x"] }] })
    );
}

#[test]
fn a_type_array_beside_an_explicit_any_of_defers_to_the_any_of() {
    let out = converted(&json!({
        "type": "object",
        "properties": {
            "x": { "type": ["string", "null"], "anyOf": [{ "type": "string" }, { "type": "integer" }] }
        }
    }));
    assert_eq!(
        out["properties"]["x"],
        json!({ "nullable": true, "anyOf": [{ "type": "string" }, { "type": "integer" }] })
    );
}

#[test]
fn generic_object_items_variants_all_survive() {
    for items in [
        json!({ "type": "object" }),
        json!({ "type": "object", "additionalProperties": true }),
        json!({ "type": "object", "additionalProperties": { "type": "string" } }),
        json!({ "type": "object", "properties": {} }),
        json!({ "type": "object", "description": "one query" }),
    ] {
        let out = converted(&json!({
            "type": "object",
            "properties": { "queries": { "type": "array", "items": items } }
        }));
        assert_eq!(
            out["properties"]["queries"]["items"]["type"], "object",
            "{items}"
        );
    }
}

#[test]
fn a_nullable_empty_object_stays_nullable() {
    let out = converted(&json!({
        "type": "object",
        "properties": { "opts": { "anyOf": [{ "type": "object" }, { "type": "null" }] } }
    }));
    assert_eq!(
        out["properties"]["opts"],
        json!({ "nullable": true, "type": "object" })
    );
}

#[test]
fn a_nested_empty_object_keeps_its_description_and_stays_a_property() {
    let out = converted(&json!({
        "type": "object",
        "properties": {
            "options": { "type": "object", "description": "free-form options" },
            "name": { "type": "string" }
        }
    }));
    assert_eq!(
        out["properties"]["options"],
        json!({ "type": "object", "description": "free-form options" })
    );
}

// ─── root ───────────────────────────────────────────────────────────────────

#[test]
fn parameterless_tools_have_no_parameters() {
    for schema in [
        json!({ "type": "object", "properties": {} }),
        json!({ "type": "object" }),
        json!({}),
        json!({ "description": "no params" }),
        json!(null),
        json!("nope"),
    ] {
        assert_eq!(convert(&schema), None, "{schema}");
    }
}

#[test]
fn a_free_form_root_object_is_not_parameter_less() {
    assert!(convert(&json!({ "type": "object", "additionalProperties": true })).is_some());
}

#[test]
fn a_typeless_root_with_properties_is_an_object() {
    let out = converted(&json!({ "properties": { "a": { "type": "string" } } }));
    assert_eq!(out["properties"]["a"]["type"], "string");
}

// ─── ported behaviour (opencode sanitize + ai-sdk convert) ──────────────────

#[test]
fn integer_enum_becomes_string_enum_with_string_type() {
    let out = converted(&json!({
        "type": "object",
        "properties": { "level": { "type": "integer", "enum": [1, 2, 3] } }
    }));
    assert_eq!(
        out["properties"]["level"],
        json!({ "type": "string", "enum": ["1", "2", "3"] })
    );
}

#[test]
fn enum_members_stringify_like_js() {
    let out = converted(&json!({
        "type": "object",
        "properties": { "e": { "type": "string", "enum": [true, 1.5, null, "x"] } }
    }));
    assert_eq!(
        out["properties"]["e"]["enum"],
        json!(["true", "1.5", "null", "x"])
    );
}

#[test]
fn required_is_cut_down_to_declared_properties() {
    let out = converted(&json!({
        "type": "object",
        "properties": { "a": { "type": "string" } },
        "required": ["a", "ghost"]
    }));
    assert_eq!(out["required"], json!(["a"]));
}

#[test]
fn untyped_array_gets_string_items() {
    let out = converted(&json!({
        "type": "object",
        "properties": {
            "tags": { "type": "array" },
            "empty": { "type": "array", "items": {} },
            "nul": { "type": "array", "items": null }
        }
    }));
    for k in ["tags", "empty", "nul"] {
        assert_eq!(
            out["properties"][k],
            json!({ "type": "array", "items": { "type": "string" } }),
            "{k}"
        );
    }
}

#[test]
fn typed_array_items_are_kept() {
    let out = converted(&json!({
        "type": "object",
        "properties": { "ns": { "type": "array", "items": { "type": "integer" } } }
    }));
    assert_eq!(
        out["properties"]["ns"]["items"],
        json!({ "type": "integer" })
    );
}

#[test]
fn scalars_lose_properties_and_required() {
    let out = converted(&json!({
        "type": "object",
        "properties": {
            "s": { "type": "string", "properties": { "x": {} }, "required": ["x"] }
        }
    }));
    assert_eq!(out["properties"]["s"], json!({ "type": "string" }));
}

#[test]
fn unsupported_keywords_are_dropped() {
    let out = converted(&json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "T",
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "name": { "type": "string", "pattern": "^a", "default": "x", "description": "d",
                      "minLength": 1, "maxLength": 9, "title": "Name" }
        },
        "required": ["name"]
    }));
    for k in ["$schema", "title", "additionalProperties"] {
        assert!(out.get(k).is_none(), "{k}");
    }
    assert_eq!(
        out["properties"]["name"],
        json!({ "description": "d", "type": "string", "minLength": 1 })
    );
}

#[test]
fn empty_description_is_not_forwarded() {
    let out = converted(&json!({
        "type": "object",
        "properties": { "a": { "type": "string", "description": "" } }
    }));
    assert!(out["properties"]["a"].get("description").is_none());
}

#[test]
fn type_arrays_become_any_of_with_nullable_lifted() {
    let out = converted(&json!({
        "type": "object",
        "properties": {
            "n": { "type": ["number", "null"] },
            "u": { "type": ["number", "string"] },
            "only_null": { "type": ["null"] }
        }
    }));
    // One non-null type + null: the branch collapses into the node itself.
    assert_eq!(out["properties"]["n"]["nullable"], true);
    assert_eq!(
        out["properties"]["n"]["anyOf"],
        json!([{ "type": "number" }])
    );
    assert_eq!(
        out["properties"]["u"]["anyOf"],
        json!([{ "type": "number" }, { "type": "string" }])
    );
    assert_eq!(out["properties"]["only_null"]["type"], "null");
}

#[test]
fn any_of_with_a_null_member_merges_the_single_other_branch() {
    let out = converted(&json!({
        "type": "object",
        "properties": {
            "maybe": { "anyOf": [{ "type": "string", "description": "s" }, { "type": "null" }] },
            "multi": { "anyOf": [{ "type": "string" }, { "type": "integer" }, { "type": "null" }] },
            "plain": { "anyOf": [{ "type": "string" }, { "type": "integer" }] }
        }
    }));
    assert_eq!(
        out["properties"]["maybe"],
        json!({ "nullable": true, "type": "string", "description": "s" })
    );
    assert_eq!(
        out["properties"]["multi"],
        json!({ "nullable": true, "anyOf": [{ "type": "string" }, { "type": "integer" }] })
    );
    assert_eq!(
        out["properties"]["plain"],
        json!({ "anyOf": [{ "type": "string" }, { "type": "integer" }] })
    );
}

#[test]
fn combiners_are_converted_recursively() {
    let out = converted(&json!({
        "type": "object",
        "properties": {
            "v": { "oneOf": [{ "type": "string" }, { "type": "integer", "enum": [1] }] },
            "w": { "allOf": [{ "type": "object", "properties": { "a": { "type": "string" } } }] }
        }
    }));
    assert_eq!(
        out["properties"]["v"]["oneOf"],
        json!([{ "type": "string" }, { "type": "string", "enum": ["1"] }])
    );
    assert_eq!(
        out["properties"]["w"]["allOf"][0]["properties"]["a"]["type"],
        "string"
    );
}

#[test]
fn nested_objects_recurse() {
    let out = converted(&json!({
        "type": "object",
        "properties": {
            "spec": {
                "type": "object",
                "properties": { "n": { "type": "integer", "enum": [1] } },
                "required": ["n", "ghost"]
            }
        }
    }));
    assert_eq!(out["properties"]["spec"]["required"], json!(["n"]));
    assert_eq!(
        out["properties"]["spec"]["properties"]["n"]["type"],
        "string"
    );
}

#[test]
fn tuple_items_are_each_converted() {
    let out = converted(&json!({
        "type": "object",
        "properties": { "pair": { "type": "array", "items": [{ "type": "string" }, { "type": "integer" }] } }
    }));
    assert_eq!(
        out["properties"]["pair"]["items"],
        json!([{ "type": "string" }, { "type": "integer" }])
    );
}

// ─── defensive additions ────────────────────────────────────────────────────

#[test]
fn formats_gemini_rejects_are_dropped_and_supported_ones_kept() {
    let out = converted(&json!({
        "type": "object",
        "properties": {
            "url": { "type": "string", "format": "uri" },
            "id": { "type": "string", "format": "uuid" },
            "mail": { "type": "string", "format": "email" },
            "when": { "type": "string", "format": "date-time" },
            "n32": { "type": "integer", "format": "int32" },
            "n64": { "type": "integer", "format": "int64" },
            "f": { "type": "number", "format": "double" },
            "bad_int": { "type": "integer", "format": "uint32" },
            "bad_num": { "type": "number", "format": "decimal" }
        }
    }));
    let p = &out["properties"];
    for k in ["url", "id", "mail", "bad_int", "bad_num"] {
        assert!(p[k].get("format").is_none(), "{k}");
    }
    assert_eq!(p["when"]["format"], "date-time");
    assert_eq!(p["n32"]["format"], "int32");
    assert_eq!(p["n64"]["format"], "int64");
    assert_eq!(p["f"]["format"], "double");
}

#[test]
fn typeless_nodes_get_the_type_their_keywords_imply() {
    let out = converted(&json!({
        "type": "object",
        "properties": {
            "any": {},
            "described": { "description": "whatever" },
            "obj": { "properties": { "a": { "type": "integer" } } },
            "list": { "items": { "type": "string" } },
            "limit": { "minimum": 1 },
            "mode": { "enum": ["a", "b"] },
            "big": { "format": "int64" }
        }
    }));
    let p = &out["properties"];
    for (k, ty) in [
        ("any", "string"),
        ("described", "string"),
        ("obj", "object"),
        ("list", "array"),
        ("limit", "number"),
        ("mode", "string"),
        ("big", "integer"),
    ] {
        assert_eq!(p[k]["type"], ty, "{k}: {}", p[k]);
    }
    assert_eq!(p["described"]["description"], "whatever");
}

#[test]
fn local_refs_are_inlined_from_defs_and_definitions() {
    let out = converted(&json!({
        "type": "object",
        "$defs": { "Query": { "type": "object", "properties": { "expr": { "type": "string" } },
                              "required": ["expr"] } },
        "definitions": { "Level": { "type": "string", "enum": ["a", "b"] } },
        "properties": {
            "queries": { "type": "array", "items": { "$ref": "#/$defs/Query" } },
            "level": { "$ref": "#/definitions/Level", "description": "how loud" }
        }
    }));
    assert_eq!(
        out["properties"]["queries"]["items"],
        json!({ "type": "object", "properties": { "expr": { "type": "string" } }, "required": ["expr"] })
    );
    assert_eq!(
        out["properties"]["level"],
        json!({ "description": "how loud", "type": "string", "enum": ["a", "b"] })
    );
    assert!(out.get("$defs").is_none() && out.get("definitions").is_none());
}

#[test]
fn unresolvable_and_recursive_refs_collapse_to_a_generic_object() {
    let out = converted(&json!({
        "type": "object",
        "$defs": { "Node": { "type": "object", "properties": {
            "value": { "type": "string" },
            "children": { "type": "array", "items": { "$ref": "#/$defs/Node" } } } } },
        "properties": {
            "tree": { "$ref": "#/$defs/Node" },
            "remote": { "$ref": "https://example.com/schema.json" }
        }
    }));
    assert_eq!(out["properties"]["remote"], json!({ "type": "object" }));
    // The recursion is cut after one expansion instead of looping.
    assert_eq!(
        out["properties"]["tree"]["properties"]["children"]["items"],
        json!({ "type": "object" })
    );
}

// ─── corpus held to the contract ────────────────────────────────────────────

fn corpus() -> Vec<(&'static str, Value)> {
    vec![
        (
            "pydantic batch tool",
            json!({
                "type": "object",
                "$defs": { "Q": { "type": "object", "properties": {
                    "expr": { "type": "string", "format": "uri" },
                    "step": { "anyOf": [{ "type": "integer" }, { "type": "null" }], "default": null } } } },
                "properties": { "queries": { "type": "array", "items": { "$ref": "#/$defs/Q" } },
                                "limit": { "anyOf": [{ "type": "integer" }, { "type": "null" }] } },
                "required": ["queries"]
            }),
        ),
        (
            "zod search tool",
            json!({
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "project_id": { "type": ["string", "number"], "description": "id or path" },
                    "ids": { "type": "array", "items": { "type": "string", "format": "uuid" } },
                    "since": { "type": "string", "format": "date-time" },
                    "labels": { "type": "object", "additionalProperties": { "type": "string" } },
                    "state": { "type": "string", "enum": ["opened", "closed"] },
                    "page": { "type": "integer", "minimum": 1, "default": 1 }
                },
                "required": ["project_id"]
            }),
        ),
        (
            "arrays everywhere",
            json!({
                "type": "object",
                "properties": {
                    "a": { "type": "array" },
                    "b": { "type": "array", "items": {} },
                    "c": { "type": "array", "items": { "type": "array" } },
                    "d": { "type": "array", "items": { "type": "object" } },
                    "e": { "type": "array", "items": { "type": ["string", "null"] } },
                    "f": { "type": "array", "items": { "anyOf": [{ "type": "string" }, { "type": "object" }] } },
                    "g": { "items": { "type": "object" } }
                }
            }),
        ),
        (
            "opaque params",
            json!({
                "type": "object",
                "properties": { "payload": {}, "meta": { "type": "object" }, "x": true, "y": { "description": "d" } },
                "required": ["payload", "ghost"]
            }),
        ),
        (
            "enum soup",
            json!({
                "type": "object",
                "properties": {
                    "n": { "type": "number", "enum": [0.5, 1] },
                    "m": { "enum": [1, 2] },
                    "b": { "type": "boolean", "enum": [true] },
                    "mix": { "enum": ["a", 1, null] }
                }
            }),
        ),
        (
            "deep nesting",
            json!({
                "type": "object",
                "properties": { "a": { "type": "object", "properties": { "b": { "type": "object",
                    "properties": { "c": { "type": "array", "items": { "type": "object",
                        "properties": { "d": { "type": "array" } } } } } } } } }
            }),
        ),
        (
            "combiners",
            json!({
                "type": "object",
                "properties": {
                    "u": { "oneOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" } }] },
                    "v": { "anyOf": [{ "type": "object" }, { "type": "null" }] },
                    "w": { "allOf": [{ "properties": { "z": { "type": "string" } } }] }
                }
            }),
        ),
    ]
}

#[test]
fn every_corpus_schema_converts_to_a_valid_gemini_declaration() {
    for (name, schema) in corpus() {
        let out = std::panic::catch_unwind(|| converted(&schema));
        assert!(
            out.is_ok(),
            "corpus case `{name}` produced a schema Gemini would reject"
        );
    }
}

#[test]
fn conversion_is_idempotent_enough_to_survive_a_second_pass() {
    // The output is itself a legal input: re-converting must not break it.
    for (name, schema) in corpus() {
        let once = converted(&schema);
        let twice = converted(&once);
        assert_eq!(once, twice, "{name}");
    }
}

// ─── fuzz: no input shape may yield a declaration Gemini would reject ───────

/// xorshift64*: deterministic, so a failing case reproduces from its seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len())]
    }
}

const TYPE_NAMES: &[&str] = &[
    "string", "number", "integer", "boolean", "array", "object", "null",
];
const FORMATS: &[&str] = &[
    "uri",
    "uuid",
    "date-time",
    "email",
    "int32",
    "int64",
    "float",
    "double",
    "enum",
    "weird",
];
const PROP_NAMES: &[&str] = &["a", "b", "queries", "patch", "items", "type", "$ref", "x-y"];

fn random_schema(rng: &mut Rng, depth: usize) -> Value {
    if depth == 0 || rng.chance(15) {
        return match rng.below(6) {
            0 => json!({}),
            1 => json!(true),
            2 => json!(false),
            3 => json!({ "type": *rng.pick(TYPE_NAMES) }),
            4 => json!({ "description": "d" }),
            _ => json!({ "$ref": "#/$defs/D" }),
        };
    }
    let mut o = Map::new();
    match rng.below(4) {
        0 => {}
        1 => {
            o.insert("type".into(), json!(*rng.pick(TYPE_NAMES)));
        }
        _ => {
            let n = 1 + rng.below(3);
            let types: Vec<&str> = (0..n).map(|_| *rng.pick(TYPE_NAMES)).collect();
            o.insert("type".into(), json!(types));
        }
    }
    if rng.chance(40) {
        let mut props = Map::new();
        for _ in 0..rng.below(4) {
            props.insert(
                (*rng.pick(PROP_NAMES)).into(),
                random_schema(rng, depth - 1),
            );
        }
        o.insert("properties".into(), Value::Object(props));
    }
    if rng.chance(30) {
        let req: Vec<&str> = (0..rng.below(3)).map(|_| *rng.pick(PROP_NAMES)).collect();
        o.insert("required".into(), json!(req));
    }
    if rng.chance(40) {
        let items = match rng.below(5) {
            0 => Value::Null,
            1 => json!([random_schema(rng, depth - 1), random_schema(rng, depth - 1)]),
            _ => random_schema(rng, depth - 1),
        };
        o.insert("items".into(), items);
    }
    if rng.chance(20) {
        let vals = [json!(1), json!("s"), json!(true), json!(null), json!(2.5)];
        let members: Vec<Value> = (0..1 + rng.below(3))
            .map(|_| rng.pick(&vals).clone())
            .collect();
        o.insert("enum".into(), json!(members));
    }
    if rng.chance(8) {
        o.insert("const".into(), json!(rng.below(3)));
    }
    if rng.chance(25) {
        o.insert("format".into(), json!(*rng.pick(FORMATS)));
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        if rng.chance(12) {
            let members: Vec<Value> = (0..rng.below(4))
                .map(|_| random_schema(rng, depth - 1))
                .collect();
            o.insert(key.into(), json!(members));
        }
    }
    if rng.chance(20) {
        let ap = match rng.below(3) {
            0 => json!(true),
            1 => json!(false),
            _ => random_schema(rng, depth - 1),
        };
        o.insert("additionalProperties".into(), ap);
    }
    if rng.chance(15) {
        o.insert("default".into(), json!({ "k": [] }));
    }
    if rng.chance(15) {
        o.insert("nullable".into(), json!(true));
    }
    if rng.chance(30) {
        o.insert(
            "description".into(),
            json!(if rng.chance(50) { "" } else { "text" }),
        );
    }
    Value::Object(o)
}

#[test]
fn no_random_schema_produces_a_declaration_gemini_would_reject() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut produced = 0;
    for case in 0..10_000 {
        let mut root = random_schema(&mut rng, 4);
        if let Some(o) = root.as_object_mut() {
            o.insert("type".into(), json!("object"));
            o.insert("$defs".into(), json!({ "D": random_schema(&mut rng, 2) }));
        }
        let Some(out) = convert(&root) else { continue };
        produced += 1;
        let checked = std::panic::catch_unwind(|| {
            assert_eq!(out["type"], "object");
            assert_valid(&out, "parameters");
        });
        assert!(
            checked.is_ok(),
            "case {case} produced an invalid declaration\ninput:  {root}\noutput: {out}"
        );
    }
    assert!(
        produced > 2_000,
        "the generator should exercise real schemas ({produced})"
    );
}
