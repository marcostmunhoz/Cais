import type { CellValue, ColumnMeta } from '@shared/results';
import { fmt } from './i18n';

/** Number formatting in the app locale (kept as an object with `format` for older callers). */
export const nf = { format: (n: number): string => fmt().formatNumber(n) };

export function formatCount(n: number): string {
  return fmt().formatNumber(n);
}

/** "1 linha", "1.234 linhas" ("1,234 rows" in en). The caller passes the words in the app locale. */
export function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${fmt().formatNumber(ms / 1000, { maximumFractionDigits: 1 })} s`;
  return formatElapsed(ms);
}

/** 48s, 1m48s, 1h02m */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// MySQL (as the server names them) and BigQuery (INT64 and NUMERIC, written in capitals, FLOAT64 and BIGNUMERIC)
const NUMERIC = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'decimal', 'float', 'double', 'year', 'int64', 'numeric', 'bignumeric', 'float64']);

/** Numbers are aligned to the right in the grid. A type with parameters (`NUMERIC(10, 2)`) counts by its name. */
export function isNumericType(type: string): boolean {
  return NUMERIC.has(type.replace(/\(.*$/, '').trim().toLowerCase());
}

/** Plain text of a cell (NULL as empty, binary as 0x...). */
export function cellText(value: CellValue): string {
  if (value === null) return '';
  if (typeof value === 'object') return `0x${value.hex}${value.hex.length / 2 < value.length ? '…' : ''}`;
  return String(value);
}

/** True when the driver cut a binary value (it sends the first 256 bytes and the full length). */
export function isPartialBinary(value: CellValue): value is { kind: 'binary'; hex: string; length: number } {
  return value !== null && typeof value === 'object' && value.hex.length / 2 < value.length;
}

/**
 * What "copy value" puts on the clipboard for one cell: the value as the server sent it, with no quoting
 * (JSON stays as it came, a multi-line text keeps its line breaks). NULL is the word `NULL`, so it differs from an
 * empty string. A binary value is `0x...`, followed by `…` when the driver cut it.
 */
export function copyValueText(value: CellValue): string {
  return value === null ? 'NULL' : cellText(value);
}

export function displayCell(value: CellValue): string {
  if (value === null) return 'NULL';
  return cellText(value);
}

function quoteField(text: string, separator: string): string {
  return /["\r\n]/.test(text) || text.includes(separator) ? `"${text.replace(/"/g, '""')}"` : text;
}

export interface Selection {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** A selection of exactly one cell (a whole column of a one-row result counts too). */
export function isSingleCell(sel: Selection | null): boolean {
  return sel !== null && sel.r1 === sel.r2 && sel.c1 === sel.c2;
}

/**
 * A selection of whole columns (what a click on column headers makes): every row of some columns, but not whole rows.
 * A single cell is not one, whatever the size of the result.
 */
export function isColumnSelection(sel: Selection | null, rowCount: number, columnCount: number): boolean {
  if (sel === null || isSingleCell(sel)) return false;
  return sel.r1 === 0 && sel.r2 === rowCount - 1 && !(sel.c1 === 0 && sel.c2 === columnCount - 1);
}

function slice(columns: ColumnMeta[], rows: CellValue[][], sel: Selection | null) {
  if (!sel) return { cols: columns.map((_, i) => i), rows };
  const cols: number[] = [];
  for (let c = sel.c1; c <= sel.c2; c++) cols.push(c);
  return { cols, rows: rows.slice(sel.r1, sel.r2 + 1) };
}

export function toDelimited(
  columns: ColumnMeta[],
  rows: CellValue[][],
  sel: Selection | null,
  separator: '\t' | ',',
): string {
  const part = slice(columns, rows, sel);
  const lines = [part.cols.map((c) => quoteField(columns[c]!.name, separator)).join(separator)];
  for (const row of part.rows) {
    lines.push(part.cols.map((c) => quoteField(cellText(row[c] ?? null), separator)).join(separator));
  }
  return lines.join('\n');
}

/** Cell text for a Markdown table: `\` and `|` escaped (in that order), line breaks as `<br>`, tabs as spaces. */
function markdownCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>').replace(/\t/g, ' ');
}

/**
 * A GitHub-flavoured Markdown table of the selection (the whole result when nothing is selected). The header is the
 * column names, numeric columns are right-aligned (`---:`), NULL is `NULL` and there is no padding or truncation.
 * Every `|` that separates cells has a space before it, so a cell that ends in a backslash cannot be read as an escaped pipe.
 */
export function toMarkdown(columns: ColumnMeta[], rows: CellValue[][], sel: Selection | null): string {
  const part = slice(columns, rows, sel);
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  const lines = [
    line(part.cols.map((c) => markdownCell(columns[c]!.name))),
    line(part.cols.map((c) => (isNumericType(columns[c]!.type) ? '---:' : '---'))),
  ];
  for (const row of part.rows) {
    lines.push(line(part.cols.map((c) => markdownCell(copyValueText(row[c] ?? null)))));
  }
  return lines.join('\n');
}

export function toJson(columns: ColumnMeta[], rows: CellValue[][], sel: Selection | null): string {
  const part = slice(columns, rows, sel);
  const objects = part.rows.map((row) => {
    const o: Record<string, unknown> = {};
    for (const c of part.cols) {
      const v = row[c] ?? null;
      o[columns[c]!.name] = v !== null && typeof v === 'object' ? cellText(v) : v;
    }
    return o;
  });
  return JSON.stringify(objects, null, 2);
}

/** Pretty JSON when the value parses as an object or array. */
export function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}
