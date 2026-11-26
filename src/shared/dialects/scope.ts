/**
 * What a statement says about the tables it reads, for the editor's completion: which tables (and under which alias)
 * a position can see, and what the position is waiting for (a table, a column, a keyword).
 *
 * The reading is made on tokens, never on a parse tree: the statement the person is typing is almost always
 * incomplete (`SELECT a FROM t WHERE x = 1 AND `), and a grammar gives up there. Each engine turns its text into
 * `ScopeToken`s with its own lexer and passes the rules of its quoted names; everything else is shared. When in
 * doubt a table is left out: a missing column is better than a column of the wrong table.
 *
 * Reads: FROM and JOIN lists (comma, aliases with or without AS, `db.table`, backticked paths), the target of
 * UPDATE, INSERT/REPLACE INTO and DELETE ... USING, and the nesting of subqueries (a subquery sees the tables of the
 * query around it, a derived table or a CTE body does not, UNION arms are apart). It does not read the columns of
 * a derived table or of a CTE: they have no schema to complete from.
 */

export type ScopeTokenKind = 'word' | 'quoted' | 'punct' | 'other';

export interface ScopeToken {
  kind: ScopeTokenKind;
  /** The text as written (a quoted name keeps its quotes). */
  text: string;
  /** Words: the text in ASCII upper case. Other kinds: empty. */
  upper: string;
  pos: number;
  end: number;
}

/** A table named in the statement: the last two parts of its path (`db.table`, `table`) and the alias it was given. */
export interface TableRef {
  path: string[];
  alias: string | null;
  /** Offset of the first token of the name. */
  pos: number;
}

export interface ScopeBlock {
  /** The block holds the offsets after `start` and up to `end`. The outermost block starts at -1. */
  start: number;
  end: number;
  /** Index of the block around this one, or -1. */
  parent: number;
  tables: TableRef[];
  /** The tables of the blocks around are visible here (false for a derived table and a CTE body). */
  sees: boolean;
}

export interface ScopeAnalysis {
  tokens: ScopeToken[];
  blocks: ScopeBlock[];
  rules: ScopeRules;
}

export interface ScopeRules {
  /** The parts of what a quoted name holds, without its quotes: one for MySQL, several for a BigQuery path in backticks. */
  decodeQuoted(content: string): string[];
}

/** A table (with the block it was read in) a position can see; `depth` 0 is the innermost query. */
export interface VisibleTable {
  ref: TableRef;
  depth: number;
}

const STOP = new Set(
  (
    'WHERE GROUP HAVING ORDER LIMIT UNION INTERSECT EXCEPT JOIN INNER LEFT RIGHT FULL CROSS NATURAL STRAIGHT_JOIN ON USING SET ' +
    'VALUES VALUE SELECT FOR WINDOW PARTITION USE IGNORE FORCE INTO LOCK FETCH OFFSET QUALIFY WITH LATERAL TABLESAMPLE PIVOT ' +
    'UNPIVOT RETURNING OUTER AS OVER AND OR NOT WHEN THEN ELSE END FROM UPDATE DELETE INSERT REPLACE DUPLICATE ONLY'
  ).split(' '),
);
/** Words that end the list of tables a FROM, JOIN or UPDATE opened. */
const LIST_END = new Set(
  'WHERE GROUP HAVING ORDER LIMIT UNION INTERSECT EXCEPT SET WINDOW QUALIFY FOR SELECT VALUES VALUE RETURNING OFFSET FETCH LOCK INTO ON'.split(
    ' ',
  ),
);
/** Statements whose FROM does not name a table the statement reads. */
const NO_FROM = new Set(['SHOW', 'REVOKE', 'PREPARE', 'FETCH', 'HELP']);
/** A word before UPDATE, INSERT and REPLACE that says they begin a statement. */
const STATEMENT_START = new Set(['EXPLAIN', 'ANALYZE']);
/** The first words that only prefix the real verb: `WITH x AS (...) UPDATE ...`, `EXPLAIN DELETE ...`. */
const PREFIX_VERBS = new Set(['WITH', 'EXPLAIN', 'ANALYZE']);
const VERBS = new Set(['SELECT', 'UPDATE', 'DELETE', 'INSERT', 'REPLACE']);
const INSERT_MODIFIERS = new Set(['LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY', 'IGNORE']);

/** What a quoted token holds between its quotes (an unclosed one has only the opening quote to drop). */
const contentOf = (t: ScopeToken): string => t.text.slice(1, t.text.length >= 2 && t.text[t.text.length - 1] === t.text[0] ? -1 : undefined);
const nameParts = (t: ScopeToken, rules: ScopeRules): string[] => (t.kind === 'quoted' ? rules.decodeQuoted(contentOf(t)) : [t.text]);

const isName = (t: ScopeToken | undefined): t is ScopeToken => t !== undefined && (t.kind === 'word' || t.kind === 'quoted');
const isPunct = (t: ScopeToken | undefined, p: string): boolean => t !== undefined && t.kind === 'punct' && t.text === p;
const isWord = (t: ScopeToken | undefined, w: string): boolean => t !== undefined && t.kind === 'word' && t.upper === w;

interface Frame {
  block: number;
  /** A parenthesis that is not a query: a call, a list, an expression. FROM and JOIN mean nothing in it. */
  plain: boolean;
  /** The first word of the statement (or of the subquery) this frame is in. */
  verb: string;
  hasSelect: boolean;
  /** After FROM, JOIN or UPDATE: a comma starts another table. */
  listActive: boolean;
}

/** Reads the tables out of the tokens of one statement. `length` is the text length (the outermost block's end). */
export function analyzeScope(tokens: ScopeToken[], length: number, rules: ScopeRules): ScopeAnalysis {
  const blocks: ScopeBlock[] = [{ start: -1, end: length, parent: -1, tables: [], sees: true }];
  const stack: Frame[] = [{ block: 0, plain: false, verb: '', hasSelect: false, listActive: false }];

  const parts = (t: ScopeToken): string[] => nameParts(t, rules);

  /** Reads one table factor starting at token `i`; returns the index to go on from. */
  const factor = (i: number, frame: Frame, withAlias: boolean): number => {
    let j = i;
    if (isWord(tokens[j], 'ONLY') || isWord(tokens[j], 'LATERAL')) j++;
    const first = tokens[j];
    if (!isName(first) || (first.kind === 'word' && STOP.has(first.upper))) return j;
    const path = [...parts(first)];
    const pos = first.pos;
    j++;
    while (isPunct(tokens[j], '.') && isName(tokens[j + 1])) {
      path.push(...parts(tokens[j + 1]!));
      j += 2;
    }
    // in a FROM list a name followed by "(" is a function (UNNEST, JSON_TABLE): not a table (an INSERT target is followed by its columns)
    if (withAlias && isPunct(tokens[j], '(')) return j;
    let alias: string | null = null;
    if (withAlias) {
      const next = tokens[j];
      if (isWord(next, 'AS') && isName(tokens[j + 1])) {
        alias = parts(tokens[j + 1]!)[0] ?? null;
        j += 2;
      } else if (isName(next) && !(next.kind === 'word' && STOP.has(next.upper))) {
        alias = parts(next)[0] ?? null;
        j++;
      }
    }
    blocks[frame.block]!.tables.push({ path: path.slice(-2), alias, pos });
    return j;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const frame = stack[stack.length - 1]!;
    const prev = tokens[i - 1];

    if (t.kind === 'punct') {
      if (t.text === '(') {
        const next = tokens[i + 1];
        if (isWord(next, 'SELECT') || isWord(next, 'WITH')) {
          // a derived table (FROM (SELECT ...) d) and a CTE body (WITH x AS (SELECT ...)) do not see the tables around them
          const derived = frame.listActive && !isWord(prev, 'LATERAL');
          const cte = !frame.listActive && isWord(prev, 'AS');
          blocks.push({ start: t.pos, end: length, parent: frame.block, tables: [], sees: !(derived || cte) });
          stack.push({ block: blocks.length - 1, plain: false, verb: '', hasSelect: false, listActive: false });
        } else {
          stack.push({ block: frame.block, plain: true, verb: frame.verb, hasSelect: false, listActive: false });
        }
      } else if (t.text === ')') {
        if (stack.length > 1) {
          const closed = stack.pop()!;
          if (closed.block !== stack[stack.length - 1]!.block) blocks[closed.block]!.end = t.pos;
        }
      } else if (t.text === ',' && frame.listActive && !frame.plain) {
        i = factor(i + 1, frame, true) - 1;
      } else if (t.text === ';') {
        frame.listActive = false;
      }
      continue;
    }
    if (t.kind !== 'word') continue;

    const startsStatement =
      prev === undefined || isPunct(prev, '(') || isPunct(prev, ')') || isPunct(prev, ';') || (prev.kind === 'word' && STATEMENT_START.has(prev.upper));
    // the verb of the statement: its first word, or the one after WITH / EXPLAIN
    if (frame.verb === '' || (startsStatement && PREFIX_VERBS.has(frame.verb) && VERBS.has(t.upper))) frame.verb = t.upper;
    if (frame.plain) continue;

    if (LIST_END.has(t.upper)) frame.listActive = false;

    switch (t.upper) {
      case 'SELECT':
        if (frame.hasSelect || frame.verb === 'INSERT' || frame.verb === 'REPLACE') {
          // another arm of a UNION, or the query an INSERT reads: a block beside the last one, not inside it
          const closing = blocks[frame.block]!;
          closing.end = t.pos;
          blocks.push({ start: t.pos - 1, end: length, parent: closing.parent, tables: [], sees: closing.sees });
          frame.block = blocks.length - 1;
          frame.listActive = false;
        }
        frame.hasSelect = true;
        break;
      case 'FROM':
        if (!NO_FROM.has(frame.verb) && !isWord(prev, 'DISTINCT')) {
          frame.listActive = true;
          i = factor(i + 1, frame, true) - 1;
        }
        break;
      case 'JOIN':
      case 'STRAIGHT_JOIN':
        frame.listActive = true;
        i = factor(i + 1, frame, true) - 1;
        break;
      case 'USING':
        if (frame.verb === 'DELETE' && !isPunct(tokens[i + 1], '(')) {
          frame.listActive = true;
          i = factor(i + 1, frame, true) - 1;
        }
        break;
      case 'UPDATE':
        if (startsStatement) {
          let j = i + 1;
          while (isWord(tokens[j], 'LOW_PRIORITY') || isWord(tokens[j], 'IGNORE')) j++;
          frame.listActive = true;
          i = factor(j, frame, true) - 1;
        }
        break;
      case 'INSERT':
      case 'REPLACE':
        if (startsStatement && !isPunct(tokens[i + 1], '(')) {
          let j = i + 1;
          while (INSERT_MODIFIERS.has(tokens[j]?.upper ?? '')) j++;
          if (isWord(tokens[j], 'INTO')) j++;
          i = factor(j, frame, false) - 1;
        }
        break;
      default:
        break;
    }
  }
  return { tokens, blocks, rules };
}

/** The tables a position sees, innermost query first. */
export function tablesAt(analysis: ScopeAnalysis, offset: number): VisibleTable[] {
  let best = 0;
  let bestStart = -2;
  analysis.blocks.forEach((b, index) => {
    if (b.start < offset && offset <= b.end && b.start > bestStart) {
      best = index;
      bestStart = b.start;
    }
  });
  const out: VisibleTable[] = [];
  let depth = 0;
  for (let index = best; index !== -1; ) {
    const block = analysis.blocks[index]!;
    for (const ref of block.tables) out.push({ ref, depth });
    if (!block.sees) break;
    index = block.parent;
    depth++;
  }
  return out;
}

/** Every table the statement names, in any query of it. */
export function allTables(analysis: ScopeAnalysis): TableRef[] {
  return analysis.blocks.flatMap((b) => b.tables);
}

/** What a position is waiting for: a table name, a column name, or something else (a keyword, an alias). */
export type Expectation = 'table' | 'column' | 'any';

export interface CompletionContext {
  /** The names before the dot being completed: `a.b.|` is ['a', 'b'] (a quoted name is decoded). Empty when not after a dot. */
  qualifier: string[];
  /** Start of the text being replaced and its end (the offset). */
  from: number;
  /** What the person has typed of the name so far, without any opening quote. */
  typed: string;
  /** The name being typed opened a quote. `closed`: the closing quote is already in the text, right after the offset. */
  quote: { char: string; closed: boolean } | null;
  expects: Expectation;
}

const COLUMN_CLAUSES = new Set(['WHERE', 'SELECT', 'SET', 'BY', 'ON', 'HAVING', 'VALUES']);
const TABLE_WORDS = new Set(['FROM', 'JOIN', 'STRAIGHT_JOIN', 'UPDATE', 'INTO', 'TABLE', 'USE', 'DESCRIBE', 'DESC', 'TRUNCATE', 'ONLY']);
const COLUMN_WORDS = new Set(
  (
    'SELECT DISTINCT WHERE ON HAVING BY SET AND OR XOR NOT WHEN THEN ELSE CASE IN IS LIKE BETWEEN EXISTS ALL ANY SOME USING QUALIFY ' +
    'DISTINCTROW ROLLUP PARTITION'
  ).split(' '),
);

/** The names joined by dots that end at token `at` (which is the "."): `a.b.` gives ['a', 'b']. */
function dotted(tokens: ScopeToken[], at: number, rules: ScopeRules): string[] {
  const out: string[] = [];
  let k = at;
  while (k >= 1 && isPunct(tokens[k], '.') && isName(tokens[k - 1])) {
    out.unshift(...nameParts(tokens[k - 1]!, rules));
    k -= 2;
  }
  return out;
}

const closedQuote = (t: ScopeToken): boolean => t.text.length >= 2 && t.text[t.text.length - 1] === t.text[0];

/** What is being typed at `offset` of the statement, and what is waiting to be typed. */
export function completionContext(analysis: ScopeAnalysis, offset: number): CompletionContext {
  const { tokens, rules } = analysis;
  // the last token that starts before the offset
  let index = -1;
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k]!.pos >= offset) break;
    index = k;
  }
  const cur = index === -1 ? undefined : tokens[index]!;
  if (cur && cur.kind === 'word' && cur.end >= offset) {
    const qualifier = dotted(tokens, index - 1, rules);
    const expects = qualifier.length > 0 ? 'column' : expectation(tokens, index - 1);
    return { qualifier, from: cur.pos, typed: cur.text.slice(0, offset - cur.pos), quote: null, expects };
  }
  if (cur && cur.kind === 'quoted' && (cur.end > offset || !closedQuote(cur))) {
    const closed = closedQuote(cur);
    const inner = cur.text.slice(1, offset - cur.pos);
    // a quoted path (BigQuery) completes its last part; the parts before it are the qualifier
    const decoded = rules.decodeQuoted(inner);
    const last = decoded[decoded.length - 1] ?? '';
    const qualifier = [...dotted(tokens, index - 1, rules), ...decoded.slice(0, -1)];
    const expects = qualifier.length > 0 ? 'column' : expectation(tokens, index - 1);
    return { qualifier, from: offset - last.length, typed: last, quote: { char: cur.text[0]!, closed }, expects };
  }
  const qualifier = dotted(tokens, index, rules);
  return { qualifier, from: offset, typed: '', quote: null, expects: qualifier.length > 0 ? 'column' : expectation(tokens, index) };
}

/** What follows token `at`: the nearest word says whether a table or a column is next. */
function expectation(tokens: ScopeToken[], at: number): Expectation {
  const prev = tokens[at];
  if (prev === undefined) return 'any';
  if (prev.kind === 'word') {
    if (TABLE_WORDS.has(prev.upper)) return 'table';
    if (COLUMN_WORDS.has(prev.upper)) return 'column';
    return 'any';
  }
  if (prev.kind === 'punct') {
    if (prev.text === ',') return listKind(tokens, at);
    if (prev.text === ';' || prev.text === ')' || prev.text === '.') return 'any';
    return 'column';
  }
  return 'any';
}

/** After a comma: the clause the list belongs to (FROM and UPDATE lists name tables, the others columns). */
function listKind(tokens: ScopeToken[], at: number): Expectation {
  let depth = 0;
  for (let k = at - 1; k >= 0; k--) {
    const t = tokens[k]!;
    if (t.kind === 'punct') {
      if (t.text === ')') depth++;
      else if (t.text === '(') {
        if (depth === 0) return 'column';
        depth--;
      }
      continue;
    }
    if (depth > 0 || t.kind !== 'word') continue;
    if (t.upper === 'FROM' || t.upper === 'UPDATE' || t.upper === 'JOIN') return 'table';
    if (COLUMN_CLAUSES.has(t.upper)) return 'column';
  }
  return 'column';
}
