import { AGENT_LOCALE, render, renderRef, type MessageRef } from '@shared/i18n';

/**
 * An error that reaches the agent: a stable code and a message that is safe to show.
 * - Built from a MessageRef: `message` is in the app locale (the person may see it: modal, panel, toast) and `ref`
 *   is what the agent gets, rendered in AGENT_LOCALE (English, fixed).
 * - Built from a string: the text is fixed English for the agent (errors only agents ever see), unless an explicit
 *   `ref` says what the agent gets.
 */
export class AgentError extends Error {
  readonly ref?: MessageRef;

  constructor(
    message: string | MessageRef,
    public readonly code: string,
    public readonly fields?: Record<string, unknown>,
    ref?: MessageRef,
  ) {
    super(typeof message === 'string' ? message : render(message));
    this.name = 'AgentError';
    const agentRef = ref ?? (typeof message === 'string' ? undefined : message);
    if (agentRef) this.ref = agentRef;
  }
}

/** The `ref` an error or error-like object carries (shared convention: `{ message, ref? }`), when it is a real one. */
export function refOf(value: unknown): MessageRef | undefined {
  if (value === null || typeof value !== 'object' || !('ref' in value)) return undefined;
  const r = (value as { ref?: unknown }).ref;
  return r !== null && typeof r === 'object' && typeof (r as { key?: unknown }).key === 'string' ? (r as MessageRef) : undefined;
}

/** What the agent reads for an error: its `ref` in AGENT_LOCALE when it has one, else its message as is. */
export function agentText(error: { message: string }): string {
  const r = refOf(error);
  return r ? renderRef(r, AGENT_LOCALE) : error.message;
}

/** A message for both audiences: `message` in the app locale, `ref` for the agent. */
export function bothWays(r: MessageRef): { message: string; ref: MessageRef } {
  return { message: render(r), ref: r };
}
