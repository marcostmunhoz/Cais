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

const NUMERIC = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'decimal', 'float', 'double', 'year']);

export function isNumericType(type: string): boolean {
  return NUMERIC.has(type);
}

/** Plain text of a cell (NULL as empty, binary as 0x...). */
export function cellText(value: CellValue): string {
  if (value === null) return '';
  if (typeof value === 'object') return `0x${value.hex}${value.hex.length / 2 < value.length ? '…' : ''}`;
  return String(value);
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
