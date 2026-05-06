// Parse the operator's filter string into a row predicate.
//
// Modes (auto-detected):
//   - empty                 → match everything (filter inactive)
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
// Invalid regex returns a never-matching predicate plus `invalid: true`
// so the AppHeader can render a red chip — empty results then read as
// "broken pattern" rather than "nothing matched the typo'd substring."

export type TableFilterMode = "off" | "substring" | "regex";

export type ParsedTableFilter = {
  mode: TableFilterMode;
  test: (name: string) => boolean;
  /// Set when `mode === "regex"` and the pattern failed to compile.
  invalid?: boolean;
};

const REGEX_TRIGGERS = /[|*+?()^$\\\[\]{}]/;

export function parseTableFilter(raw: string): ParsedTableFilter {
  const trimmed = raw.trim();
  if (!trimmed) return { mode: "off", test: () => true };

  if (REGEX_TRIGGERS.test(trimmed)) {
    try {
      const re = new RegExp(trimmed, "i");
      return { mode: "regex", test: (name) => re.test(name) };
    } catch {
      return { mode: "regex", test: () => false, invalid: true };
    }
  }

  const lc = trimmed.toLowerCase();
  return {
    mode: "substring",
    test: (name) => name.toLowerCase().includes(lc),
  };
}
