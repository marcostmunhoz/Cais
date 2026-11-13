// The trail: every execution in the Cais, by the person and by agents. Types shared by main and renderer. Pure TypeScript.

/** Who did it. 'cais' is the app itself (a check that failed, the trail being moved). */
export type TrailActor = 'person' | 'agent' | 'cais';

/** Counts of one command of an agent request. Never result data. */
export interface TrailStatement {
  verb: string;
  rows?: number;
  affectedRows?: number;
  errorCode?: string;
}

/**
 * One line of the trail. Deliberately has no field for result data: SQL, who, where, how it ended and counts.
 * Agent lines share the request id: the last line of an id is its final state.
 */
export interface TrailEntry {
  id: string;
  ts: number;
  actor: TrailActor;
  /** Agent: the client name it gave (informed by the client). */
  client?: string;
  /** "projeto/ambiente". */
  environment: string;
  environmentId?: string;
  production: boolean;
  database?: string;
  /**
   * Agent: read | write | schema | script | grant. Person: the tab's mode (read-only | transaction | autocommit)
   * or "config" for a change to what agents may do.
   */
  mode: string;
  /** Person: statement | commit | rollback | mode | connection_lost | config. Absent on agent lines. */
  event?: string;
  reason?: string;
  sql: string;
  /** Set when `sql` was cut: its full length. */
  sqlLength?: number;
  /** Final state ("succeeded", "committed", "refused", "ok", "error"...) or "running" for a line written before running. */
  state: string;
  verb?: string;
  kind?: string;
  durationMs?: number;
  rows?: number;
  affectedRows?: number;
  errorCode?: string;
  errno?: number;
  /** BigQuery, person lines: the job's id, the bytes the dry run estimated and the bytes billed. Never result data. */
  jobId?: string;
  bytesEstimated?: number;
  bytesBilled?: number;
  /** Person, Transação: the server still holds a transaction after the statement. */
  inTransaction?: boolean;
  /**
   * Free text for config and mode lines, in the app locale of the moment it was written. Never
   * re-rendered: the line body is chained, so an old line keeps the language it was written in.
   */
  detail?: string;
  decidedBy?: string;
  decidedAt?: number;
  secondDecidedBy?: string;
  autoCommit?: boolean;
  shareResult?: boolean;
  rollbackReason?: string;
  rollbackIncomplete?: boolean;
  requestId?: string;
  statements?: TrailStatement[];
  /** Brought in from an agents-only trail file (agent-audit.jsonl): it was never chained, so nothing vouches for it. */
  imported?: boolean;
}

export interface TrailQuery {
  /** Only lines before this time (ms), for "Carregar mais". */
  before?: number;
  /** How many days back from now (1 to 90). */
  days: number;
  actor?: TrailActor;
  environmentId?: string;
  /** Case-insensitive text in the SQL, the reason, the client or the environment. */
  text?: string;
  limit: number;
}

export interface TrailPage {
  entries: TrailEntry[];
  /** Pass as `before` to get older lines; absent when there is nothing older in the period. */
  nextBefore?: number;
  /** Days (YYYY-MM-DD) whose file was changed outside the Cais: a line edited, added or removed in the middle. */
  tampered: string[];
  /** The trail could not be written at some point (in the app locale, rendered by main when listing). */
  writeError?: string;
  /** The trail is chained with a key from the system vault; false when the vault is not available. */
  verified: boolean;
}
