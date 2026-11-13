/**
 * Errors from `window.cais` arrive as plain `{ message, code? }` objects (the preload passes the IPC error code
 * along; an Error would lose it at the context bridge). Anything else thrown in the renderer is an Error.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
  return String(e);
}

/** The IPC error code (`transaction-open`, `not-connected`...), when main gave one. */
export function errorCode(e: unknown): string | undefined {
  if (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string') return (e as { code: string }).code;
  return undefined;
}
