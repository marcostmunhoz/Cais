import type { Classification } from '../types';
import type { StatementKind } from '../../results';
import { m } from '../../i18n';
import { asciiUpper, lex, nameParts, type Tok } from './lexer';

const bq = () => m().dialect.bigquery.classify;
/** Every refusal reads "Somente leitura: <what>", like the MySQL dialect's. */
const refusal = (what: string): string => m().dialect.classify.readOnly({ what });

/** Verbs by class (the first word of a statement, after any parentheses). */
const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE']);
const DDL_VERBS = new Set(['CREATE', 'ALTER', 'DROP', 'UNDROP']);
/** Control flow and variables: a script (or a piece of one). */
const SCRIPT_VERBS = new Set(['DECLARE', 'SET', 'IF', 'ELSEIF', 'ELSE', 'LOOP', 'WHILE', 'REPEAT', 'UNTIL', 'FOR', 'CASE', 'BREAK', 'LEAVE', 'CONTINUE', 'ITERATE', 'RETURN', 'RAISE', 'EXCEPTION', 'END']);

/**
 * Built-in functions that live in a namespace (`NET.HOST`, `AEAD.ENCRYPT`...): such a call is not a function defined
 * in the project. `SAFE.` is a prefix to any function (`SAFE.ML.PREDICT`, `SAFE.my_ds.fn`): it is taken off before
 * the name is judged. `ML.` and `AI.` are built in too, but they can call remote models and cost more than the
 * bytes read, so they are listed apart in `remoteCalls`. `DLP_*` (unqualified) call Cloud DLP.
 * The judgement is by the full name, not by the namespace: `net`, `keys`, `obj` and `bq` are valid dataset names,
 * and `net.myfn(x)` is that dataset's routine (maybe a remote function), so only a documented built-in passes. The
 * first part must be unquoted and the name must have exactly two parts. `BQ.` has procedures only (`CALL BQ.…`).
 */
const BUILTIN_FUNCTIONS = new Set([
  'NET.HOST', 'NET.PUBLIC_SUFFIX', 'NET.REG_DOMAIN', 'NET.IP_FROM_STRING', 'NET.SAFE_IP_FROM_STRING', 'NET.IP_TO_STRING',
  'NET.IP_NET_MASK', 'NET.IP_TRUNC', 'NET.IPV4_FROM_INT64', 'NET.IPV4_TO_INT64',
  'AEAD.ENCRYPT', 'AEAD.DECRYPT_BYTES', 'AEAD.DECRYPT_STRING',
  'KEYS.NEW_KEYSET', 'KEYS.ADD_KEY_FROM_RAW_BYTES', 'KEYS.KEYSET_CHAIN', 'KEYS.KEYSET_FROM_JSON', 'KEYS.KEYSET_TO_JSON',
  'KEYS.ROTATE_KEYSET', 'KEYS.KEYSET_LENGTH', 'KEYS.NEW_WRAPPED_KEYSET', 'KEYS.REWRAP_KEYSET', 'KEYS.ROTATE_WRAPPED_KEYSET',
  'HLL_COUNT.INIT', 'HLL_COUNT.MERGE', 'HLL_COUNT.MERGE_PARTIAL', 'HLL_COUNT.EXTRACT',
  'KLL_QUANTILES.INIT_INT64', 'KLL_QUANTILES.INIT_FLOAT64', 'KLL_QUANTILES.MERGE_PARTIAL', 'KLL_QUANTILES.MERGE_INT64',
  'KLL_QUANTILES.MERGE_FLOAT64', 'KLL_QUANTILES.MERGE_POINT_INT64', 'KLL_QUANTILES.MERGE_POINT_FLOAT64',
  'KLL_QUANTILES.EXTRACT_INT64', 'KLL_QUANTILES.EXTRACT_FLOAT64', 'KLL_QUANTILES.EXTRACT_POINT_INT64',
  'KLL_QUANTILES.EXTRACT_POINT_FLOAT64',
  'VECTOR_INDEX.STATISTICS',
]);
const REMOTE_NAMESPACES = new Set(['ML', 'AI']);

/** Words that can be followed by "(" without being a call. */
const NOT_A_CALL = new Set([
  'IN', 'AS', 'FROM', 'JOIN', 'ON', 'USING', 'AND', 'OR', 'NOT', 'WHERE', 'SELECT', 'WITH', 'UNION', 'ALL', 'ANY', 'SOME', 'EXISTS',
  'OVER', 'BY', 'HAVING', 'INTERSECT', 'EXCEPT', 'DISTINCT', 'LIMIT', 'OFFSET', 'WHEN', 'THEN', 'ELSE', 'CASE', 'WINDOW', 'PARTITION',
  'ORDER', 'GROUP', 'QUALIFY', 'LATERAL', 'TABLESAMPLE', 'RECURSIVE', 'INTO', 'VALUES', 'SET', 'IS', 'LIKE', 'BETWEEN', 'AT', 'OF', 'TO',
  'ROWS', 'WITHIN', 'GROUPS', 'RETURN',
]);

const isPunct = (t: Tok | undefined, p: string): boolean => t !== undefined && t.kind === 'punct' && t.text === p;
const isWord = (t: Tok | undefined, w?: string): boolean => t !== undefined && t.kind === 'word' && (w === undefined || asciiUpper(t.text) === w);
const isName = (t: Tok | undefined): boolean => t !== undefined && (t.kind === 'word' || t.kind === 'ident');

interface Path {
  parts: string[];
  /** The tokens the path is made of (a quoted name counts once, even if it holds a whole path). */
  first: number;
  last: number;
  /** The first part was written without backticks. */
  bareFirst: boolean;
}

/** Runs of names joined by dots (`a.b`, `a . b`, `` `a.b`.c ``): the paths of the statement. */
function paths(tokens: Tok[]): Path[] {
  const out: Path[] = [];
  let k = 0;
  while (k < tokens.length) {
    const tk = tokens[k]!;
    if (!isName(tk) || isPunct(tokens[k - 1], '.')) {
      k++;
      continue;
    }
    const parts = [...nameParts(tk)];
    let last = k;
    while (isPunct(tokens[last + 1], '.') && isName(tokens[last + 2])) {
      parts.push(...nameParts(tokens[last + 2]!));
      last += 2;
    }
    out.push({ parts, first: k, last, bareFirst: tk.kind === 'word' });
    k = last + 1;
  }
  return out;
}

/** Words after which a name may be written with dashes (`my-project.ds.t`): the places a table path goes. */
const TABLE_CONTEXT = new Set(['FROM', 'JOIN', 'TABLE', 'INTO', 'UPDATE', 'MERGE', 'TRUNCATE', 'CLONE', 'COPY', 'VIEW', 'USING']);

/**
 * Names of the statement with dashes joined where a table path may have them (`my-project`, `region-us`): only
 * used to match against the schema, never to decide anything.
 */
function dashedNames(tokens: Tok[]): string[] {
  const names: string[] = [];
  let sawFrom = false;
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k]!;
    if (isWord(tk, 'FROM')) sawFrom = true;
    if (tk.kind !== 'word') continue;
    const before = tokens[k - 1];
    const inTablePlace = (isWord(before) && TABLE_CONTEXT.has(asciiUpper(before!.text))) || (isPunct(before, ',') && sawFrom) || isPunct(before, '.');
    if (!inTablePlace) continue;
    let name = tk.text;
    let j = k;
    while (isPunct(tokens[j + 1], '-') && tokens[j + 1]!.pos === tokens[j]!.end && (tokens[j + 2]?.kind === 'word' || tokens[j + 2]?.kind === 'number') && tokens[j + 2]!.pos === tokens[j + 1]!.end) {
      name += `-${tokens[j + 2]!.text}`;
      j += 2;
    }
    if (j !== k) names.push(name);
  }
  return names;
}

/** The leading words of the statement after any "(": the verb, and the index of the token after it. */
function head(tokens: Tok[]): { verb: string; at: number; parens: number } {
  let at = 0;
  while (isPunct(tokens[at], '(')) at++;
  const t = tokens[at];
  const verb = t === undefined ? '' : t.kind === 'word' ? asciiUpper(t.text) : t.text.toUpperCase();
  return { verb, at, parens: at };
}

/**
 * The verb that decides what a WITH statement is: after `WITH [RECURSIVE] name AS ( … ) [, name AS ( … )]`, the
 * word that starts the main query. Null when the text does not have that shape.
 */
function withMain(tokens: Tok[], from: number): string | null {
  let k = from;
  if (isWord(tokens[k], 'RECURSIVE')) k++;
  for (;;) {
    if (!isName(tokens[k])) return null;
    k++;
    if (!isWord(tokens[k], 'AS') || !isPunct(tokens[k + 1], '(')) return null;
    k++;
    let depth = 0;
    for (; k < tokens.length; k++) {
      if (isPunct(tokens[k], '(')) depth++;
      else if (isPunct(tokens[k], ')') && --depth === 0) break;
    }
    if (k >= tokens.length) return null;
    k++;
    if (isPunct(tokens[k], ',')) {
      k++;
      continue;
    }
    break;
  }
  const next = tokens[k];
  if (next === undefined) return null;
  if (isPunct(next, '(')) {
    const h = head(tokens.slice(k));
    return h.verb === 'WITH' ? withMain(tokens, k + h.at + 1) : h.verb;
  }
  return next.kind === 'word' ? asciiUpper(next.text) : null;
}

interface Facts {
  functions: string[];
  remoteCalls: string[];
  externalQuery: boolean;
  jobsMetadata: boolean;
  legacyDirective: boolean;
}

function facts(all: Tok[], tokens: Tok[]): Facts {
  const functions = new Set<string>();
  const remote = new Set<string>();
  let externalQuery = false;
  let jobsMetadata = false;
  for (const p of paths(tokens)) {
    const upper = p.parts.map(asciiUpper);
    if (upper.some((x) => x === 'EXTERNAL_QUERY')) externalQuery = true;
    for (let i = 0; i + 1 < upper.length; i++) {
      if (upper[i] === 'INFORMATION_SCHEMA' && /^(JOB|SESSION)/.test(upper[i + 1]!)) jobsMetadata = true;
    }
    if (!isPunct(tokens[p.last + 1], '(')) continue;
    const single = upper.length === 1;
    if (single && NOT_A_CALL.has(upper[0]!) && tokens[p.first]!.kind === 'word') continue;
    functions.add(upper.join('.'));
    const eff = upper[0] === 'SAFE' && upper.length > 1 ? upper.slice(1) : upper;
    const bareEff = upper[0] === 'SAFE' && upper.length > 1 ? false : p.bareFirst;
    if (eff.length === 1) {
      if (eff[0]!.startsWith('DLP_')) remote.add(upper.join('.'));
      continue;
    }
    if (REMOTE_NAMESPACES.has(eff[0]!)) remote.add(upper.join('.'));
    else if (!(eff.length === 2 && BUILTIN_FUNCTIONS.has(eff.join('.')) && (bareEff || upper[0] === 'SAFE'))) remote.add(upper.join('.'));
  }
  const legacyDirective = all.some((t) => t.kind === 'comment' && /^#\s*(legacysql|standardsql)/i.test(t.text));
  return { functions: [...functions], remoteCalls: [...remote], externalQuery, jobsMetadata, legacyDirective };
}

function make(kind: StatementKind, verb: string, allowed: boolean, extra: Partial<Classification>): Classification {
  return { kind, verb, allowedInReadOnly: allowed, implicitCommit: false, transactionControl: null, ...extra };
}

const signature = (tokens: Tok[]): string => JSON.stringify(tokens.map((t) => [t.kind, t.pos, t.end, t.closed]));

/**
 * Classifies one statement (as returned by `splitStatements`). Only a query passes in read-only: it starts with
 * SELECT, WITH (followed by a query), FROM (pipe syntax) or parentheses that lead to one; it has no `;` besides a
 * last one; it carries no `#legacySQL` or `#standardSQL` directive and does not call EXTERNAL_QUERY. When the text
 * has a string, name or comment with no end, or reads differently if a backslash does or does not escape in a raw
 * string or between backticks, it is refused. When in doubt, refuse.
 */
export function classify(statement: string): Classification {
  const withEsc = lex(statement, true);
  const withoutEsc = lex(statement, false);
  const tokens = withEsc.filter((t) => t.kind !== 'comment');
  const unreadable = withEsc.some((t) => !t.closed) || withoutEsc.some((t) => !t.closed) || signature(withEsc) !== signature(withoutEsc);
  const f = facts(withEsc, tokens);
  const extra: Partial<Classification> = {
    functions: f.functions,
    ...(f.remoteCalls.length ? { remoteCalls: f.remoteCalls } : {}),
    ...(f.externalQuery ? { externalQuery: true } : {}),
    ...(f.jobsMetadata ? { jobsMetadata: true } : {}),
    ...(f.legacyDirective ? { legacyDirective: true } : {}),
  };

  // a single `;` at the very end belongs to the statement; any other `;` makes it more than one command
  const semis = tokens.map((t, k) => (isPunct(t, ';') ? k : -1)).filter((k) => k !== -1);
  const trailing = semis.length > 0 && semis[semis.length - 1] === tokens.length - 1;
  const multiple = semis.length > (trailing ? 1 : 0);
  const body = trailing ? tokens.slice(0, -1) : tokens;

  const { verb: first, at } = head(body);
  const label = isName(body[0]) && isPunct(body[1], ':');
  let verb = first;
  let kind: StatementKind = 'other';
  let transactionControl: Classification['transactionControl'] = null;
  let what: string;

  const rest = (n: number): Tok[] => body.slice(n);
  const justTransaction = (from: number): boolean => rest(from).length === 0 || (rest(from).length === 1 && isWord(rest(from)[0], 'TRANSACTION'));

  if (body.length === 0) {
    return make('other', '', false, { ...extra, reason: refusal(bq().empty) });
  }
  if (label) {
    what = bq().script;
    verb = 'LABEL';
  } else if (first === 'SELECT' || first === 'FROM') {
    kind = 'read';
    what = '';
  } else if (first === 'WITH') {
    const main = withMain(body, at + 1);
    if (main === 'SELECT' || main === 'FROM' || main === '(') {
      kind = 'read';
      what = '';
    } else if (main !== null && WRITE_VERBS.has(main)) {
      kind = 'write';
      verb = main;
      what = bq().changesData({ verb: main });
    } else {
      what = bq().other({ verb: 'WITH' });
    }
  } else if (WRITE_VERBS.has(first)) {
    kind = 'write';
    what = bq().changesData({ verb: first });
  } else if (DDL_VERBS.has(first)) {
    kind = 'ddl';
    what = bq().changesStructure({ verb: first });
  } else if (at === 0 && first === 'BEGIN' && justTransaction(1)) {
    kind = 'transaction-control';
    transactionControl = 'begin';
    what = bq().transaction;
  } else if (at === 0 && first === 'START' && isWord(body[1], 'TRANSACTION') && body.length === 2) {
    kind = 'transaction-control';
    transactionControl = 'begin';
    what = bq().transaction;
  } else if (at === 0 && first === 'COMMIT' && justTransaction(1)) {
    kind = 'transaction-control';
    transactionControl = 'commit';
    what = bq().transaction;
  } else if (at === 0 && first === 'ROLLBACK' && justTransaction(1)) {
    kind = 'transaction-control';
    transactionControl = 'rollback';
    what = bq().transaction;
  } else if (first === 'BEGIN' || SCRIPT_VERBS.has(first)) {
    what = bq().script;
  } else {
    what = bq().other({ verb: first || '?' });
  }

  const out = make(kind, verb, false, { ...extra, transactionControl });
  if (kind !== 'read') {
    out.reason = refusal(what);
    return out;
  }
  // a query: the reasons that still refuse it
  if (f.legacyDirective) return { ...out, reason: refusal(bq().legacyDirective) };
  if (f.externalQuery) return { ...out, reason: refusal(bq().externalQuery) };
  if (unreadable) return { ...out, reason: refusal(bq().unreadable) };
  if (multiple) return { ...out, reason: refusal(bq().multiple) };
  return { ...out, allowedInReadOnly: true };
}

/** Always empty: BigQuery is read-only here, so nothing runs that needs a warning. */
export function warnings(_statement: string): string[] {
  return [];
}

/**
 * Lower-case names the statement mentions, for matching against the schema: every word and every part of a
 * quoted name (`proj.ds.t` gives proj, ds and t), and the dashed names a table path may have (`meu-projeto`).
 */
export function identifiers(statement: string): string[] {
  const names = new Set<string>();
  for (const escapes of [true, false]) {
    const tokens = lex(statement, escapes).filter((t) => t.kind !== 'comment');
    for (const tk of tokens) {
      if (tk.kind === 'word') names.add(tk.text.toLowerCase());
      else if (tk.kind === 'ident') for (const part of nameParts(tk)) names.add(part.toLowerCase());
    }
    for (const dashed of dashedNames(tokens)) names.add(dashed.toLowerCase());
  }
  return [...names];
}
