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
