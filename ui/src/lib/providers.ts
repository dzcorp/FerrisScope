import type { ProviderKind } from "../types";

// Display order for the AI provider list, shared by Settings → AI
// (`AiSection`) and the chat-header provider switcher
// (`ProviderPickerPopover`) so the two surfaces render identically and
// muscle memory carries between them. Mirrors Rust's `ProviderKind::all()`.
// OpenCode Zen leads — it's the default for fresh installs and works
// without a key (free tier), so a brand-new user can chat immediately.
//
// `satisfies Record<ProviderKind, number>` makes this exhaustive at compile
// time: adding a `ProviderKind` without listing it here is a type error, and
// listing an unknown key is too. Add new providers to this one map.
const ORDER_INDEX = {
  opencode_zen: 0,
  openai: 1,
  anthropic: 2,
  open_router: 3,
  zai: 4,
  minimax: 5,
  groq: 6,
  deepseek: 7,
  moonshot: 8,
  kimi_coding: 9,
  mistral: 10,
  together: 11,
  ollama: 12,
  custom_openai: 13,
  custom_anthropic: 14,
} satisfies Record<ProviderKind, number>;

export const PROVIDER_ORDER: readonly ProviderKind[] = (
  Object.keys(ORDER_INDEX) as ProviderKind[]
).sort((a, b) => ORDER_INDEX[a] - ORDER_INDEX[b]);
