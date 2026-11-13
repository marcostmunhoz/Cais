import type { Engine, SessionMode } from '@shared/model';
import type { SchemaTree, StatementError, StatementResult } from '@shared/results';
import type { MessageRef } from '@shared/i18n';

export interface ConnectParams {
  host: string;
  port: number;
  database?: string;
  user: string;
  password?: string; // password or IAM token
  authPlugin?: 'mysql_clear_password'; // IAM
  tls: 'off' | 'required'; // required = encrypt without verifying (ssl-mode=REQUIRED)
  /** Fresh parameters for a side connection opened later (KILL QUERY): an IAM token from open time may have expired. */
  refresh?: () => Promise<ConnectParams>;
}

export interface DbSessionError {
  /** In the app locale (the person's). */
  message: string;
  /** The same message as a reference, when it is one of Cais's own: agents get it rendered in AGENT_LOCALE. */
  ref?: MessageRef;
  hint?: string;
  detail?: string;
  code?: string;
  errno?: number;
  sqlState?: string;
  fatal?: boolean;
}

export interface Driver {
  engine: Engine;
  open(params: ConnectParams): Promise<DbSession>;
  /**
   * Own short connection. Without a scope: databases and tables. With `{ database }`: also the columns of that
   * database, for engines that read them on demand. MySQL ignores the scope and returns everything.
   */
  introspect(params: ConnectParams, scope?: { database?: string }): Promise<SchemaTree>;
  test(params: ConnectParams): Promise<{ serverVersion: string }>;
}

/** What `execute` takes. MySQL reads `maxRows` and `stopAtCap`; the other fields are for engines that bill or cache reads. */
export interface ExecuteOptions {
  maxRows: number;
  stopAtCap?: boolean;
  /** Upper bound of bytes the engine may bill for this statement. */
  maxBytesBilled?: number;
  /** Read more rows of the result already computed by the previous run of the same statement, without running it again. */
  refetch?: boolean;
}

/** What `prepare` learned about a statement without running it. */
export interface PrepareResult {
  /** The kind of statement as the server reads it (for a second look at read-only). */
  serverKind?: string;
  bytesEstimated?: number;
  error?: StatementError;
}

export interface DbSession {
  readonly serverVersion: string;
  /** `strict` (agent sessions): utf8mb4, sql_mode and autocommit are re-asserted before every statement in any mode. */
  applyMode(mode: SessionMode, opts?: { strict?: boolean }): Promise<void>;
  /**
   * `stopAtCap: false`: past maxRows the remaining rows are read and dropped instead of killing the query
   * (a procedure must not be cut between its SELECT and its writes).
   */
  execute(sql: string, opts: ExecuteOptions): Promise<StatementResult>;
  /** Switches the session's current database and answers like a statement (`sql` is what the trail records). */
  useDatabase(name: string): Promise<StatementResult>;
  /**
   * Asks the server what it makes of a statement without running it. Optional: engines with no such step leave it out.
   * Not used by the SessionManager yet.
   */
  prepare?(sql: string): Promise<PrepareResult>;
  /**
   * Whether a transaction is open on the server right now, or undefined when it cannot tell. Optional: an engine
   * without it leaves the SessionManager with the state it had.
   */
  transactionProbe?(): Promise<boolean | undefined>;
  cancel(): Promise<void>; // KILL QUERY <threadId> through a control connection
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** After `rollback()`: the server said part of it could not be undone (non-transactional tables). */
  readonly lastRollbackIncomplete?: boolean;
  /** Server-side limits for sessions opened for agents. */
  applyLimits?(limits: { maxExecutionMs?: number; lockWaitSeconds?: number }): Promise<void>;
  currentDatabase(): Promise<string | null>;
  onFatalError(cb: (err: DbSessionError) => void): void;
  close(): Promise<void>;
  /**
   * Clears what a previous user of the connection left in the session (user variables, named locks, character
   * set, prepared statements, temporary tables) and applies the mode and limits again.
   */
  reset?(): Promise<void>;
  /** Drops the socket now, without waiting for the server: whatever is running ends for the client at once. */
  destroy?(): void;
  /** False once the connection is known to be gone (nothing sent from now on reaches the server). */
  isAlive?(): boolean;
}

/** Thrown by drivers for connection-level failures, already translated for the user. */
export class DriverError extends Error {
  constructor(
    message: string,
    public readonly info: DbSessionError,
  ) {
    super(message);
    this.name = 'DriverError';
  }

  /** `info.ref`: the message as a reference, for answers to agents (`renderRef(err.ref, AGENT_LOCALE)`). */
  get ref(): MessageRef | undefined {
    return this.info.ref;
  }
}
