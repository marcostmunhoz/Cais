import type { Engine } from '../model';
import type { CellValue, StatementKind } from '../results';
import type { ScopeAnalysis } from './scope';

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
  /**
   * Qualified functions outside the engine's built-in namespaces (`SAFE.`, `NET.`, `AEAD.`, `KEYS.`, `HLL_COUNT.`,
   * `KLL_QUANTILES.`, `OBJ.`…), upper case, as written: a function defined in a project (it may be a remote function,
   * which runs code outside the engine) plus every `ML.*` and `AI.*` call (they may call remote models and cost
   * more than the bytes read). GoogleSQL only.
   */
  remoteCalls?: string[];
  /** The statement calls EXTERNAL_QUERY, which runs a query on another database. GoogleSQL only. */
  externalQuery?: boolean;
  /**
   * The statement reads a view that shows the SQL of other people's jobs or sessions (`INFORMATION_SCHEMA.JOBS*`,
   * `JOBS_BY_*`, `SESSIONS_*`), in any spelling of the path (backticks, region or project qualifier). GoogleSQL only.
   */
  jobsMetadata?: boolean;
  /** The text carries a `#legacySQL` or `#standardSQL` directive. GoogleSQL only. */
  legacyDirective?: boolean;
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

/** One DELETE of one row of one table, identified by its whole primary key. */
export interface DeleteSpec {
  database: string;
  table: string;
  where: UpdateValue[];
}

/** One INSERT of one or more rows into one table: `rows[i][j]` is the value of `columns[j]`. */
export interface InsertSpec {
  database: string;
  table: string;
  columns: { column: string; type: string }[];
  rows: (readonly CellValue[])[];
}

/**
 * What agents may and may not touch, as the engine names it. `decide()` (main/agents/policy.ts) and the broker
 * read these and know no engine's names. The refusal messages go to agents only (fixed English).
 */
export interface AgentRules {
  /** Lower-case names of schemas/databases agents never write to. */
  systemSchemas: string[];
  /** Lower-case names of schemas agents never read (accounts, password hashes). */
  secretSchemas: string[];
  /** Upper-case function names agents never call. */
  deniedFunctions: string[];
  /** Verbs an agent may run as writes (always inside a transaction, always approved). */
  writeVerbs: string[];
  /** --database from an agent: a plain name the engine accepts, without hidden text. */
  isValidDatabaseName(name: string): boolean;
  /**
   * An unqualified call (as `Classification.functions` lists it) that the engine does not ship: it may be a routine
   * defined in the project, so an agent's read that calls it waits for the person. Absent: the engine has no such
   * routines to tell apart (MySQL keeps its own rules).
   */
  isUnknownFunction?(name: string): boolean;
  messages: {
    systemSchemaWrite: string;
    systemSchemaRead: string;
    /** Reading the metadata of other people's jobs or sessions (`system_schema`). Absent: `systemSchemaRead`. */
    jobsMetadata?: string;
  };
}

export interface Dialect {
  engine: Engine;
  /** Product name for the interface ("MySQL"). */
  displayName: string;
  /** Name of the CodeMirror SQL dialect the renderer should use. */
  codemirrorDialect: 'MySQL' | 'GoogleSQL';
  /** What the engine calls the namespace a statement runs in: a MySQL "database", a BigQuery "dataset". The catalogs have both words. */
  databaseTerm: 'database' | 'dataset';
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
  /**
   * Which tables a statement names, under which alias, and what each position of it can see (see `scope.ts`). Reads
   * incomplete text: the editor asks it while the statement is being typed.
   */
  analyze(statement: string): ScopeAnalysis;
  /** Lower-case identifier names a statement mentions (words and quoted names), for matching against the schema. */
  identifiers(statement: string): string[];
  /** Why SQL from an agent may read differently to a person than to the server (pt-BR), or null. */
  agentCodeProblem?(sql: string): string | null;
  quoteIdent(name: string): string;
  /** What agents may and may not touch. */
  agentRules: AgentRules;
  /** The preview a double click on a table runs: its first rows, written as the engine reads them. */
  tablePreviewSql(database: string, table: string): string;
  /** How a value of this column type is written (and whether the grid can edit it at all). */
  valueKind(type: string): ValueKind;
  /**
   * The value as a literal that the server and the splitter read the same way in any session setting.
   * Throws when the value is not valid for the type (a number column with text, a cut binary value).
   */
  quoteLiteral(value: CellValue, type: string): string;
  /** `UPDATE db.table SET … WHERE <every key column> = …`, without a terminator and without LIMIT. Throws like `quoteLiteral`. */
  buildUpdate(spec: UpdateSpec): string;
  /** `buildUpdate`, plus where each SET value literal sits in the statement (offsets into `sql`, in order of `spec.set`). */
  buildUpdateLocated(spec: UpdateSpec): { sql: string; setValues: { from: number; to: number }[] };
  /** `DELETE FROM db.table WHERE <every key column> = …`, without a terminator and without LIMIT. Throws like `quoteLiteral`, and when a key value is NULL. */
  buildDelete(spec: DeleteSpec): string;
  /**
   * `INSERT INTO db.table (<columns>) VALUES (…), (…)`, without a terminator: one line when there is one row, one
   * line per row otherwise. Throws like `quoteLiteral`, and when there is no column or no row.
   */
  buildInsert(spec: InsertSpec): string;
}
