import type { Engine } from '../model';
import type { CellValue, StatementKind } from '../results';

export interface SqlStatement {
  /** Statement text without the trailing delimiter, trimmed. */
  text: string;
  /** Offset of the first character of `text` in the original string. */
  start: number;
  /** Exclusive offset of the end of `text` in the original string. */
  end: number;
  /** Exclusive end including the delimiter (used to match the cursor). */
  rangeEnd: number;
}

export type TransactionControl = 'begin' | 'commit' | 'rollback' | 'set-transaction' | null;

export interface Classification {
  kind: StatementKind;
  verb: string;
  allowedInReadOnly: boolean;
  implicitCommit: boolean;
  transactionControl: TransactionControl;
  /** Why the statement is refused in read-only mode (pt-BR), when it is. */
  reason?: string;
  /** Refused in every mode (message pt-BR): SET autocommit / transaction characteristics, COMMIT RELEASE. */
  alwaysRefuse?: string;
  /** True for USE: the current database may have changed. */
  changesDatabase?: boolean;
  /**
   * The statement has an executable comment. `versioned` (`/*!NNNNN`, `/*M!`): the server may skip what the
   * classifier read as code, so the classification is not trustworthy. `plain` (`/*! … *\/`): always code.
   */
  executableComment?: 'versioned' | 'plain';
  /** Upper-case names written right before "(" outside strings and comments: the functions it may call. */
  functions?: string[];
  /** An optimizer hint changes a session variable for the statement (SET_VAR, MAX_EXECUTION_TIME). */
  setVarHint?: boolean;
  /** A called function that changes server state outside any transaction (replication, keyring, firewall…). */
  serverStateFunction?: string;
  /** Shows account secrets (SHOW CREATE USER prints the password hash). */
  accountSecrets?: boolean;
}

/**
 * How a value of a column type is written. `zoned` is written as text but read by the server relative to the
 * session time zone (MySQL TIMESTAMP): the same text is another instant in another session, so never a key.
 */
export type ValueKind = 'integer' | 'decimal' | 'float' | 'bit' | 'binary' | 'text' | 'zoned' | 'unsupported';

/** One column and the value it is set to (SET) or compared with (WHERE). `type` is the column type, as the schema or the result says it. */
export interface UpdateValue {
  column: string;
  type: string;
  value: CellValue;
}

/** One UPDATE of one row of one table, identified by its whole primary key. */
export interface UpdateSpec {
  database: string;
  table: string;
  set: UpdateValue[];
  where: UpdateValue[];
}

export interface Dialect {
  engine: Engine;
  /** Product name for the interface ("MySQL"). */
  displayName: string;
  /** Name of the CodeMirror SQL dialect the renderer should use. */
  codemirrorDialect: 'MySQL';
  keywords: string[];
  splitStatements(sql: string): SqlStatement[];
  /**
   * The edits that append `;`-terminated statements (one per line) to the end of a script so that each one splits
   * as its own statement, whatever the script leaves open (an unterminated statement, another delimiter), and
   * the range the appended statements take in the new text.
   */
  appendStatements(doc: string, text: string): { changes: { from: number; insert: string }[]; selection: { from: number; to: number } };
  classify(statement: string): Classification;
  /** Alerts for a person reviewing the statement (pt-BR), such as "UPDATE sem WHERE". */
  warnings(statement: string): string[];
  /** Lower-case identifier names a statement mentions (words and quoted names), for matching against the schema. */
  identifiers(statement: string): string[];
  /** Why SQL from an agent may read differently to a person than to the server (pt-BR), or null. */
  agentCodeProblem?(sql: string): string | null;
  quoteIdent(name: string): string;
  /** How a value of this column type is written (and whether the grid can edit it at all). */
  valueKind(type: string): ValueKind;
  /**
   * The value as a literal that the server and the splitter read the same way in any session setting.
   * Throws when the value is not valid for the type (a number column with text, a cut binary value).
   */
  quoteLiteral(value: CellValue, type: string): string;
  /** `UPDATE db.table SET … WHERE <every key column> = …`, without a terminator and without LIMIT. Throws like `quoteLiteral`. */
  buildUpdate(spec: UpdateSpec): string;
}
