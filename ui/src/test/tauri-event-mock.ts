// Mock for @tauri-apps/api/event.

export type UnlistenFn = () => void;

export async function listen<T = unknown>(
  _event: string,
  _handler: (e: { payload: T }) => void,
): Promise<UnlistenFn> {
  return () => {
    /* no-op */
  };
}

export async function emit(_event: string, _payload?: unknown): Promise<void> {
  // No-op — tests that need to assert emissions can wrap this further.
}
