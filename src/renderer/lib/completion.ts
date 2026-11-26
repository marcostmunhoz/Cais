// The editor's schema completion: columns of the tables the statement reads, tables, databases, aliases. The
// language (lang-sql) only supplies the keywords; the names come from here so a position gets what it is waiting for
// (see shared/completion.ts). No DOM and no i18n import: the words come in, so a unit test can run it on an EditorState.
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Text } from '@codemirror/state';
import { completionCandidates, type Candidate, type CandidateKind, type CandidateWords } from '@shared/completion';
import { completionContext } from '@shared/dialects/scope';
import type { Dialect, SqlStatement } from '@shared/dialects/types';
import type { SchemaTree } from '@shared/results';

export interface SchemaCompletionSetup {
  dialect: Dialect;
  tree: SchemaTree | undefined;
  database: string | null;
  words: CandidateWords;
}

/** The lezer nodes in which a name is never completed. */
const QUIET = new Set(['String', 'LineComment', 'BlockComment', 'Bytes', 'Bits']);

const TYPES: Record<CandidateKind, string> = { database: 'namespace', table: 'class', view: 'class', column: 'property', alias: 'constant' };

const statementCache = new WeakMap<Text, SqlStatement[]>();

/** The statements of the document, split once per document value (every keystroke is a new one). */
export function statementsOf(state: EditorState, dialect: Dialect): SqlStatement[] {
  let statements = statementCache.get(state.doc);
  if (!statements) {
    statements = dialect.splitStatements(state.doc.toString());
    statementCache.set(state.doc, statements);
  }
  return statements;
}

const trailing = /^\s*(--|#|\/\*)/;

/**
 * The statement the cursor is typing in, or null when it is between two (after the delimiter that ended one, or in
 * the blank space before the first). The text runs up to the cursor when that is past the statement's last word:
 * `SELECT * FROM t WHERE |` has the cursor in the blanks the statement's range leaves out.
 */
export function statementAround(state: EditorState, dialect: Dialect, pos: number): { text: string; start: number } | null {
  const statements = statementsOf(state, dialect);
  let found: SqlStatement | undefined;
  for (const s of statements) if (s.start <= pos) found = s;
  if (!found) return null;
  if (pos > found.end) {
    const rest = state.sliceDoc(found.end, found.rangeEnd);
    const delimited = found.rangeEnd > found.end && rest.trim() !== '' && !trailing.test(rest);
    // after the delimiter the cursor starts a new statement
    if (delimited && pos >= found.rangeEnd) return null;
  }
  return { text: state.sliceDoc(found.start, Math.max(found.end, pos)), start: found.start };
}

const SIMPLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A name as it is written in a statement: quoted when it is not a plain word or when it is a word the language reserves. */
function written(dialect: Dialect, name: string, reserved: ReadonlySet<string>): string {
  return SIMPLE_NAME.test(name) && !reserved.has(name.toUpperCase()) ? name : dialect.quoteIdent(name);
}

/** What is inside the quotes of a quoted name. */
const inside = (dialect: Dialect, name: string): string => dialect.quoteIdent(name).slice(1, -1);

function toCompletion(c: Candidate, dialect: Dialect, reserved: ReadonlySet<string>, quote: { char: string; closed: boolean } | null): Completion {
  const apply = quote
    ? c.parts.map((p) => inside(dialect, p)).join(`${quote.char}.${quote.char}`) + (quote.closed ? '' : quote.char)
    : c.parts.map((p) => written(dialect, p, reserved)).join('.');
  return {
    label: c.label,
    type: TYPES[c.kind],
    ...(c.detail ? { detail: c.detail } : {}),
    boost: c.boost,
    ...(apply !== c.label ? { apply } : {}),
  };
}

/** The completion source for a dialect and the schema tree of the environment (undefined while it loads). */
export function schemaCompletion(setup: SchemaCompletionSetup): CompletionSource {
  const { dialect, tree, database, words } = setup;
  const reserved = new Set(dialect.keywords.map((k) => k.toUpperCase()));
  return (context: CompletionContext): CompletionResult | null => {
    const { state, pos } = context;
    if (QUIET.has(syntaxTree(state).resolveInner(pos, -1).name)) return null;
    const around = statementAround(state, dialect, pos);
    const text = around?.text ?? '';
    const start = around?.start ?? pos;
    const analysis = dialect.analyze(text);
    const offset = pos - start;
    const where = completionContext(analysis, offset);
    // nothing typed: only after a dot, or when the person asked for the list
    if (where.typed === '' && where.qualifier.length === 0 && !context.explicit) return null;
    const candidates = completionCandidates({ tree, database, analysis, offset, words });
    if (candidates.length === 0) return null;
    return {
      from: start + where.from,
      options: candidates.map((c) => toCompletion(c, dialect, reserved, where.quote)),
      validFor: /^\w*$/,
    };
  };
}
