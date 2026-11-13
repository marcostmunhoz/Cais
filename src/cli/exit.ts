/** Exit codes of `cais llm`; the same table is printed by `cais llm guide`. */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  declined: 3, // rejected, expired or rolled_back
  unavailable: 4, // Cais closed or agent access off
  timeout: 5,
} as const;

/** Exit code for a successful reply of `query` or `status`. */
export function exitForResult(result: { status?: unknown; timed_out?: unknown }): number {
  if (result.timed_out === true) return EXIT.timeout;
  switch (result.status) {
    case 'failed':
      return EXIT.failed;
    case 'rejected':
    case 'expired':
    case 'rolled_back':
      return EXIT.declined;
    default:
      return EXIT.ok; // succeeded, committed, running, awaiting_commit, pending_approval (without --wait)
  }
}

/** Exit code for an error reply from the server. */
export function exitForError(code: string | undefined): number {
  // the environment could not be reached: the request failed, it was not a mistake in the request
  if (code === 'internal_error' || code === 'connection_failed' || code === 'credential_unavailable') return EXIT.failed;
  if (code === 'agent_access_off') return EXIT.unavailable;
  return EXIT.usage;
}
