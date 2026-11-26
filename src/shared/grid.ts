import type { CellValue, ColumnMeta, SchemaTable, SchemaTree, StatementResult } from './results';
import type { Dialect, ValueKind } from './dialects/types';
import { ref, type MessageRef } from './i18n';

// Editing in the results grid. Pure and engine-neutral: the renderer decides from the result's
// column metadata and the environment's schema; the SQL comes from the dialect. This is a usage rule, not the
// security boundary: main reclassifies whatever runs.

/** A column the grid can edit: where it is written and how its values are typed. */
export interface EditableColumn {
  editable: true;
  /** The column name in the table (never the alias). */
  column: string;
  /** The column type as the schema says it ("bigint unsigned", "enum('a','b')"). */
  type: string;
  kind: ValueKind;
  nullable: boolean;
}

export interface LockedColumn {
  editable: false;
  reason: MessageRef;
}

export type GridColumn = EditableColumn | LockedColumn;

export interface KeyColumn {
  /** Index of the key column in the result. */
  index: number;
  column: string;
  type: string;
}

export interface EditTarget {
  editable: true;
  database: string;
  table: string;
  /** Every column of the primary key, as plain columns of the result. */
  key: KeyColumn[];
  /** One entry per result column. */
  columns: GridColumn[];
}

export type Editability = EditTarget | { editable: false; reason: MessageRef };

/** New values by row index, then by column index. */
export type PendingCells = Record<number, Record<number, CellValue>>;

type ResultLike = Pick<StatementResult, 'kind' | 'verb' | 'error' | 'columns' | 'rows'>;

const READ_VERBS = new Set(['SELECT', 'TABLE']);

const qualified = (database: string, table: string): string => `${database}.${table}`;

/**
 * Exact name first; a case-insensitive match only when it is the only one (lower_case_table_names differs per
 * server). Only to find the key and the types: the UPDATE always names the table the server reported.
 */
function byName<T extends { name: string }>(items: readonly T[], name: string): T | undefined {
  const exact = items.find((i) => i.name === name);
  if (exact) return exact;
  const loose = items.filter((i) => i.name.toLowerCase() === name.toLowerCase());
  return loose.length === 1 ? loose[0] : undefined;
}

export function isTruncatedBinary(value: CellValue): boolean {
  return value !== null && typeof value === 'object' && value.hex.length < value.length * 2;
}

/** The key of a row as text, to tell rows apart and find them again after a refresh. */
function keyOf(row: readonly CellValue[], key: readonly KeyColumn[]): string {
  return JSON.stringify(key.map((k) => {
    const v = row[k.index] ?? null;
    return v !== null && typeof v === 'object' ? { hex: v.hex.toLowerCase() } : v;
  }));
}

/**
 * The one base table a result reads from, found in the environment's schema: what editing a cell and generating an
 * INSERT both start from. Gives the reason when the result is not a plain read of one known base table.
 */
function findSourceTable(
  result: ResultLike,
  schema: SchemaTree | undefined,
  engine?: { gridEdit: boolean; name: string },
):
  | { ok: false; reason: MessageRef }
  | { ok: true; columns: ColumnMeta[]; source: { database: string; table: string }; table: SchemaTable; name: string } {
  const refuse = (reason: MessageRef) => ({ ok: false as const, reason });
  if (engine && !engine.gridEdit) return refuse(ref('grid.reason.engineNoEdit', { engine: engine.name }));
  const columns = result.columns;
  if (result.error || result.kind !== 'read' || !READ_VERBS.has(result.verb) || !columns) return refuse(ref('grid.reason.notRead'));

  // the columns from tables must all come from one table, under one name (no join, no self-join)
  const sources = new Map<string, { database: string; table: string; alias?: string }>();
  for (const c of columns) {
    if (!c.source) continue;
    const s = c.source;
    sources.set(JSON.stringify([s.database, s.table, s.alias ?? s.table]), s);
  }
  if (sources.size === 0) return refuse(ref('grid.reason.noTable'));
  if (sources.size > 1) {
    const names = [...sources.values()].map((s) =>
      s.alias && s.alias !== s.table ? `${qualified(s.database, s.table)} (${s.alias})` : qualified(s.database, s.table),
    );
    return refuse(ref('grid.reason.severalTables', { tables: names.join(', ') }));
  }
  const source = [...sources.values()][0]!;
  const name = qualified(source.database, source.table);

  // a base table the schema knows
  if (!schema) return refuse(ref('grid.reason.schemaLoading'));
  const db = byName(schema.databases, source.database);
  const table: SchemaTable | undefined = db ? byName(db.tables, source.table) : undefined;
  if (!db || !table) return refuse(ref('grid.reason.unknownTable', { table: name }));
  if (table.type !== 'table') return refuse(ref('grid.reason.view', { table: name }));
  return { ok: true, columns, source, table, name };
}

/**
 * Whether a result can be edited in the grid, and how. `schema` is the environment's schema tree (undefined
 * while it loads); `valueKind` comes from the environment's dialect.
 */
export function gridEditability(
  result: ResultLike,
  schema: SchemaTree | undefined,
  valueKind: Dialect['valueKind'],
  /** The engine's `gridEdit` capability and its name for the reason; absent means the engine edits. */
  engine?: { gridEdit: boolean; name: string },
): Editability {
  const refuse = (reason: MessageRef): Editability => ({ editable: false, reason });
  // 1-2. one base table the schema knows
  const found = findSourceTable(result, schema, engine);
  if (!found.ok) return refuse(found.reason);
  const { columns, source, table, name } = found;

  // 2b. a primary key
  const pk = table.columns.filter((c) => c.key === 'PRI');
  if (pk.length === 0) return refuse(ref('grid.reason.noPrimaryKey', { table: name }));

  // 3. every key column present as a plain column of that table
  const indexOf = (column: string): number =>
    columns.findIndex((c) => c.source && c.source.column.toLowerCase() === column.toLowerCase());
  const missing = pk.filter((k) => indexOf(k.name) === -1).map((k) => k.name);
  if (missing.length > 0) return refuse(ref('grid.reason.missingKey', { columns: missing.join(', ') }));
  const key: KeyColumn[] = pk.map((k) => ({ index: indexOf(k.name), column: k.name, type: k.type }));

  // 4. a stale schema, as far as the result's own metadata shows it: the columns the server flags as part of
  // the key must be exactly the schema's key (a key that moved or shrank would make the WHERE match several
  // rows), and the server's type of each key column must be written the same way as the schema's (a key now
  // VARCHAR compared as a number matches '5', '05' and ' 5'). A key that grew by a column the query did not
  // select does not show here: Generate SQL and Apply read the schema again first.
  const pkNames = new Set(pk.map((k) => k.name.toLowerCase()));
  const stale =
    columns.some((c: ColumnMeta) => c.source && c.primaryKeyPart === true && !pkNames.has(c.source.column.toLowerCase())) ||
    key.some((k) => columns[k.index]!.primaryKeyPart === false || valueKind(columns[k.index]!.type) !== valueKind(k.type));
  if (stale) return refuse(ref('grid.reason.staleSchema'));

  // 5. key values that identify exactly one row: no NULL, no approximate number, no value read relative to the
  // session time zone, no cut binary, no repeats
  for (const k of key) {
    const kind = valueKind(k.type);
    if (kind === 'float') return refuse(ref('grid.reason.floatKey', { column: k.column }));
    if (kind === 'zoned') return refuse(ref('grid.reason.zonedKey', { column: k.column }));
  }
  const seen = new Set<string>();
  for (const row of result.rows ?? []) {
    for (const k of key) {
      const v = row[k.index] ?? null;
      if (v === null) return refuse(ref('grid.reason.nullKey', { column: k.column }));
      if (isTruncatedBinary(v)) return refuse(ref('grid.reason.truncatedKey', { column: k.column }));
    }
    const id = keyOf(row, key);
    if (seen.has(id)) return refuse(ref('grid.reason.duplicateKey'));
    seen.add(id);
  }

  // 6. which columns can be edited
  const used = new Set<string>();
  const gridColumns: GridColumn[] = columns.map((c) => {
    if (!c.source) return { editable: false, reason: ref('grid.reason.expression', { column: c.name }) };
    const schemaColumn = byName(table.columns, c.source.column);
    if (!schemaColumn) return { editable: false, reason: ref('grid.reason.unknownColumn', { column: c.name }) };
    const lower = schemaColumn.name.toLowerCase();
    if (used.has(lower)) return { editable: false, reason: ref('grid.reason.duplicateColumn', { column: c.name }) };
    used.add(lower);
    if (schemaColumn.generated || c.generated) return { editable: false, reason: ref('grid.reason.generated', { column: c.name }) };
    const kind = valueKind(schemaColumn.type);
    if (kind === 'unsupported' || valueKind(c.type) === 'unsupported') {
      return { editable: false, reason: ref('grid.reason.unsupportedType', { column: c.name, type: c.type }) };
    }
    // the schema's type is stale (the column changed type since it was read): the literal would be written wrong
    if (valueKind(c.type) !== kind) return { editable: false, reason: ref('grid.reason.staleColumn', { column: c.name }) };
    return { editable: true, column: schemaColumn.name, type: schemaColumn.type, kind, nullable: schemaColumn.nullable };
  });
  // the UPDATE names the table the rows came from, as the server reported it: the schema's spelling may be
  // another table that differs only in case (lower_case_table_names=0)
  return { editable: true, database: source.database, table: source.table, key, columns: gridColumns };
}

/** Why one cell cannot be edited, or null when it can. */
export function cellLock(target: Editability, column: number, value: CellValue): MessageRef | null {
  if (!target.editable) return target.reason;
  const col = target.columns[column];
  if (!col) return ref('grid.reason.notRead');
  if (!col.editable) return col.reason;
  if (isTruncatedBinary(value)) return ref('grid.reason.truncatedValue');
  return null;
}

/** Whether two cell values are the same value (a typed "5" equals the server's 5). */
export function sameCell(a: CellValue, b: CellValue): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === 'object' || typeof b === 'object') {
    return typeof a === 'object' && typeof b === 'object' && a.length === b.length && a.hex.toLowerCase() === b.hex.toLowerCase();
  }
  return String(a) === String(b);
}

/**
 * What the person typed, as a cell value of that column: text stays text (empty is empty, never NULL), numbers
 * are checked by the dialect, binary values are typed as hex. Gives the reason when the text does not fit.
 */
export function parseCellInput(
  text: string,
  column: EditableColumn,
  dialect: Pick<Dialect, 'quoteLiteral'>,
): { value: CellValue } | { error: MessageRef } {
  let value: CellValue = text;
  if (column.kind === 'binary' || column.kind === 'bit') {
    const hex = text.trim().replace(/^0x/i, '').replace(/\s+/g, '');
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) return { error: ref('grid.invalid.hex', { column: column.column }) };
    value = { kind: 'binary', hex: hex.toLowerCase(), length: hex.length / 2 };
  } else if (column.kind === 'integer' || column.kind === 'decimal' || column.kind === 'float') {
    value = text.trim();
  }
  try {
    dialect.quoteLiteral(value, column.type);
  } catch {
    return {
      error:
        column.kind === 'integer'
          ? ref('grid.invalid.integer', { column: column.column })
          : ref('grid.invalid.number', { column: column.column }),
    };
  }
  return { value };
}

/** The text that opens in the cell editor for a value. */
export function cellInputText(value: CellValue): string {
  if (value === null) return '';
  if (typeof value === 'object') return value.hex;
  return String(value);
}

/**
 * Rows marked for deletion, as indexes into the result's rows. The deletion wins over the row's pending cell edits:
 * they stay in `PendingCells` (so unmarking brings them back) but produce no UPDATE and are not counted as changes.
 */
export type PendingDeleted = readonly number[];

/**
 * What is pending: `changes` and `rows` count the cell edits that will run (rows marked for deletion left out), `deletions`
 * the rows marked, `total` every pending cell edit (marked rows' included) plus the deletions: what discarding loses.
 */
export function pendingCount(
  cells: PendingCells,
  deleted: PendingDeleted = [],
): { changes: number; rows: number; deletions: number; total: number } {
  const marked = new Set(deleted);
  let changes = 0;
  let rows = 0;
  let total = 0;
  for (const [r, row] of Object.entries(cells)) {
    const n = Object.keys(row).length;
    total += n;
    if (marked.has(Number(r))) continue;
    if (n > 0) rows++;
    changes += n;
  }
  return { changes, rows, deletions: marked.size, total: total + marked.size };
}

/** Whether anything is pending, edits of marked rows included (they come back when the mark is undone). */
export function hasPending(cells: PendingCells, deleted: PendingDeleted = []): boolean {
  return deleted.length > 0 || Object.keys(cells).length > 0;
}

/** The rows with a deletion mark set or cleared (sorted, no repeats). */
export function withDeleted(deleted: PendingDeleted, rows: readonly number[], marked: boolean): number[] {
  const set = new Set(deleted);
  for (const r of rows) {
    if (marked) set.add(r);
    else set.delete(r);
  }
  return [...set].sort((a, b) => a - b);
}

/** One UPDATE per edited row (row order), with the whole key in the WHERE. Statements have no terminator. */
export function buildGridUpdates(
  dialect: Pick<Dialect, 'buildUpdate'>,
  target: EditTarget,
  rows: readonly (readonly CellValue[])[],
  cells: PendingCells,
): { row: number; sql: string }[] {
  const out: { row: number; sql: string }[] = [];
  for (const r of Object.keys(cells).map(Number).sort((a, b) => a - b)) {
    const row = rows[r];
    const edits = cells[r]!;
    const columns = Object.keys(edits).map(Number).sort((a, b) => a - b);
    if (!row || columns.length === 0) continue;
    out.push({
      row: r,
      sql: dialect.buildUpdate({
        database: target.database,
        table: target.table,
        set: columns.map((c) => {
          const col = target.columns[c];
          if (!col?.editable) throw new Error(`column ${c} is not editable`);
          return { column: col.column, type: col.type, value: edits[c]! };
        }),
        where: target.key.map((k) => ({ column: k.column, type: k.type, value: row[k.index] ?? null })),
      }),
    });
  }
  return out;
}

/** One statement the grid applies: the row it comes from, its verb and the SQL (no terminator). */
export interface GridStatement {
  row: number;
  verb: 'UPDATE' | 'DELETE';
  sql: string;
}

/**
 * What Apply and Generate SQL write: the UPDATEs of the edited rows first, then one DELETE per row marked for deletion,
 * each in row order. A row marked for deletion gets no UPDATE, whatever edits it holds. The whole key is in each WHERE.
 */
export function buildGridStatements(
  dialect: Pick<Dialect, 'buildUpdate' | 'buildDelete'>,
  target: EditTarget,
  rows: readonly (readonly CellValue[])[],
  cells: PendingCells,
  deleted: PendingDeleted,
): GridStatement[] {
  const marked = new Set(deleted);
  const live: PendingCells = {};
  for (const [r, edits] of Object.entries(cells)) if (!marked.has(Number(r))) live[Number(r)] = edits;
  const out: GridStatement[] = buildGridUpdates(dialect, target, rows, live).map((u) => ({ ...u, verb: 'UPDATE' as const }));
  for (const r of [...marked].sort((a, b) => a - b)) {
    const row = rows[r];
    if (!row) throw new Error(`row ${r} does not exist`);
    out.push({
      row: r,
      verb: 'DELETE',
      sql: dialect.buildDelete({
        database: target.database,
        table: target.table,
        where: target.key.map((k) => ({ column: k.column, type: k.type, value: row[k.index] ?? null })),
      }),
    });
  }
  return out;
}

/** What a DELETE of the table may also touch beyond its own rows, as far as the schema says. */
export interface DeleteReach {
  /** "db.table" of the tables whose foreign keys cascade from this one (delete, set null or set default). */
  cascades: string[];
  /** The table has triggers: what they write is not in the row count. */
  triggers: boolean;
  /** Some of that metadata could not be read, so the absence of the two above proves nothing. */
  unknown: boolean;
}

/** The reach of a DELETE on a table, from the schema the renderer has. Null when the schema does not know the table. */
export function deleteReach(schema: SchemaTree | undefined, database: string, table: string): DeleteReach | null {
  if (!schema) return null;
  const db = byName(schema.databases, database);
  const t = db ? byName(db.tables, table) : undefined;
  if (!db || !t) return null;
  return {
    cascades: t.cascadedBy ?? [],
    triggers: (t.triggers ?? []).length > 0,
    unknown: schema.foreignKeysComplete === false || db.partial === true || db.triggersVisible === false,
  };
}

/** The most rows one "Generate cell UPDATE" writes: one statement and one selected literal each. */
export const MAX_CELL_UPDATES = 500;

/**
 * "Generate cell UPDATE": one `UPDATE … SET <column> = <value> WHERE <whole key>;` per row, one per line. `value` is
 * what the grid shows (pending edits applied); the key is the row as the server sent it. `ranges` are the value
 * literals, as offsets into `text`, for the person to type over.
 */
export function buildCellUpdates(
  dialect: Pick<Dialect, 'buildUpdateLocated'>,
  target: EditTarget,
  rows: readonly (readonly CellValue[])[],
  column: number,
  cells: readonly { row: number; value: CellValue }[],
): { text: string; ranges: { from: number; to: number }[] } {
  const col = target.columns[column];
  if (!col?.editable) throw new Error(`column ${column} is not editable`);
  let text = '';
  const ranges: { from: number; to: number }[] = [];
  for (const { row: r, value } of cells) {
    const row = rows[r];
    if (!row) throw new Error(`row ${r} does not exist`);
    const { sql, setValues } = dialect.buildUpdateLocated({
      database: target.database,
      table: target.table,
      set: [{ column: col.column, type: col.type, value }],
      where: target.key.map((k) => ({ column: k.column, type: k.type, value: row[k.index] ?? null })),
    });
    if (text) text += '\n';
    ranges.push({ from: text.length + setValues[0]!.from, to: text.length + setValues[0]!.to });
    text += `${sql};`;
  }
  return { text, ranges };
}

/**
 * Appends statements to a script (see `Dialect.appendStatements`) and works out where `ranges` (offsets into `text`)
 * land in the new document: the editor selects them.
 */
export function planAppend(
  dialect: Pick<Dialect, 'appendStatements'>,
  doc: string,
  text: string,
  ranges?: readonly { from: number; to: number }[],
): { changes: { from: number; insert: string }[]; selections: { from: number; to: number }[] } {
  const { changes, selection } = dialect.appendStatements(doc, text);
  return {
    changes,
    selections: ranges && ranges.length > 0 ? ranges.map((r) => ({ from: selection.from + r.from, to: selection.from + r.to })) : [selection],
  };
}

/** The most rows one "Generate INSERT" writes. */
export const MAX_INSERT_ROWS = 1000;

/** A result column that goes into a generated INSERT: where it is in the result and how the table names and types it. */
export interface InsertColumn {
  index: number;
  column: string;
  type: string;
}

/** Where a generated INSERT writes and what goes into it. */
export interface InsertTarget {
  insertable: true;
  database: string;
  table: string;
  /** The result columns that go into the INSERT, in result order. */
  columns: InsertColumn[];
  /** Names of the result columns left out: expressions, generated columns, repeated columns, types that cannot be written. */
  omitted: string[];
  /**
   * Positions in `columns` of the primary key, for the variant without it. Null when that variant makes no sense or
   * cannot be known: the table has no key, the result lacks part of it, the server's flags disagree with the schema's
   * key, or the result holds no other column of the table (the INSERT would be all defaults).
   */
  key: number[] | null;
}

export type Insertability = InsertTarget | { insertable: false; reason: MessageRef };

/**
 * Whether a result can generate an INSERT, and with which columns. Looser than `gridEditability`: the rows are not
 * found again by a key, so the table needs no primary key (only the variant without the key does) and the key may
 * hold anything. The result still has to be a plain read of one base table, and its types must be the schema's.
 */
export function insertability(
  result: ResultLike,
  schema: SchemaTree | undefined,
  valueKind: Dialect['valueKind'],
  /** The engine's `gridEdit` capability and its name for the reason; absent means the engine writes. */
  engine?: { gridEdit: boolean; name: string },
): Insertability {
  const found = findSourceTable(result, schema, engine);
  if (!found.ok) return { insertable: false, reason: found.reason };
  const { columns, source, table } = found;

  const used = new Set<string>();
  const out: InsertColumn[] = [];
  const omitted: string[] = [];
  for (const [index, c] of columns.entries()) {
    if (!c.source) {
      omitted.push(c.name);
      continue;
    }
    const schemaColumn = byName(table.columns, c.source.column);
    if (!schemaColumn) return { insertable: false, reason: ref('grid.reason.unknownColumn', { column: c.name }) };
    const lower = schemaColumn.name.toLowerCase();
    if (used.has(lower)) {
      omitted.push(c.name);
      continue;
    }
    used.add(lower);
    if (schemaColumn.generated || c.generated) {
      omitted.push(c.name);
      continue;
    }
    const kind = valueKind(schemaColumn.type);
    if (kind === 'unsupported' || valueKind(c.type) === 'unsupported') {
      omitted.push(c.name);
      continue;
    }
    // the schema's type is stale (the column changed type since it was read): the literal would be written wrong
    if (valueKind(c.type) !== kind) return { insertable: false, reason: ref('grid.reason.staleColumn', { column: c.name }) };
    out.push({ index, column: schemaColumn.name, type: schemaColumn.type });
  }
  if (out.length === 0) return { insertable: false, reason: ref('grid.insert.noColumns') };

  // the key, for the variant without it: the whole key must be in the INSERT's columns, and the server must flag
  // exactly those columns of the result as the key (a key that moved is not the key to leave out)
  const pk = table.columns.filter((c) => c.key === 'PRI');
  const positions = pk.map((k) => out.findIndex((c) => c.column.toLowerCase() === k.name.toLowerCase()));
  const pkNames = new Set(pk.map((k) => k.name.toLowerCase()));
  const disagrees =
    columns.some((c) => c.source && c.primaryKeyPart === true && !pkNames.has(c.source.column.toLowerCase())) ||
    positions.some((p) => p !== -1 && columns[out[p]!.index]!.primaryKeyPart === false);
  // the variant needs a column besides the key: without one the INSERT would be all defaults (`() VALUES ()`)
  const key = pk.length === 0 || positions.includes(-1) || disagrees || out.length <= positions.length ? null : positions;
  return { insertable: true, database: source.database, table: source.table, columns: out, omitted, key };
}

/**
 * "Generate INSERT": one multi-row `INSERT INTO … (columns) VALUES (…), (…)`, without a terminator. `rows` are the
 * values as the grid shows them (pending edits applied), with their row index in the result. `withKey: false` leaves
 * the primary key columns out, for the server to fill. Gives the reason instead when a value cannot be written:
 * a binary value the driver cut cannot go back.
 */
export function buildGridInsert(
  dialect: Pick<Dialect, 'buildInsert'>,
  target: InsertTarget,
  rows: readonly { row: number; values: readonly CellValue[] }[],
  withKey: boolean,
): { sql: string } | { error: MessageRef } {
  if (!withKey && !target.key) throw new Error('the key is not known');
  const dropped = new Set(withKey ? [] : target.key);
  const columns = target.columns.filter((_, p) => !dropped.has(p));
  for (const { row, values } of rows) {
    for (const c of columns) {
      if (isTruncatedBinary(values[c.index] ?? null)) return { error: ref('grid.insert.truncated', { column: c.column, row: row + 1 }) };
    }
  }
  return {
    sql: dialect.buildInsert({
      database: target.database,
      table: target.table,
      columns: columns.map((c) => ({ column: c.column, type: c.type })),
      rows: rows.map(({ values }) => columns.map((c) => values[c.index] ?? null)),
    }),
  };
}

/** Row indexes (of `oldRows`) found again in a refreshed result, by their key: the rows that are gone are dropped. */
export function remapRows(
  key: readonly KeyColumn[],
  oldRows: readonly (readonly CellValue[])[],
  newRows: readonly (readonly CellValue[])[],
  rows: PendingDeleted,
): number[] {
  const at = new Map<string, number>();
  newRows.forEach((row, i) => at.set(keyOf(row, key), i));
  const out: number[] = [];
  for (const r of rows) {
    const row = oldRows[r];
    const index = row ? at.get(keyOf(row, key)) : undefined;
    if (index !== undefined) out.push(index);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Pending edits of some rows, moved onto a refreshed result of the same query: rows are found by their key,
 * and edits of rows that are gone are dropped.
 */
export function remapCells(
  key: readonly KeyColumn[],
  oldRows: readonly (readonly CellValue[])[],
  newRows: readonly (readonly CellValue[])[],
  cells: PendingCells,
): PendingCells {
  const at = new Map<string, number>();
  newRows.forEach((row, i) => at.set(keyOf(row, key), i));
  const out: PendingCells = {};
  for (const [r, edits] of Object.entries(cells)) {
    const row = oldRows[Number(r)];
    const index = row ? at.get(keyOf(row, key)) : undefined;
    if (index !== undefined && Object.keys(edits).length > 0) out[index] = { ...edits };
  }
  return out;
}
