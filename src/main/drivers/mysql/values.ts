import { Types } from 'mysql2';
import type { CellValue, ColumnMeta } from '@shared/results';

const MAX_HEX_BYTES = 256;

export interface FieldLike {
  name: string;
  columnType?: number;
  characterSet?: number;
  /** Database of the source table (empty for expressions). */
  schema?: string;
  /** The table name as the query wrote it (alias). */
  table?: string;
  /** The real table name (empty for expressions). */
  orgTable?: string;
  /** The real column name (empty for expressions). */
  orgName?: string;
  flags?: number;
}

// column definition flags of the MySQL protocol: they stay in main, the renderer gets neutral fields
const NOT_NULL_FLAG = 1;
const PRI_KEY_FLAG = 2;
const AUTO_INCREMENT_FLAG = 512;

/** The neutral column metadata for the result: name, friendly type and, for a table column, where it comes from. */
export function columnMeta(field: FieldLike): ColumnMeta {
  const meta: ColumnMeta = { name: field.name, type: typeName(field) };
  if (field.schema && field.orgTable && field.orgName) {
    meta.source = {
      database: field.schema,
      table: field.orgTable,
      column: field.orgName,
      ...(field.table ? { alias: field.table } : {}),
    };
    if (typeof field.flags === 'number') {
      meta.primaryKeyPart = (field.flags & PRI_KEY_FLAG) !== 0;
      meta.nullable = (field.flags & NOT_NULL_FLAG) === 0;
      meta.autoIncrement = (field.flags & AUTO_INCREMENT_FLAG) !== 0;
    }
  }
  return meta;
}

const BINARY_CHARSET = 63;

/** Friendly type name for the result header. */
export function typeName(field: FieldLike): string {
  const binary = field.characterSet === BINARY_CHARSET;
  switch (field.columnType) {
    case Types.DECIMAL:
    case Types.NEWDECIMAL:
      return 'decimal';
    case Types.TINY:
      return 'tinyint';
    case Types.SHORT:
      return 'smallint';
    case Types.INT24:
      return 'mediumint';
    case Types.LONG:
      return 'int';
    case Types.LONGLONG:
      return 'bigint';
    case Types.FLOAT:
      return 'float';
    case Types.DOUBLE:
      return 'double';
    case Types.NULL:
      return 'null';
    case Types.TIMESTAMP:
      return 'timestamp';
    case Types.DATE:
    case Types.NEWDATE:
      return 'date';
    case Types.TIME:
      return 'time';
    case Types.DATETIME:
      return 'datetime';
    case Types.YEAR:
      return 'year';
    case Types.VARCHAR:
    case Types.VAR_STRING:
      return binary ? 'varbinary' : 'varchar';
    case Types.STRING:
      return binary ? 'binary' : 'char';
    case Types.BIT:
      return 'bit';
    case Types.JSON:
      return 'json';
    case Types.ENUM:
      return 'enum';
    case Types.SET:
      return 'set';
    case Types.TINY_BLOB:
      return binary ? 'tinyblob' : 'tinytext';
    case Types.MEDIUM_BLOB:
      return binary ? 'mediumblob' : 'mediumtext';
    case Types.LONG_BLOB:
      return binary ? 'longblob' : 'longtext';
    case Types.BLOB:
      return binary ? 'blob' : 'text';
    case Types.GEOMETRY:
      return 'geometry';
    case Types.VECTOR:
      return 'vector';
    default:
      return 'unknown';
  }
}

export function toCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Buffer.isBuffer(value)) {
    return {
      kind: 'binary',
      hex: value.subarray(0, MAX_HEX_BYTES).toString('hex'),
      length: value.length,
    };
  }
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
