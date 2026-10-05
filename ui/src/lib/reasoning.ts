import type { BudgetRange, ReasoningSpec } from "../types";

// Presentation helpers for the reasoning controls. The lists themselves
// (which effort names a provider offers, whether it takes a budget) come from
// the backend; this only turns them into labelled options.

/// Select value for "leave it to the API".
export const AUTO = "auto";

export type Option = { value: string; label: string };

const EFFORT_LABELS: Record<string, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/// `xhigh` → "Extra high", `none` → "Off"; names we don't know are capitalised.
export function effortLabel(name: string): string {
  return (
    EFFORT_LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1)
  );
}

/// 1024 → "1k", 16384 → "16k", 65536 → "64k"; anything that isn't a whole
/// number of KiB is shown exactly.
export function budgetLabel(tokens: number): string {
  return tokens >= 1024 && tokens % 1024 === 0
    ? `${tokens / 1024}k`
    : tokens.toLocaleString("en-US");
}

/// Auto + the provider's own levels. A saved level the current list lacks
/// (the model changed) stays selectable, marked, so the choice isn't silently
/// rewritten by opening the page.
export function effortOptions(
  spec: Pick<ReasoningSpec, "efforts">,
  saved: string | null | undefined,
): Option[] {
  const options: Option[] = [
    { value: AUTO, label: "Auto — let the API decide" },
    ...spec.efforts.map((e) => ({ value: e, label: effortLabel(e) })),
  ];
  if (saved && !spec.efforts.includes(saved)) {
    options.push({
      value: saved,
      label: `${effortLabel(saved)} (not offered here)`,
    });
  }
  return options;
}

/// Default + the presets inside the model's range, plus a saved value outside
/// them.
export function budgetOptions(
  range: Pick<BudgetRange, "presets">,
  saved: number | null | undefined,
): Option[] {
  const options: Option[] = [
    { value: "default", label: "Default" },
    ...range.presets.map((n) => ({
      value: String(n),
      label: `${budgetLabel(n)} tokens`,
    })),
  ];
  if (saved && !range.presets.includes(saved)) {
    options.push({ value: String(saved), label: `${budgetLabel(saved)} tokens` });
  }
  return options;
}

/// A reasoning spec with nothing to choose.
export function specIsEmpty(spec: ReasoningSpec): boolean {
  return spec.efforts.length === 0 && spec.budget === null && !spec.toggle;
}
