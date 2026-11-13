import { render, type MessageRef } from '@shared/i18n';

/**
 * Error with a message that is safe and meant to be shown to the person, in the app locale.
 * `ref`, when present, is the same message as a reference: code that answers agents renders it with
 * `renderRef(err.ref, AGENT_LOCALE)` (agents always read pt-BR), and falls back to `message` without it.
 */
export class CaisError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly data?: Record<string, unknown>,
    public readonly ref?: MessageRef,
  ) {
    super(message);
    this.name = 'CaisError';
  }

  /** A CaisError whose message is `reference` rendered in the current locale, keeping the reference for agents. */
  static of(reference: MessageRef, code?: string, data?: Record<string, unknown>): CaisError {
    return new CaisError(render(reference), code, data, reference);
  }
}
