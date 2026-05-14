// Mock for @tauri-apps/api/core. Tests that exercise components calling
// Tauri commands set per-call expectations via `setMockInvoke()`; tests
// that don't touch IPC just leave the default no-op responder in place.

type Responder = (cmd: string, args: Record<string, unknown> | undefined) => unknown;

let responder: Responder = () => {
  // Default: throw so a test that forgets to mock surfaces the missing
  // wiring instead of silently coasting on `undefined`.
  throw new Error("invoke called without a mock; use setMockInvoke()");
};

export function setMockInvoke(fn: Responder): void {
  responder = fn;
}

export function resetMockInvoke(): void {
  responder = () => {
    throw new Error("invoke called after reset; use setMockInvoke()");
  };
}

export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const value = responder(cmd, args);
  return Promise.resolve(value as T);
}

// Minimal stand-in for tauri's IPC `Channel`. Real channels carry frames
// from Rust over the webview bridge; under jsdom there's no bridge, so the
// component just assigns `onmessage` and a test drives it directly:
// grab the channel instance off the `invoke` args, then call
// `channel.onmessage(frame)` to simulate a backend event.
export class Channel<T = unknown> {
  onmessage: (msg: T) => void = () => {};
}
