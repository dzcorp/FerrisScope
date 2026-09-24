/// Debounced, serialised persistence. Writes never overlap, so an older
/// payload can't land after a newer one, and `flush()` writes any pending
/// change immediately (used on window close).
export type Saver = { schedule: () => void; flush: () => Promise<void> };

export function createSaver(
  write: () => Promise<unknown>,
  delayMs: number,
  onError: (e: unknown) => void,
): Saver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let inflight: Promise<void> | null = null;

  const run = (): Promise<void> => {
    if (inflight) return inflight;
    if (!dirty) return Promise.resolve();
    dirty = false;
    inflight = write()
      .then(
        () => undefined,
        (e: unknown) => onError(e),
      )
      .finally(() => {
        inflight = null;
      })
      .then(() => (dirty ? run() : undefined));
    return inflight;
  };

  return {
    schedule() {
      dirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, delayMs);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await inflight;
      await run();
    },
  };
}

const flushOnClose: Saver[] = [];

export function registerFlushOnClose(s: Saver): void {
  flushOnClose.push(s);
}

/// Flush every registered saver, bounded so a hung write can't block quitting.
export async function flushAll(timeoutMs = 2000): Promise<void> {
  await Promise.race([
    Promise.all(flushOnClose.map((s) => s.flush())),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}
