/** Timers behind an interface, so tests drive them with a fake clock. Shared by agent and person sessions. */
export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** setTimeout, unref'd: a pending timer never keeps the process alive. */
export const realScheduler: Scheduler = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
