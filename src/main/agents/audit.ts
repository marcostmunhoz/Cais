import type { TrailEntry } from '@shared/trail';

/**
 * What the broker writes to the trail: a line without time (the trail adds it) and, by default, by an agent.
 * Deliberately has no field for result data.
 */
export type AuditEntry = Omit<TrailEntry, 'ts' | 'actor'> & { actor?: TrailEntry['actor'] };

/** The broker's side of the trail. `append` returns false when the line could not be written. */
export interface AuditSink {
  append(entry: AuditEntry): boolean | void;
}
