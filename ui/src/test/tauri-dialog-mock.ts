// Mock for @tauri-apps/plugin-dialog. The real package is externalized by
// vitest, so its internal `@tauri-apps/api/core` import bypasses the
// invoke alias — dialogs would hit the real (absent) Tauri bridge. Routing
// through the shared invoke mock lets tests script dialog results with
// setMockInvoke ("plugin:dialog|save" / "plugin:dialog|open").

import { invoke } from "./tauri-mock";

export async function save(options?: unknown): Promise<string | null> {
  return invoke<string | null>("plugin:dialog|save", {
    options: options as Record<string, unknown>,
  });
}

export async function open(options?: unknown): Promise<unknown> {
  return invoke("plugin:dialog|open", {
    options: options as Record<string, unknown>,
  });
}
