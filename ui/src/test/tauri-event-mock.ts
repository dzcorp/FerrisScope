// Mock for @tauri-apps/api/event.
//
// Tests opt into routing by name: register a handler via `listen`, then
// dispatch synchronously via `emitMock(event, payload)`. By default the
// listener is a black hole (no-op) — matches the original test-time
// behaviour for tests that don't care about events.

export type UnlistenFn = () => void;

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Set<Handler>>();

export async function listen<T = unknown>(
  event: string,
  handler: (e: { payload: T }) => void,
): Promise<UnlistenFn> {
  const set = handlers.get(event) ?? new Set();
  set.add(handler as Handler);
  handlers.set(event, set);
  return () => {
    handlers.get(event)?.delete(handler as Handler);
  };
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  emitMock(event, payload);
}

// Synchronous test-only dispatcher. Fires every registered handler for
// the given event name with the supplied payload.
export function emitMock(event: string, payload: unknown): void {
  const set = handlers.get(event);
  if (!set) return;
  for (const h of set) h({ payload });
}

export function resetEventMock(): void {
  handlers.clear();
}

export function listenerCount(event: string): number {
  return handlers.get(event)?.size ?? 0;
}
