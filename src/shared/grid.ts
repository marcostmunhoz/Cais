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
 * Whether a result can be edited in the grid, and how. `schema` is the environment's schema tree (undefined
 * while it loads); `valueKind` comes from the environment's dialect.
 */
export function gridEditability(
  result: ResultLike,
  schema: SchemaTree | undefined,
  valueKind: Dialect['valueKind'],
): Editability {
  const refuse = (reason: MessageRef): Editability => ({ editable: false, reason });
  const columns = result.columns;
  if (result.error || result.kind !== 'read' || !READ_VERBS.has(result.verb) || !columns) return refuse(ref('grid.reason.notRead'));

  // 1. the columns from tables must all come from one table, under one name (no join, no self-join)
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

  // 2. a base table the schema knows, with a primary key
  if (!schema) return refuse(ref('grid.reason.schemaLoading'));
  const db = byName(schema.databases, source.database);
  const table: SchemaTable | undefined = db ? byName(db.tables, source.table) : undefined;
  if (!db || !table) return refuse(ref('grid.reason.unknownTable', { table: name }));
  if (table.type !== 'table') return refuse(ref('grid.reason.view', { table: name }));
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
  // select does not show here: Gerar UPDATE and Aplicar read the schema again first.
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

/** How many cells and rows have a pending change. */
export function pendingCount(cells: PendingCells): { changes: number; rows: number } {
  let changes = 0;
  let rows = 0;
  for (const row of Object.values(cells)) {
    const n = Object.keys(row).length;
    if (n > 0) rows++;
    changes += n;
  }
  return { changes, rows };
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
