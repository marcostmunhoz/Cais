/**
 * What the editor offers for a position of a statement: the columns of the tables the statement reads, the tables and
 * databases of the schema, in the order the position asks for (after FROM tables come first, after WHERE columns).
 * Pure: the editor feeds it the statement's scope (`dialects/scope.ts`) and the schema tree, and turns the candidates
 * into completions. Keywords are not here; the editor's language supplies them.
 */
import type { SchemaColumn, SchemaTable, SchemaTree } from './results';
import { completionContext, tablesAt, type ScopeAnalysis, type TableRef, type VisibleTable } from './dialects/scope';

export type CandidateKind = 'database' | 'table' | 'view' | 'column' | 'alias';

export interface Candidate {
  /** What is shown and matched against what the person typed. */
  label: string;
  /** The names that make up what is inserted, joined by dots and quoted by the editor where the engine needs it. */
  parts: string[];
  kind: CandidateKind;
  detail: string;
  boost: number;
}

/** The words of the details, in the interface's language. */
export interface CandidateWords {
  table: string;
  view: string;
  /** "banco" or "dataset", what the engine calls a database. */
  database: string;
}

export interface CandidateInput {
  tree: SchemaTree | undefined;
  /** The database (dataset) a name without one belongs to. */
  database: string | null;
  analysis: ScopeAnalysis;
  /** The cursor, as an offset in the text `analysis` was made from. */
  offset: number;
  words: CandidateWords;
}

// Added to the fuzzy score of the editor's completion, whose penalties are in the hundreds.
const FIRST = 90;
const OUTER_STEP = 30;
const ALIAS = 30;
const LOW = -30;

/** Exact name first; a case-insensitive one only when it is the only one (lower_case_table_names differs per server). */
export function byName<T extends { name: string }>(items: readonly T[], name: string): T | undefined {
  const exact = items.find((i) => i.name === name);
  if (exact) return exact;
  const loose = items.filter((i) => i.name.toLowerCase() === name.toLowerCase());
  return loose.length === 1 ? loose[0] : undefined;
}

export interface ResolvedTable {
  database: string;
  table: SchemaTable;
}

/** The table of the schema a name in the statement points to: `db.table`, or `table` in the current database. */
export function resolveTable(tree: SchemaTree | undefined, database: string | null, path: readonly string[]): ResolvedTable | undefined {
  if (!tree) return undefined;
  const [dbName, tableName] = path.length >= 2 ? [path[path.length - 2]!, path[path.length - 1]!] : [database, path[0]];
  if (dbName === null || dbName === undefined || tableName === undefined) return undefined;
  const db = byName(tree.databases, dbName);
  const table = db ? byName(db.tables, tableName) : undefined;
  return db && table ? { database: db.name, table } : undefined;
}

/** The names of the databases a statement's tables live in (a name without one belongs to `database`), as the tree spells them. */
export function referencedDatabases(tree: SchemaTree | undefined, database: string | null, refs: readonly TableRef[]): string[] {
  if (!tree) return [];
  const out = new Set<string>();
  for (const ref of refs) {
    const name = ref.path.length >= 2 ? ref.path[0]! : database;
    const db = name === null ? undefined : byName(tree.databases, name);
    if (db) out.add(db.name);
  }
  return [...out];
}

const columnDetail = (c: SchemaColumn): string => (c.key === 'PRI' ? `${c.type} · PK` : c.type);

function tableCandidates(db: { name: string; tables: SchemaTable[] }, words: CandidateWords, boost: number): Candidate[] {
  return db.tables.map((t) => ({
    label: t.name,
    parts: [t.name],
    kind: t.type === 'view' ? 'view' : 'table',
    detail: t.type === 'view' ? words.view : words.table,
    boost,
  }));
}

function columnCandidates(table: SchemaTable, boost: number): Candidate[] {
  return table.columns.map((c) => ({ label: c.name, parts: [c.name], kind: 'column', detail: columnDetail(c), boost }));
}

/** What a name before a dot stands for: an alias or table of the statement, a database, or a table of the current database. */
function qualified(input: CandidateInput, qualifier: readonly string[], visible: VisibleTable[]): Candidate[] {
  const { tree, database, words } = input;
  if (!tree) return [];
  if (qualifier.length === 1) {
    const name = qualifier[0]!;
    const aliased = byName(
      visible.filter((v) => v.ref.alias !== null).map((v) => ({ name: v.ref.alias!, ref: v.ref })),
      name,
    );
    if (aliased) {
      const resolved = resolveTable(tree, database, aliased.ref.path);
      return resolved ? columnCandidates(resolved.table, FIRST) : [];
    }
    // a table written without an alias answers to its own name
    const named = byName(
      visible.filter((v) => v.ref.alias === null).map((v) => ({ name: v.ref.path[v.ref.path.length - 1]!, ref: v.ref })),
      name,
    );
    if (named) {
      const resolved = resolveTable(tree, database, named.ref.path);
      if (resolved) return columnCandidates(resolved.table, FIRST);
    }
    const db = byName(tree.databases, name);
    if (db) return tableCandidates(db, words, FIRST);
    const inCurrent = resolveTable(tree, database, [name]);
    return inCurrent ? columnCandidates(inCurrent.table, FIRST) : [];
  }
  // `db.table.` is a table's columns; `project.dataset.` (a BigQuery path) is a dataset's tables, the project dropped
  const resolved = resolveTable(tree, database, qualifier.slice(-2));
  if (resolved) return columnCandidates(resolved.table, FIRST);
  const db = byName(tree.databases, qualifier[qualifier.length - 1]!);
  return db ? tableCandidates(db, words, FIRST) : [];
}

/** The columns of the tables a position sees. A name that two of them have is offered once per table, qualified. */
function visibleColumns(input: CandidateInput, visible: VisibleTable[]): Candidate[] {
  const { tree, database } = input;
  const sources: { qualifier: string; table: SchemaTable; depth: number; index: number }[] = [];
  visible.forEach((v, index) => {
    const resolved = resolveTable(tree, database, v.ref.path);
    if (resolved) sources.push({ qualifier: v.ref.alias ?? v.ref.path[v.ref.path.length - 1]!, table: resolved.table, depth: v.depth, index });
  });
  const count = new Map<string, number>();
  for (const s of sources) for (const c of s.table.columns) count.set(c.name.toLowerCase(), (count.get(c.name.toLowerCase()) ?? 0) + 1);
  const out: Candidate[] = [];
  for (const s of sources) {
    const boost = FIRST - s.depth * OUTER_STEP - Math.min(s.index, 20);
    for (const c of s.table.columns) {
      if ((count.get(c.name.toLowerCase()) ?? 0) > 1) {
        out.push({ label: c.name, parts: [s.qualifier, c.name], kind: 'column', detail: `${s.qualifier} · ${c.type}`, boost });
      } else {
        out.push({ label: c.name, parts: [c.name], kind: 'column', detail: columnDetail(c), boost });
      }
    }
  }
  return out;
}

/** Aliases and names of the tables of the statement: where a `name.` starts. */
function tableNames(visible: VisibleTable[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const v of visible) {
    const name = v.ref.alias ?? v.ref.path[v.ref.path.length - 1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ label: name, parts: [name], kind: 'alias', detail: v.ref.alias ? v.ref.path.join('.') : '', boost: ALIAS - v.depth * 10 });
  }
  return out;
}

/** The options for the cursor of a statement, best first by `boost` (the editor sorts them). */
export function completionCandidates(input: CandidateInput): Candidate[] {
  const { tree, database, analysis, offset, words } = input;
  const context = completionContext(analysis, offset);
  const visible = tablesAt(analysis, offset);
  if (context.qualifier.length > 0) return qualified(input, context.qualifier, visible);
  if (!tree) return [];

  const current = database === null ? undefined : byName(tree.databases, database);
  const databases = (boost: number): Candidate[] =>
    tree.databases.map((d) => ({ label: d.name, parts: [d.name], kind: 'database', detail: words.database, boost }));
  switch (context.expects) {
    case 'table':
      return [...(current ? tableCandidates(current, words, FIRST) : []), ...databases(FIRST - OUTER_STEP)];
    case 'column': {
      const names = tableNames(visible);
      const taken = new Set(names.map((c) => c.label.toLowerCase()));
      return [
        ...visibleColumns(input, visible),
        ...names,
        // a table of the statement is offered once, as the name it answers to
        ...(current ? tableCandidates(current, words, LOW).filter((c) => !taken.has(c.label.toLowerCase())) : []),
        ...databases(LOW),
      ];
    }
    default:
      return [...(current ? tableCandidates(current, words, LOW) : []), ...databases(LOW)];
  }
}
