// Natural ("item2" < "item10") ordering as a precomputed string key, so a
// sort compares keys with `<` instead of re-parsing both strings on every
// comparison. Orders exactly like TanStack's `sortFn_alphanumeric` on the
// lowercased value:
//   text chunk    → \u0001 + text + \u0000   (text sorts before numbers;
//                                             \u0000 ends the chunk so a
//                                             shorter chunk sorts first)
//   numeric chunk → \u0002 + char(0x100 + significant length) + digits
//                                            (leading zeros dropped; longer
//                                             means larger, then digit order)
function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

export function naturalSortKey(value: string): string {
  const s = value.toLowerCase();
  let out = "";
  let i = 0;
  while (i < s.length) {
    const numeric = isDigit(s.charCodeAt(i));
    let end = i + 1;
    while (end < s.length && isDigit(s.charCodeAt(end)) === numeric) end++;
    if (numeric) {
      let start = i;
      while (start < end && s.charCodeAt(start) === 48) start++;
      out += "\u0002" + String.fromCharCode(0x100 + end - start) + s.slice(start, end);
    } else {
      out += "\u0001" + s.slice(i, end) + "\u0000";
    }
    i = end;
  }
  return out;
}

/// Comparator over objects whose sort text comes from `read`. Keys are cached
/// per object (rows are replaced, never mutated, when they change), so a
/// re-sort after a small update only encodes the changed rows.
export function naturalComparator<T extends object>(
  read: (item: T) => string,
): (a: T, b: T) => number {
  const keys = new WeakMap<T, string>();
  const keyOf = (item: T): string => {
    let key = keys.get(item);
    if (key === undefined) {
      key = naturalSortKey(read(item));
      keys.set(item, key);
    }
    return key;
  };
  return (a, b) => {
    const x = keyOf(a);
    const y = keyOf(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
}
