import type { CellValue, ColumnMeta } from '@shared/results';

const MAX_HEX_BYTES = 256;

/** A field of a BigQuery table schema, as the REST API describes it. */
export interface SchemaField {
  name?: string;
  type: string;
  mode?: string;
  fields?: SchemaField[];
  maxLength?: string;
  precision?: string;
  scale?: string;
  rangeElementType?: { type: string };
}

/** The standard SQL name of a REST type (the API still says INTEGER, FLOAT, BOOLEAN and RECORD). */
function baseName(type: string): string {
  switch (type.toUpperCase()) {
    case 'INTEGER':
      return 'INT64';
    case 'FLOAT':
      return 'FLOAT64';
    case 'BOOLEAN':
      return 'BOOL';
    case 'RECORD':
      return 'STRUCT';
    default:
      return type.toUpperCase();
  }
}

/** The type of a column in full: `STRUCT<a INT64, b ARRAY<STRING>>`, `ARRAY<NUMERIC(10, 2)>`, `RANGE<DATE>`. */
export function typeText(field: SchemaField): string {
  const one = elementType(field);
  return field.mode?.toUpperCase() === 'REPEATED' ? `ARRAY<${one}>` : one;
}

function elementType(field: SchemaField): string {
  const base = baseName(field.type);
  if (base === 'STRUCT') {
    const inner = (field.fields ?? []).map((f) => (f.name ? `${f.name} ${typeText(f)}` : typeText(f))).join(', ');
    return `STRUCT<${inner}>`;
  }
  if (base === 'RANGE') return field.rangeElementType ? `RANGE<${baseName(field.rangeElementType.type)}>` : 'RANGE';
  if ((base === 'STRING' || base === 'BYTES') && field.maxLength) return `${base}(${field.maxLength})`;
  if ((base === 'NUMERIC' || base === 'BIGNUMERIC') && field.precision) {
    return `${base}(${field.precision}${field.scale ? `, ${field.scale}` : ''})`;
  }
  return base;
}

export function columnMeta(field: SchemaField): ColumnMeta {
  return { name: field.name ?? '', type: typeText(field), nullable: field.mode?.toUpperCase() !== 'REQUIRED' };
}

/** Microseconds since the epoch (an int64 as text) as `2026-10-01 09:12:44.123456 UTC`; the fraction is left out when zero. */
export function formatTimestamp(micros: string): string {
  let value: bigint;
  try {
    value = BigInt(micros);
  } catch {
    return micros;
  }
  const million = 1_000_000n;
  let seconds = value / million;
  let rest = value % million;
  if (rest < 0n) {
    rest += million;
    seconds -= 1n;
  }
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) return micros;
  const iso = date.toISOString(); // 2026-10-01T09:12:44.000Z (years 0001 to 9999)
  const fraction = rest === 0n ? '' : `.${rest.toString().padStart(6, '0')}`;
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}${fraction} UTC`;
}

function isFloatText(value: string): boolean {
  return value === 'NaN' || value === 'Infinity' || value === '-Infinity' || value === '+Infinity';
}

/** A value inside a STRUCT or ARRAY, as plain JSON: integers and decimals stay text so nothing loses digits. */
function toJson(raw: unknown, field: SchemaField): unknown {
  if (raw === null || raw === undefined) return null;
  if (field.mode?.toUpperCase() === 'REPEATED') {
    const items = Array.isArray(raw) ? raw : [];
    return items.map((item) => toJson((item as { v?: unknown } | null)?.v, { ...field, mode: 'NULLABLE' }));
  }
  const base = baseName(field.type);
  if (base === 'STRUCT') {
    const cells = (raw as { f?: { v?: unknown }[] }).f ?? [];
    const out: Record<string, unknown> = {};
    (field.fields ?? []).forEach((child, i) => {
      out[child.name || `_${i}`] = toJson(cells[i]?.v, child);
    });
    return out;
  }
  if (typeof raw !== 'string') return raw;
  switch (base) {
    case 'FLOAT64':
      return isFloatText(raw) ? raw : Number(raw);
    case 'BOOL':
      return raw === 'true';
    case 'TIMESTAMP':
      return formatTimestamp(raw);
    default:
      return raw;
  }
}

/** One cell of the grid. STRUCT and ARRAY become JSON text, BYTES a cut hex preview, the rest text or number. */
export function toCell(raw: unknown, field: SchemaField): CellValue {
  if (raw === null || raw === undefined) return null;
  const repeated = field.mode?.toUpperCase() === 'REPEATED';
  const base = baseName(field.type);
  if (repeated || base === 'STRUCT') return JSON.stringify(toJson(raw, field));
  if (typeof raw !== 'string') return JSON.stringify(raw);
  switch (base) {
    case 'FLOAT64': {
      if (isFloatText(raw)) return raw;
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case 'TIMESTAMP':
      return formatTimestamp(raw);
    case 'BYTES': {
      const bytes = Buffer.from(raw, 'base64');
      return { kind: 'binary', hex: bytes.subarray(0, MAX_HEX_BYTES).toString('hex'), length: bytes.length };
    }
    default:
      // INT64, NUMERIC, BIGNUMERIC, BOOL ("true"/"false"), DATE, DATETIME, TIME, INTERVAL, RANGE, GEOGRAPHY, JSON, STRING
      return raw;
  }
}

/** A row of the REST result (`{ f: [{ v }] }`) as grid cells. */
export function decodeRow(row: { f?: { v?: unknown }[] }, fields: SchemaField[]): CellValue[] {
  const cells = row.f ?? [];
  return fields.map((field, i) => toCell(cells[i]?.v, field));
}
