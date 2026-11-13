import type { MessageRef } from './i18n';
import type { SessionMode } from './model';

export type StatementKind = 'read' | 'write' | 'ddl' | 'transaction-control' | 'session' | 'other';

export type CellValue = string | number | null | { kind: 'binary'; hex: string; length: number };

/** Where a result column comes from, as the server reports it (empty for expressions). */
export interface ColumnSource {
  database: string;
  /** The base table (or view) name, never the alias. */
  table: string;
  /** The column name in that table, never the alias. */
  column: string;
  /** The name the query gave the table (the alias, or the table name): tells a self-join apart. */
  alias?: string;
}

export interface ColumnMeta {
  name: string;
  type: string;
  // Engine-neutral facts about the column, for editing in the grid. Agents never see them.
  source?: ColumnSource;
  /** Part of the table's primary key, as the server reports it (a guard against a stale schema). */
  primaryKeyPart?: boolean;
  nullable?: boolean;
  autoIncrement?: boolean;
  /** Set by drivers whose protocol reports generated columns (MySQL does not: the schema's `generated` says it). */
  generated?: boolean;
}

export interface StatementError {
  message: string; // friendly message in the app locale, or the original one when there is no mapping
  /** The friendly message as a reference, when it is one of Cais's own: agents get it rendered in AGENT_LOCALE. */
  ref?: MessageRef;
  hint?: string;
  detail?: string; // original driver/server message when `message` is a friendly rewrite
  code?: string;
  errno?: number;
  sqlState?: string;
  fatal?: boolean; // the connection is gone
}

export interface StatementResult {
  index: number;
  sql: string;
  kind: StatementKind;
  verb: string; // main verb, upper case ("SELECT", "UPDATE"...)
  durationMs: number;
  columns?: ColumnMeta[];
  rows?: CellValue[][];
  truncated?: boolean;
  affectedRows?: number;
  insertId?: string;
  warnings?: number;
  error?: StatementError;
  /** Transaction state reported by the server after the statement (Transação mode only). */
  inTransaction?: boolean;
  /** Something the person must know about what the statement did to the session (pt-BR). */
  notice?: string;
}

export type SessionStatus = 'disconnected' | 'connecting' | 'idle' | 'running' | 'error';

export interface SessionState {
  tabId: string;
  environmentId: string;
  status: SessionStatus;
  mode: SessionMode;
  database: string | null;
  transaction: { open: boolean; statements: number; startedAt?: number };
  serverVersion?: string;
  error?: string;
  /** Persistent informational notice (lost transaction, environment changed...). */
  notice?: string;
  /** Why a connected tab went back to disconnected: no activity for the idle time, or Desconectar. Cleared on open. */
  disconnectReason?: 'idle' | 'manual';
}

export type SchemaColumn = {
  name: string;
  type: string;
  nullable: boolean;
  key?: 'PRI' | 'UNI' | 'MUL';
  /** A generated column: the server computes it, an UPDATE cannot set it. */
  generated?: 'virtual' | 'stored';
  /** The server changes it on every UPDATE of the row (ON UPDATE CURRENT_TIMESTAMP). */
  onUpdate?: boolean;
};
export type SchemaTable = {
  name: string;
  type: 'table' | 'view';
  engine?: string;
  columns: SchemaColumn[];
  /** View: the tables it reads, "db.table" lower-case (what a write through the view reaches). */
  uses?: string[];
  /** Table: the bodies of its triggers (what a write to it may also write). */
  triggers?: string[];
  /** Table: "db.table" of the tables whose foreign keys cascade from it (ON DELETE/UPDATE CASCADE, SET NULL, SET DEFAULT). */
  cascadedBy?: string[];
};
export type SchemaTree = {
  /**
   * Every foreign key that can cascade into another table is known (InnoDB's own list could be read, or the
   * account sees every table). False: a cascade from a table the account cannot see may be missing.
   */
  foreignKeysComplete?: boolean;
  databases: {
    name: string;
    tables: SchemaTable[];
    /** Stored functions and procedures; `body` is null when the server does not show it to this account. */
    routines?: { name: string; body: string | null }[];
    /** False when this account cannot see the triggers of the database (no TRIGGER privilege). */
    triggersVisible?: boolean;
    /** True when some of the metadata about what a write reaches (views, triggers, routines, foreign keys) could not be read. */
    partial?: boolean;
  }[];
};
