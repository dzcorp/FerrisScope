// Parse the operator's filter string into a row predicate.
//
// Modes (auto-detected):
//   - empty                 → match everything (filter inactive)
//   - labels if the input contains `=`  (e.g. `app=nginx`, `tier=prod,app=web`)
//   - regex if the input contains any of `| * + ? ( ) ^ $ \ [ ] { }`
//   - bare text otherwise   → case-insensitive substring match on `name`
//
// `.` is deliberately NOT a regex trigger. K8s-adjacent names routinely
// contain dots (`nginx-1.27.0`, hostnames, image tags) and operators
// expect them to match literally; auto-promoting on a dot would silently
// turn `app.foo` into "app[anychar]foo" and surface the wrong rows. Once
// any other metachar is present we promote to regex and the dot reverts
// to its regex meaning — which is the operator's likely intent in a
// pattern like `app.*foo` anyway.
//
// `=` is checked BEFORE the regex triggers: it's an unambiguous sentinel
// for label mode. K8s label values can't contain `=` and DNS-1123 names
// can't either, so a string with `=` is always a label query, never a
// name pattern. Label mode reads `row.__labels` (injected by the watcher);
// the name modes read `row.name`. Comma-separated label terms with the same
// key are OR'd, distinct keys are AND'd, `!=` is an exclusion — see
// `parseLabelFilter` for the precise rule.
//
// Invalid input returns a never-matching predicate plus `invalid: true`
// so the AppHeader can render a red chip — empty results then read as
// "broken pattern" rather than "nothing matched the typo'd substring."

export type TableFilterMode = "off" | "substring" | "regex" | "labels";

/// Minimal shape the predicate needs from a resource row. `name` is the
/// resource name (name modes); `__labels` is the watcher-injected label map
/// (label mode). Both optional — a row missing the field simply won't match.
export type TableFilterRow = {
  name?: unknown;
  __labels?: Record<string, string>;
};

export type ParsedTableFilter = {
  mode: TableFilterMode;
  test: (row: TableFilterRow) => boolean;
  /// Set when the pattern failed to compile / parse (bad regex, empty key).
  invalid?: boolean;
};

const REGEX_TRIGGERS = /[|*+?()^$\\\[\]{}]/;

// A single `key[op]value` term in label mode. `op` distinguishes `=` from
// `!=`; an empty `value` means existence (`key=`) / absence (`key!=`).
type LabelTerm = {
  key: string;
  negate: boolean;
  // null → existence/absence check; otherwise a value matcher.
  match: ((value: string) => boolean) | null;
};

function rowName(row: TableFilterRow): string {
  return typeof row.name === "string" ? row.name : "";
}

// Build a value matcher: regex (case-insensitive) when the value carries
// metachars, exact (case-sensitive, kubectl `=` semantics) otherwise.
// Returns null on a regex that fails to compile.
function valueMatcher(value: string): ((v: string) => boolean) | null {
  if (REGEX_TRIGGERS.test(value)) {
    try {
      const re = new RegExp(value, "i");
      return (v) => re.test(v);
    } catch {
      return null;
    }
  }
  return (v) => v === value;
}

function parseLabelFilter(raw: string): ParsedTableFilter {
  const invalid: ParsedTableFilter = {
    mode: "labels",
    test: () => false,
    invalid: true,
  };

  const terms: LabelTerm[] = [];
  for (const rawTerm of raw.split(",")) {
    const term = rawTerm.trim();
    if (!term) continue; // tolerate trailing / doubled commas

    const negate = term.includes("!=");
    const sep = negate ? "!=" : "=";
    const idx = term.indexOf(sep);
    if (idx < 0) return invalid; // term has no operator — e.g. a comma landed
    // inside a regex quantifier (`app=a{1,3}`); comma separates terms, so
    // that's unsupported. Fail honestly (red) rather than silently match nothing.
    const key = term.slice(0, idx).trim();
    const value = term.slice(idx + sep.length).trim();

    if (!key) return invalid; // `=x` / `!=x` — no key to match

    if (value === "") {
      terms.push({ key, negate, match: null }); // existence / absence
      continue;
    }
    const match = valueMatcher(value);
    if (!match) return invalid; // bad regex value
    terms.push({ key, negate, match });
  }

  if (terms.length === 0) return invalid; // bare `=` with nothing around it

  // Semantics: positive (`=`) terms that share a key are OR'd together; the
  // resulting per-key groups are AND'd across distinct keys; every negative
  // (`!=`) term is an AND'd exclusion. So `app=a,app=b` → app∈{a,b};
  // `app=a,tier=b` → app=a AND tier=b. OR within one term still works via a
  // regex value (`app=a|b`). Groups are precomputed here, not per-row — the
  // predicate runs once per visible row on a hot path.
  const posGroups: { key: string; terms: LabelTerm[] }[] = [];
  const byKey = new Map<string, LabelTerm[]>();
  const negatives: LabelTerm[] = [];
  for (const t of terms) {
    if (t.negate) {
      negatives.push(t);
      continue;
    }
    let group = byKey.get(t.key);
    if (!group) {
      group = [];
      byKey.set(t.key, group);
      posGroups.push({ key: t.key, terms: group });
    }
    group.push(t);
  }

  // hasOwnProperty, NOT `labels[key]`: a bare index read inherits object
  // prototype members, so `toString` / `constructor` would report a label
  // that isn't there. Returns the own value, or undefined when absent.
  const ownValue = (
    labels: Record<string, string> | undefined,
    key: string,
  ): string | undefined =>
    labels != null && Object.prototype.hasOwnProperty.call(labels, key)
      ? labels[key]
      : undefined;

  return {
    mode: "labels",
    test: (row) => {
      const labels = row.__labels;
      // Every positive key-group must have at least one matching term (OR).
      for (const group of posGroups) {
        const value = ownValue(labels, group.key);
        const ok = group.terms.some((t) =>
          // match === null → existence (`key=`): presence alone satisfies.
          t.match === null ? value !== undefined : value !== undefined && t.match(value),
        );
        if (!ok) return false;
      }
      // Every negative term must hold (AND). `key!=value` is satisfied when the
      // label is absent OR its value differs; `key!=` requires absence.
      for (const t of negatives) {
        const value = ownValue(labels, t.key);
        if (t.match === null) {
          if (value !== undefined) return false; // absence required, but present
        } else if (value !== undefined && t.match(value)) {
          return false; // present and matches the excluded value
        }
      }
      return true;
    },
  };
}

export function parseTableFilter(raw: string): ParsedTableFilter {
  const trimmed = raw.trim();
  if (!trimmed) return { mode: "off", test: () => true };

  if (trimmed.includes("=")) return parseLabelFilter(trimmed);

  if (REGEX_TRIGGERS.test(trimmed)) {
    try {
      const re = new RegExp(trimmed, "i");
      return { mode: "regex", test: (row) => re.test(rowName(row)) };
    } catch {
      return { mode: "regex", test: () => false, invalid: true };
    }
  }

  const lc = trimmed.toLowerCase();
  return {
    mode: "substring",
    test: (row) => rowName(row).toLowerCase().includes(lc),
  };
}
