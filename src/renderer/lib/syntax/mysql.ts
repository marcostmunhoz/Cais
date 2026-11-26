// MySQL syntax check for the editor: the statement goes through the DTStack MySQL grammar (dt-sql-parser) and the first
// syntax error, if any, comes back as a range of the statement. Pure and free of the DOM, so the worker, the unit
// tests and the corpus check all run the same code. The grammar is a third party's and trails the server: what it is
// known to read wrong is left out before it is asked (see `shouldCheck`), so a valid statement is never flagged.
import { MySQL } from 'dt-sql-parser/dist/parser/mysql';
import { scopeTokens } from '@shared/dialects/mysql/scope';
import type { ScopeToken } from '@shared/dialects/scope';

export interface SyntaxIssue {
  /** Offsets in the text that was checked. */
  from: number;
  to: number;
  /** The parser's own message, in English. */
  message: string;
}

/** A statement longer than this is not checked: the grammar takes about a millisecond per hundred characters, and a bulk INSERT is not what a person misspells. */
export const MAX_CHECKED_LENGTH = 200_000;

/**
 * What the lint reads: queries and row changes. DDL, administration, SET/SHOW and routines are left to the server:
 * their grammar has more syntax than the third-party one covers. Queries and row changes (SELECT, WITH, INSERT,
 * REPLACE, UPDATE, DELETE, TABLE, VALUES) are read, and so is a first word that is no MySQL verb.
 */
/** The words a MySQL 8.4 statement starts with. A first word in neither list is a misspelled verb, and is read. */
const OTHER_VERBS = new Set(
  (
    'ALTER ANALYZE BEGIN BINLOG CACHE CALL CHANGE CHECK CHECKSUM CLONE COMMIT CREATE DEALLOCATE DESC DESCRIBE DO DROP EXECUTE EXPLAIN FLUSH ' +
    'GET GRANT HANDLER HELP IMPORT INSTALL KILL LOAD LOCK OPTIMIZE PREPARE PURGE RELEASE RENAME REPAIR RESET RESIGNAL RESTART REVOKE ROLLBACK ' +
    'SAVEPOINT SET SHOW SHUTDOWN SIGNAL START STOP TRUNCATE UNINSTALL UNLOCK USE XA'
  ).split(' '),
);

/**
 * Words the grammar cannot read as a name although MySQL can (non-reserved keywords: `SELECT type FROM t` is an error
 * for it). A statement that has one, outside a call (`CAST(`, `EXTRACT(` are called), is not checked. The unit test
 * rebuilds this list from the parser's own vocabulary, so a new version of the grammar shows what changed.
 */
export const UNREADABLE_NAMES: ReadonlySet<string> = new Set(
  (
    'ACTIVE ALWAYS APPLICATION_PASSWORD_ADMIN ASSIGN_GTIDS_TO_ANONYMOUS_TRANSACTIONS AUTHENTICATION CAST CHALLENGE_RESPONSE CLONE ' +
    'COMPONENT ENCRYPTION_KEY_ID EXTRACT FACTOR FINISH FLUSH_OPTIMIZER_COSTS FLUSH_STATUS FLUSH_TABLES FLUSH_USER_RESOURCES FOLLOWING ' +
    'GENERATE GEOMCOLLECTION GEOMETRY GET_MASTER_PUBLIC_KEY GET_SOURCE_PUBLIC_KEY GTID_ONLY HISTOGRAM INACTIVE INITIAL INITIATE ' +
    'INNODB_REDO_LOG_ENABLE LOCKED MASTER_COMPRESSION_ALGORITHMS MASTER_PUBLIC_KEY_PATH MASTER_TLS_CIPHERSUITES ' +
    'MASTER_ZSTD_COMPRESSION_LEVEL NATIONAL NETWORK_NAMESPACE NVARCHAR OFF OLD PAGE_COMPRESSED PAGE_COMPRESSION_LEVEL PERSIST ' +
    'PERSIST_ONLY PRECEDING PRIVILEGE_CHECKS_USER REFERENCE REGISTRATION REPLICA REPLICAS REQUIRE_ROW_FORMAT ' +
    'REQUIRE_TABLE_PRIMARY_KEY_CHECK RESOURCE RESTART RETAIN SERVICE_CONNECTION_ADMIN SKIP SOURCE_AUTO_POSITION SOURCE_BIND ' +
    'SOURCE_COMPRESSION_ALGORITHMS SOURCE_CONNECTION_AUTO_FAILOVER SOURCE_CONNECT_RETRY SOURCE_DELAY SOURCE_HEARTBEAT_PERIOD ' +
    'SOURCE_HOST SOURCE_LOG_FILE SOURCE_LOG_POS SOURCE_PASSWORD SOURCE_PORT SOURCE_PUBLIC_KEY_PATH SOURCE_RETRY_COUNT SOURCE_SSL ' +
    'SOURCE_SSL_CA SOURCE_SSL_CAPATH SOURCE_SSL_CERT SOURCE_SSL_CIPHER SOURCE_SSL_CRL SOURCE_SSL_CRLPATH SOURCE_SSL_KEY ' +
    'SOURCE_SSL_VERIFY_SERVER_CERT SOURCE_TLS_CIPHERSUITES SOURCE_TLS_VERSION SOURCE_USER SOURCE_ZSTD_COMPRESSION_LEVEL ' +
    'SQL_BUFFER_RESULT SQL_CACHE SQL_NO_CACHE STREAM THREAD_PRIORITY TREE TYPE UNREGISTER VCPU'
  ).split(' '),
);

/**
 * Syntax the grammar reads wrong in any position: a statement with one of these words is not checked. Forms it gets
 * wrong by their shape (temporal literals `DATE '...'`, ODBC `{fn ...}`, the `INTERVAL(...)` function, `(TABLE t)` and
 * `(VALUES ...)` in parentheses) are left out in `unreadable`.
 */
export const UNREADABLE_SYNTAX: ReadonlySet<string> = new Set([
  'AGAINST', // MATCH (...) AGAINST (...)
  'JSON_TABLE',
  'NOWAIT', // FOR UPDATE NOWAIT
]);

/** An executable comment (`/*! ... *\/`, `/*M! ... *\/`) is code for the server and a comment for the grammar. */
const EXECUTABLE_COMMENT = /\/\*M?!/;

const TEMPORAL_LITERAL = new Set(['DATE', 'TIME', 'TIMESTAMP']);
const isQuotedText = (t: ScopeToken | undefined): boolean => t !== undefined && t.kind === 'other' && (t.text[0] === "'" || t.text[0] === '"');

function unreadable(tokens: ScopeToken[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const next = tokens[i + 1];
    // ODBC escapes ({fn NOW()}, {d '2020-01-01'})
    if (t.kind === 'punct' && t.text === '{') return true;
    // a parenthesis that opens with TABLE or VALUES (`IN (TABLE u)`, `(VALUES ROW(1)) AS v`)
    if (t.kind === 'punct' && t.text === '(' && next?.kind === 'word' && (next.upper === 'TABLE' || next.upper === 'VALUES')) return true;
    if (t.kind === 'word' && TEMPORAL_LITERAL.has(t.upper) && isQuotedText(next)) return true; // DATE '2020-01-01'
    if (t.kind === 'word' && t.upper === 'INTERVAL' && next?.kind === 'punct' && next.text === '(') return true; // the INTERVAL() function
    if (t.kind !== 'word') continue;
    if (UNREADABLE_SYNTAX.has(t.upper)) return true;
    if (UNREADABLE_NAMES.has(t.upper) && !(tokens[i + 1]?.kind === 'punct' && tokens[i + 1]!.text === '(')) return true;
  }
  return false;
}

const INSERT_PREFIX = new Set(['INTO', 'INSERT', 'REPLACE', 'IGNORE', 'LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY']);

/**
 * An empty `()` the grammar rejects but MySQL accepts: the column list of `INSERT INTO t () VALUES ()` and the row of
 * `VALUES ()` / `VALUES (), ()` (all defaults).
 */
function emptyInsertParens(tokens: ScopeToken[]): boolean {
  const verb = tokens[0];
  if (verb?.kind !== 'word' || (verb.upper !== 'INSERT' && verb.upper !== 'REPLACE')) return false;
  let inValues = false;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]!;
    if (t.kind === 'word' && (t.upper === 'VALUES' || t.upper === 'VALUE')) inValues = true;
    if (t.kind !== 'punct' || t.text !== '(' || tokens[i + 1]!.kind !== 'punct' || tokens[i + 1]!.text !== ')') continue;
    const prev = tokens[i - 1];
    const before = tokens[i - 2];
    if (!prev) continue;
    if (prev.kind === 'word' && (prev.upper === 'VALUES' || prev.upper === 'VALUE' || prev.upper === 'ROW')) return true;
    if (inValues && prev.kind === 'punct' && prev.text === ',') return true;
    // the column list: the target table sits right before it
    if (prev.kind !== 'punct' && before && ((before.kind === 'word' && INSERT_PREFIX.has(before.upper)) || (before.kind === 'punct' && before.text === '.'))) return true;
  }
  return false;
}

/** Whether the grammar is asked about this statement at all. */
export function shouldCheck(text: string, tokens: ScopeToken[] = scopeTokens(text)): boolean {
  if (text.length > MAX_CHECKED_LENGTH) return false;
  const first = tokens[0];
  if (!first) return false;
  // a statement that starts with "(" is a parenthesized query; a first word that is no verb of MySQL is a typo
  if (first.kind === 'word' ? OTHER_VERBS.has(first.upper) : first.text !== '(') return false;
  if (EXECUTABLE_COMMENT.test(text)) return false;
  return !unreadable(tokens) && !emptyInsertParens(tokens);
}

let parser: MySQL | undefined;

/** The UTF-16 offset of a position the parser reports: a 1-based line and a column counted in code points from 1. */
function offsetOf(text: string, line: number, column: number): number {
  let start = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) return text.length;
    start = nl + 1;
  }
  let offset = start;
  for (let c = 1; c < column && offset < text.length; c++) offset += (text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
  return offset;
}

/** The first syntax error of the statement, or none. */
export function checkMysql(text: string): SyntaxIssue[] {
  const tokens = scopeTokens(text);
  if (!shouldCheck(text, tokens)) return [];
  parser ??= new MySQL();
  const first = parser.validate(text)[0];
  if (!first) return [];
  let from = offsetOf(text, first.startLine, first.startColumn);
  let to = offsetOf(text, first.endLine, first.endColumn);
  if (from >= text.length) {
    // the statement ends too soon: the error is the end of it, shown on its last word
    const last = tokens[tokens.length - 1];
    from = last ? last.pos : Math.max(0, text.length - 1);
    to = text.length;
  }
  if (to <= from) to = Math.min(text.length, from + 1);
  return [{ from, to: Math.min(to, text.length), message: first.message }];
}
