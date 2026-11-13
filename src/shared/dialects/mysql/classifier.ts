import type { Classification } from '../types';
import type { StatementKind } from '../../results';
import { m } from '../../i18n';
import { commentFacts, findDanger, isWs, scanSpecial, withoutVersionedComments } from './lexer';

interface Token {
  /** w word (upper case), s string, i quoted identifier, v variable, n number, p punctuation */
  t: 'w' | 's' | 'i' | 'v' | 'n' | 'p';
  v: string;
  depth: number;
  pos: number;
}

// Identifier bytes for the server: letters, digits, _, $ and anything non-ASCII (NBSP, BOM...).
const isWordStart = (c: string): boolean => /[A-Za-z_$\u0080-￿]/.test(c);
const isWordChar = (c: string): boolean => /[A-Za-z0-9_$\u0080-￿]/.test(c);
/**
 * Upper case for ASCII letters only. The server recognises keywords in ASCII: `ſelect` or `ımit` must stay
 * identifiers here too (JavaScript's toUpperCase would turn them into SELECT and IMIT-like keywords).
 */
const asciiUpper = (text: string): string => text.replace(/[a-z]/g, (ch) => ch.toUpperCase());
const hasNonAscii = (text: string): boolean => /[^\x00-\x7f]/.test(text);
const NUMBER = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;

/**
 * Tokenizes a statement, dropping comments. `/*!NNNNN` openers are transparent. `backslash` picks the string
 * rule (false = NO_BACKSLASH_ESCAPES), so callers can look at both.
 */
export function tokenize(text: string, backslash = true): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  let depth = 0;
  let execOpen = false;
  while (i < n) {
    const c = text[i]!;
    if (isWs(c)) {
      i++;
      continue;
    }
    const special = scanSpecial(text, i, backslash);
    if (special) {
      if (special.type === 'comment') {
        i = special.end;
      } else if (special.type === 'exec-comment') {
        i += special.opener;
        execOpen = true;
      } else {
        tokens.push({ t: special.type === 'ident' ? 'i' : 's', v: text.slice(i, special.end), depth, pos: i });
        i = special.end;
      }
      continue;
    }
    if (execOpen && c === '*' && text[i + 1] === '/') {
      // end of an executable comment; outside one, "*/" is a multiplication followed by "/" (maybe a "/*")
      i += 2;
      execOpen = false;
      continue;
    }
    if (c === '@') {
      const start = i;
      i++;
      if (text[i] === '@') i++;
      while (i < n && (isWordChar(text[i]!) || text[i] === '.')) i++;
      tokens.push({ t: 'v', v: text.slice(start, i), depth, pos: start });
      continue;
    }
    const prev = tokens[tokens.length - 1];
    if (c === '.' && prev && (prev.t === 'w' || prev.t === 'i') && prev.pos + prev.v.length === i && i + 1 < n && isWordChar(text[i + 1]!)) {
      // right after a name, "." starts the next part of a qualified name, whatever its first character:
      // for the server db.2fa_codes is the table 2fa_codes and db.1e5() the function 1e5 (its IDENT_SEP state)
      tokens.push({ t: 'p', v: '.', depth, pos: i });
      const start = ++i;
      while (i < n && isWordChar(text[i]!)) i++;
      tokens.push({ t: 'w', v: asciiUpper(text.slice(start, i)), depth, pos: start });
      continue;
    }
    const num = /[0-9.]/.test(c) ? NUMBER.exec(text.slice(i, i + 80)) : null;
    if (num && num[0] !== '.' && !num[0].includes('.') && i + num[0].length < n && isWordChar(text[i + num[0].length]!)) {
      // digits glued to letters are an identifier for the server (`1log`, `0x1g`, `1e0FROM`)
      const start = i;
      while (i < n && isWordChar(text[i]!)) i++;
      tokens.push({ t: 'w', v: asciiUpper(text.slice(start, i)), depth, pos: start });
      continue;
    }
    if (num && num[0] !== '.') {
      tokens.push({ t: 'n', v: num[0], depth, pos: i });
      i += num[0].length;
      continue;
    }
    if (isWordStart(c)) {
      const start = i;
      while (i < n && isWordChar(text[i]!)) i++;
      tokens.push({ t: 'w', v: asciiUpper(text.slice(start, i)), depth, pos: start });
      continue;
    }
    if (c === '(') {
      tokens.push({ t: 'p', v: c, depth, pos: i });
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1);
      tokens.push({ t: 'p', v: c, depth, pos: i });
      i++;
      continue;
    }
    tokens.push({ t: 'p', v: c, depth, pos: i });
    i++;
  }
  return tokens;
}

const DML_VERBS = new Set(['SELECT', 'UPDATE', 'DELETE', 'INSERT', 'REPLACE', 'TABLE', 'VALUES']);
const DDL_VERBS = new Set(['CREATE', 'ALTER', 'DROP', 'RENAME', 'TRUNCATE', 'GRANT', 'REVOKE']);
/** Variables that change transaction behaviour; the tab mode owns them. */
const TX_VARIABLES = new Set([
  'autocommit',
  'transaction_read_only',
  'tx_read_only',
  'transaction_isolation',
  'tx_isolation',
  'completion_type',
]);

// Refusal texts are built when a statement is classified, in the current locale (the person reads them; the
// agents' policy only looks at the flags).
const msg = () => m().dialect.classify;
const txMessage = (): string => msg().transactionMode;
const refusal = (what: string): string => msg().readOnly({ what });
const notListed = (): string => refusal(msg().notListed);
/** SQL syntax quoted in messages: never translated. */
const EXECUTABLE_SYNTAX = '/*! … */';
const VERSIONED_SYNTAX = '/*!NNNNN … */';
const MARIADB_SYNTAX = '/*M! … */';

function result(
  kind: StatementKind,
  verb: string,
  o: Partial<Classification> & { allowedInReadOnly: boolean },
): Classification {
  return { kind, verb, implicitCommit: false, transactionControl: null, ...o };
}

/** Splits the tokens after SET into its top-level comma-separated parts. */
function setParts(body: Token[], baseDepth: number): Token[][] {
  const parts: Token[][] = [[]];
  for (const tk of body) {
    if (tk.depth === baseDepth && tk.t === 'p' && tk.v === ',') parts.push([]);
    else parts[parts.length - 1]!.push(tk);
  }
  return parts;
}

const unquote = (tk: Token): string => (tk.t === 'i' || tk.t === 's' ? tk.v.slice(1, -1) : tk.v);

/** The tokens a SET part assigns to: everything before its first `=` or `:=` (the whole part if none). */
function setTarget(part: Token[]): Token[] {
  const k = part.findIndex((tk, j) => tk.t === 'p' && (tk.v === '=' || (tk.v === ':' && part[j + 1]?.v === '=')));
  return k === -1 ? part : part.slice(0, k);
}

/** A plain user variable: `@name` and nothing else (no `@@`, no quoted or split name). */
const isUserVariable = (target: Token[]): boolean =>
  target.length === 1 && target[0]!.t === 'v' && !target[0]!.v.startsWith('@@') && target[0]!.v.length > 1;

/**
 * Whether a SET part may change transaction behaviour. The target name is rebuilt across tokens, so quoted,
 * spaced or commented spellings (`autocommit`, @@session . autocommit, @@session.`autocommit`) are seen too.
 */
function touchesTransactionState(part: Token[]): boolean {
  const target = setTarget(part);
  if (isUserVariable(target)) return false;
  const names: string[] = [];
  for (const tk of target) {
    if (tk.t === 'p') continue;
    const raw = tk.t === 'v' ? tk.v.replace(/^@+/, '') : unquote(tk);
    for (const piece of raw.split('.')) if (piece) names.push(piece.toLowerCase());
  }
  if (names.some((name) => name === 'transaction')) return true;
  // the server finds system variables ignoring accents (autocommìt is autocommit): a non-ASCII name may be one
  if (names.some(hasNonAscii)) return true;
  return names.some((name) => TX_VARIABLES.has(name));
}

/** The only character set the app speaks: anything else would make the server read the text differently. */
const SAFE_CHARSET = 'utf8mb4';
const isSafeCharset = (tk: Token | undefined): boolean => isName(tk) && unquote(tk!).toLowerCase() === SAFE_CHARSET;
const isSafeCollation = (tk: Token | undefined): boolean => isName(tk) && unquote(tk!).toLowerCase().startsWith(`${SAFE_CHARSET}_`);

const isName = (tk: Token | undefined): boolean => tk !== undefined && (tk.t === 'w' || tk.t === 's' || tk.t === 'i');

/** Strict SET: only `@user_var = expr[, ...]`, or NAMES / CHARACTER SET alone. */
function classifySet(tokens: Token[], start: number): Classification {
  const verb = 'SET';
  const body = tokens.slice(start + 1);
  const parts = setParts(body, tokens[start]!.depth);

  if (parts.some(touchesTransactionState)) {
    return result('session', verb, {
      allowedInReadOnly: false,
      transactionControl: 'set-transaction',
      alwaysRefuse: txMessage(),
      reason: txMessage(),
    });
  }
  const implicitCommit = body[0]?.t === 'w' && body[0].v === 'PASSWORD';
  const refuse = refusal(msg().setOnly);

  const userVars = parts.every((p) => {
    const [a, b, c] = p;
    return a?.t === 'v' && !a.v.startsWith('@@') && a.v.length > 1 && b?.t === 'p' && ((b.v === '=' && c !== undefined) || (b.v === ':' && p[2]?.v === '=' && p[3] !== undefined));
  });
  let ok = body.length > 0 && userVars;
  if (!ok && parts.length === 1) {
    const p = parts[0]!;
    // only utf8mb4: another client character set makes the server split strings and comments elsewhere
    if (p[0]?.t === 'w' && p[0].v === 'NAMES') {
      // NAMES utf8mb4 [COLLATE utf8mb4_…]
      ok = (p.length === 2 && isSafeCharset(p[1])) || (p.length === 4 && isSafeCharset(p[1]) && p[2]?.v === 'COLLATE' && isSafeCollation(p[3]));
    } else if (p[0]?.t === 'w' && p[0].v === 'CHARACTER' && p[1]?.v === 'SET') {
      ok = p.length === 3 && isSafeCharset(p[2]);
    } else if (p[0]?.t === 'w' && p[0].v === 'CHARSET') {
      ok = p.length === 2 && isSafeCharset(p[1]);
    }
  }
  return result('session', verb, ok ? { allowedInReadOnly: true } : { allowedInReadOnly: false, reason: refuse, implicitCommit });
}

function classifyInner(statement: string, backslash: boolean): Classification {
  const tokens = tokenize(statement, backslash);
  let idx = 0;
  while (tokens[idx]?.t === 'p' && tokens[idx]!.v === '(') idx++;
  const first = tokens[idx];
  if (!first || first.t !== 'w') return result('other', '', { allowedInReadOnly: false, reason: notListed() });
  let verb = first.v;
  const second = tokens[idx + 1];
  const rest = tokens.slice(idx);

  if (verb === 'WITH') {
    const baseDepth = first.depth;
    const main = tokens.slice(idx + 1).find((tk) => tk.t === 'w' && tk.depth === baseDepth && DML_VERBS.has(tk.v));
    if (!main) return result('other', verb, { allowedInReadOnly: false, reason: notListed() });
    verb = main.v;
  }

  switch (verb) {
    case 'SELECT':
    case 'TABLE':
    case 'VALUES':
      void rest;
      return result('read', verb, { allowedInReadOnly: true });
    case 'INSERT':
    case 'REPLACE':
    case 'UPDATE':
    case 'DELETE':
      return result('write', verb, {
        allowedInReadOnly: false,
        reason: refusal(msg().changesData({ verb })),
      });
    case 'CALL':
    case 'EXECUTE':
      // what a procedure or a prepared statement runs is unknown here: it may commit (DDL inside)
      return result(verb === 'CALL' ? 'write' : 'other', verb, {
        allowedInReadOnly: false,
        implicitCommit: true,
        reason: verb === 'CALL' ? refusal(msg().changesData({ verb: 'CALL' })) : notListed(),
      });
    case 'LOAD':
      if (second?.v === 'INDEX') {
        return result('other', 'LOAD INDEX', { allowedInReadOnly: false, implicitCommit: true, reason: notListed() });
      }
      return result('write', verb, {
        allowedInReadOnly: false,
        reason: refusal(msg().changesData({ verb: 'LOAD' })),
      });
    case 'SHOW':
      // SHOW CREATE USER prints the account's password hash
      if (second?.v === 'CREATE' && tokens[idx + 2]?.t === 'w' && tokens[idx + 2]!.v === 'USER') {
        return result('read', verb, { allowedInReadOnly: true, accountSecrets: true });
      }
      return result('read', verb, { allowedInReadOnly: true });
    case 'HELP':
      return result('read', verb, { allowedInReadOnly: true });
    case 'USE':
      return result('session', verb, { allowedInReadOnly: true, changesDatabase: true });
    case 'DESCRIBE':
    case 'DESC':
    case 'EXPLAIN': {
      let k = idx + 1;
      let analyze = false;
      for (;;) {
        const tk = tokens[k];
        if (tk?.t === 'w' && tk.v === 'ANALYZE') {
          analyze = true;
          k++;
        } else if (tk?.t === 'w' && (tk.v === 'EXTENDED' || tk.v === 'PARTITIONS')) {
          k++;
        } else if (tk?.t === 'w' && tk.v === 'FORMAT' && tokens[k + 1]?.v === '=') {
          k += 3;
        } else break;
      }
      const target = tokens[k];
      const startsStatement =
        target !== undefined &&
        ((target.t === 'w' && (DML_VERBS.has(target.v) || target.v === 'WITH')) || (target.t === 'p' && target.v === '('));
      if (startsStatement) {
        const inner = classifyInner(statement.slice(target.pos), backslash);
                // Plain EXPLAIN only plans the statement; EXPLAIN ANALYZE executes it, so it must be a read.
        // MySQL refuses EXPLAIN of a write inside a read-only session, so the app refuses it too.
        const allowed = inner.kind === 'read' && inner.allowedInReadOnly;
        return result(analyze ? inner.kind : 'read', verb, {
          allowedInReadOnly: allowed,
          reason: allowed
            ? undefined
            : inner.kind === 'write'
              ? msg().explainWrite
              : refusal(msg().explainReadsOnly),
        });
      }
      if (analyze) {
        return result('read', verb, {
          allowedInReadOnly: false,
          reason: refusal(msg().explainAnalyzeReadsOnly),
        });
      }
      return result('read', verb, { allowedInReadOnly: true });
    }
    case 'SET':
      return classifySet(tokens, idx);
    case 'BEGIN':
      return result('transaction-control', verb, {
        allowedInReadOnly: false,
        transactionControl: 'begin',
        reason: refusal(msg().useTransactionMode),
      });
    case 'START':
      if (second?.v === 'TRANSACTION') {
        return result('transaction-control', verb, {
          allowedInReadOnly: false,
          transactionControl: 'begin',
          reason: refusal(msg().useTransactionMode),
        });
      }
      return result('other', verb, {
        allowedInReadOnly: false,
        implicitCommit: ['REPLICA', 'SLAVE', 'GROUP_REPLICATION'].includes(second?.v ?? ''),
        reason: notListed(),
      });
    case 'COMMIT':
    case 'ROLLBACK': {
      const body = tokens.slice(idx + 1);
      const release = body.some((tk, j) => tk.t === 'w' && tk.v === 'RELEASE' && body[j - 1]?.v !== 'NO');
      if (release) {
        const text = msg().release({ verb });
        return result('transaction-control', verb, { allowedInReadOnly: false, alwaysRefuse: text, reason: text });
      }
      if (verb === 'ROLLBACK' && second?.v === 'TO') {
        return result('transaction-control', verb, { allowedInReadOnly: false, reason: notListed() });
      }
      // AND CHAIN ends the transaction and opens the next one at once
      const chain = body.some((tk, j) => tk.t === 'w' && tk.v === 'CHAIN' && body[j - 1]?.v !== 'NO');
      if (chain) {
        return result('transaction-control', verb, {
          allowedInReadOnly: false,
          transactionControl: 'begin',
          reason: refusal(msg().chain({ verb })),
        });
      }
      return result('transaction-control', verb, {
        allowedInReadOnly: true,
        transactionControl: verb === 'COMMIT' ? 'commit' : 'rollback',
      });
    }
    case 'SAVEPOINT':
    case 'RELEASE':
      return result('transaction-control', verb, { allowedInReadOnly: false, reason: notListed() });
    default:
      break;
  }

  if (DDL_VERBS.has(verb)) {
    const temporary = (verb === 'CREATE' || verb === 'DROP') && second?.v === 'TEMPORARY';
    return result('ddl', verb, {
      allowedInReadOnly: false,
      implicitCommit: !temporary,
      reason: refusal(msg().changesStructure({ verb })),
    });
  }

  const s = second?.v;
  const implicit =
    ((verb === 'LOCK' || verb === 'UNLOCK') && (s === 'TABLES' || s === 'TABLE' || s === 'INSTANCE')) ||
    ((verb === 'ANALYZE' || verb === 'CHECK' || verb === 'OPTIMIZE' || verb === 'REPAIR') &&
      (s === 'TABLE' || s === 'NO_WRITE_TO_BINLOG' || s === 'LOCAL')) ||
    verb === 'FLUSH' ||
    verb === 'RESET' ||
    verb === 'CLONE' ||
    verb === 'XA' ||
    verb === 'SHUTDOWN' ||
    verb === 'INSTALL' ||
    verb === 'UNINSTALL' ||
    (verb === 'STOP' && ['REPLICA', 'SLAVE', 'GROUP_REPLICATION'].includes(s ?? '')) ||
    (verb === 'CHANGE' && ['REPLICATION', 'MASTER'].includes(s ?? '')) ||
    (verb === 'CACHE' && s === 'INDEX');
  return result('other', verb, { allowedInReadOnly: false, implicitCommit: implicit, reason: notListed() });
}

/**
 * Functions that change server state even inside a read-only transaction (replication failover sources,
 * keyring, firewall, audit log, version tokens, locking service, masking dictionaries) or wait on
 * replication. Refused in read-only.
 */
const SERVER_STATE_FUNCTION =
  /^(ASYNCHRONOUS_CONNECTION_FAILOVER_|INNODB_SET_OPEN_FILES_LIMIT$|INNODB_REDO_LOG_|MYSQLX_|GROUP_REPLICATION_|VERSION_TOKENS?_|KEYRING_|AUDIT_|MYSQL_FIREWALL_|SET_FIREWALL_|NORMALIZE_STATEMENT$|SERVICE_(GET_(READ|WRITE)_LOCKS|RELEASE_LOCKS)$|MASKING_DICTIONAR|GEN_DICTIONARY|SOURCE_POS_WAIT$|MASTER_POS_WAIT$|WAIT_FOR_EXECUTED_GTID_SET$|WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS$)/;

/** Words after which a name followed by "(" is a table or CTE with a column list, not a function call. */
const NOT_A_CALL = new Set(['INTO', 'TABLE', 'UPDATE', 'WITH', 'RECURSIVE', 'REFERENCES', 'REPLACE', 'INSERT']);

/**
 * Names right before "(" (words and quoted names), outside strings and comments: the functions a statement may
 * call. A name with a non-ASCII letter is kept as `#NON_ASCII:<name>`: the server matches function names
 * ignoring accents, so it may be any function.
 */
function calledFunctions(tokens: Token[]): string[] {
  const names = new Set<string>();
  // the CTE list of a WITH, before its main statement: "name (cols) AS (...)" is not a call
  const withHeaderEnd = tokens[0]?.t === 'w' && tokens[0].v === 'WITH'
    ? tokens.findIndex((tk, k) => k > 0 && tk.t === 'w' && tk.depth === tokens[0]!.depth && DML_VERBS.has(tk.v))
    : -1;
  tokens.forEach((tk, k) => {
    if (!(tk.t === 'w' || tk.t === 'i') || tokens[k + 1]?.t !== 'p' || tokens[k + 1]!.v !== '(') return;
    const before = tokens[k - 1];
    // only at the statement's own level: inside parentheses a name before "(" is always a call
    // (TRIM(x FROM f()), SUBSTRING(s FROM f())); FROM and JOIN never hide one
    if (before?.t === 'w' && NOT_A_CALL.has(before.v) && tk.depth === tokens[0]!.depth) return;
    if (before?.t === 'p' && before.v === ',' && k < withHeaderEnd && tk.depth === tokens[0]!.depth) return;
    const raw = tk.t === 'i' ? unquote(tk).replace(/``/g, '`') : tk.v;
    names.add(hasNonAscii(raw) ? `#NON_ASCII:${raw}` : asciiUpper(raw));
  });
  return [...names];
}

/** One reading of the statement (one string rule), with the danger scan. */
function classifyView(statement: string, backslash: boolean): Classification {
  const c = classifyInner(statement, backslash);
  const functions = calledFunctions(tokenize(statement, backslash));
  const state = functions.find((f) => SERVER_STATE_FUNCTION.test(f) || f.startsWith('#NON_ASCII:'));
  const out: Classification = { ...c, functions, ...(state ? { serverStateFunction: state } : {}) };
  if (out.allowedInReadOnly) {
    const danger = findDanger(statement);
    if (danger) return { ...out, allowedInReadOnly: false, reason: refusal(danger) };
    if (state) {
      const why = state.startsWith('#NON_ASCII:')
        ? msg().nonAsciiFunction({ name: state.slice(11) })
        : msg().serverStateFunction({ name: state });
      return { ...out, allowedInReadOnly: false, reason: refusal(why) };
    }
  }
  return out;
}

const versionedMessage = (): string => refusal(msg().versionedComment({ versioned: VERSIONED_SYNTAX, mariadb: MARIADB_SYNTAX }));
const executableMessage = (): string => refusal(msg().executableComment({ syntax: EXECUTABLE_SYNTAX }));

/**
 * Classifies one statement (as returned by `splitStatements`). The statement is read under both string rules
 * (backslash escapes on and off, as the server's sql_mode may say); when the two readings disagree, the
 * stricter one wins. Executable comments are refused in read-only: a versioned one may be skipped by the
 * server, so what runs may not be what was classified.
 */
export function classify(statement: string): Classification {
  const a = classifyView(statement, true);
  const b = classifyView(statement, false);
  let c: Classification = a;
  const same =
    a.kind === b.kind && a.verb === b.verb && a.allowedInReadOnly === b.allowedInReadOnly && a.implicitCommit === b.implicitCommit &&
    a.transactionControl === b.transactionControl && a.alwaysRefuse === b.alwaysRefuse;
  if (!same) {
    const strict = !a.allowedInReadOnly ? a : b;
    c = {
      ...a,
      allowedInReadOnly: a.allowedInReadOnly && b.allowedInReadOnly,
      implicitCommit: a.implicitCommit || b.implicitCommit,
      transactionControl: a.transactionControl ?? b.transactionControl,
      ...(a.alwaysRefuse ?? b.alwaysRefuse ? { alwaysRefuse: a.alwaysRefuse ?? b.alwaysRefuse } : {}),
      ...(strict.allowedInReadOnly ? {} : { reason: strict.reason ?? notListed() }),
    };
  }
  c.functions = [...new Set([...(a.functions ?? []), ...(b.functions ?? [])])];
  const state = a.serverStateFunction ?? b.serverStateFunction;
  if (state) c.serverStateFunction = state;
  if (a.accountSecrets || b.accountSecrets) c.accountSecrets = true;

  const facts = commentFacts(statement);
  if (facts.setVarHint) c.setVarHint = true;
  if (facts.versioned) {
    return { ...c, executableComment: 'versioned', allowedInReadOnly: false, implicitCommit: true, reason: versionedMessage() };
  }
  if (facts.executable) return { ...c, executableComment: 'plain', allowedInReadOnly: false, reason: executableMessage() };
  return c;
}

const sameTokens = (x: Token[], y: Token[]): boolean => x.length > 0 && x.length === y.length && x.every((tk, k) => tk.t === y[k]!.t && tk.v === y[k]!.v);
const isTruthyLiteral = (part: Token[]): boolean =>
  part.length === 1 && ((part[0]!.t === 'n' && Number(part[0]!.v) !== 0) || (part[0]!.t === 'w' && part[0]!.v === 'TRUE'));

/** A disjunct that is always true: `1`, `TRUE`, `x = x`, `1 = 1`, `'a' = 'a'`. */
function alwaysTrue(part: Token[]): boolean {
  let p = part;
  while (p.length >= 2 && p[0]!.v === '(' && p[p.length - 1]!.v === ')') p = p.slice(1, -1);
  if (isTruthyLiteral(p)) return true;
  const eq = p.findIndex((tk) => tk.t === 'p' && tk.v === '=' && tk.depth === p[0]!.depth);
  if (eq <= 0) return false;
  return sameTokens(p.slice(0, eq), p.slice(eq + 1));
}

function warningsView(statement: string, backslash: boolean): string[] {
  const tokens = tokenize(statement, backslash);
  let idx = 0;
  while (tokens[idx]?.t === 'p' && tokens[idx]!.v === '(') idx++;
  const first = tokens[idx];
  if (!first || first.t !== 'w') return [];
  let mainIndex = idx;
  if (first.v === 'WITH') {
    mainIndex = tokens.findIndex((tk, k) => k > idx && tk.t === 'w' && tk.depth === first.depth && DML_VERBS.has(tk.v));
    if (mainIndex === -1) return [];
  }
  const main = tokens[mainIndex]!;
  if (main.v !== 'UPDATE' && main.v !== 'DELETE') return [];
  const where = tokens.findIndex((tk, k) => k > mainIndex && tk.t === 'w' && tk.v === 'WHERE' && tk.depth === main.depth);
  if (where === -1) return [m().dialect.warning.noWhere({ verb: main.v })];
  // the condition, up to ORDER BY / LIMIT at the statement's own level, split at its top-level ORs
  const cond: Token[] = [];
  for (const tk of tokens.slice(where + 1)) {
    if (tk.depth === main.depth && tk.t === 'w' && (tk.v === 'ORDER' || tk.v === 'LIMIT')) break;
    cond.push(tk);
  }
  const parts: Token[][] = [[]];
  for (const tk of cond) {
    if (tk.depth === main.depth && ((tk.t === 'w' && tk.v === 'OR') || (tk.t === 'p' && tk.v === '|' ))) parts.push([]);
    else parts[parts.length - 1]!.push(tk);
  }
  return parts.some(alwaysTrue) ? [m().dialect.warning.alwaysTrue({ verb: main.v })] : [];
}

/**
 * Alerts shown in the agent approval modal: UPDATE or DELETE with no WHERE at the statement's own level, or with a
 * WHERE that is always true. Read under both string rules; executable comments get their own alert.
 */
export function warnings(statement: string): string[] {
  const facts = commentFacts(statement);
  const texts = facts.versioned ? [statement, withoutVersionedComments(statement, true), withoutVersionedComments(statement, false)] : [statement];
  const out = new Set(texts.flatMap((text) => [...warningsView(text, true), ...warningsView(text, false)]));
  if (facts.versioned || facts.executable) out.add(m().dialect.warning.executableComment({ syntax: EXECUTABLE_SYNTAX }));
  return [...out];
}

/** Identifier-like tokens: bare words and backtick-quoted names, lower-cased (qualifiers are separate tokens). */
export function identifiers(statement: string): string[] {
  const names = new Set<string>();
  for (const tk of [...tokenize(statement, true), ...tokenize(statement, false)]) {
    if (tk.t === 'w') names.add(tk.v.toLowerCase());
    else if (tk.t === 'i') names.add(tk.v.slice(1, -1).replace(/``/g, '`').toLowerCase());
  }
  return [...names];
}
