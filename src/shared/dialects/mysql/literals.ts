import type { CellValue } from '../../results';
import type { UpdateSpec, ValueKind } from '../types';
import { m } from '../../i18n';

// Literals for the UPDATEs the grid generates. Two readers must agree on every literal: the
// server (with or without NO_BACKSLASH_ESCAPES in the person's sql_mode) and the Cais splitter/classifier.
// So a string literal never contains a backslash or a control character: such a value goes as hex.

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const FLOAT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const HEX = /^(?:[0-9a-fA-F]{2})*$/;
const BITS = /^[01]+$/;
/** Backslash, control characters (C0, DEL, C1), invisible/format characters (bidi, zero width) and line separators. */
const NEEDS_HEX = /[\\\p{Cc}\p{Cf}\u2028\u2029]/u;

const INTEGER_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'year', 'bool', 'boolean', 'serial']);
const DECIMAL_TYPES = new Set(['decimal', 'numeric', 'dec', 'fixed']);
const FLOAT_TYPES = new Set(['float', 'double', 'real']);
const BINARY_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob']);
const UNSUPPORTED_TYPES = new Set([
  'geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection',
  'geomcollection', 'vector',
]);

/** "bigint unsigned", "enum('a','b')", "varbinary(16)" → "bigint", "enum", "varbinary". */
function baseType(type: string): string {
  return /^\s*([a-z]+)/i.exec(type)?.[1]?.toLowerCase() ?? '';
}

export function valueKind(type: string): ValueKind {
  const base = baseType(type);
  if (INTEGER_TYPES.has(base)) return 'integer';
  if (DECIMAL_TYPES.has(base)) return 'decimal';
  if (FLOAT_TYPES.has(base)) return 'float';
  if (base === 'bit') return 'bit';
  if (BINARY_TYPES.has(base)) return 'binary';
  if (UNSUPPORTED_TYPES.has(base)) return 'unsupported';
  // stored in UTC, read and written in the session time zone
  if (base === 'timestamp') return 'zoned';
  // text, enum, set (always quoted: an unquoted number is an index), json, dates and times
  return 'text';
}

/** UTF-8 bytes of a string as hex (no Node, no DOM: src/shared is plain TS). */
function utf8Hex(text: string): string {
  let out = '';
  const byte = (b: number) => (out += b.toString(16).padStart(2, '0'));
  for (const ch of text) {
    let cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd; // a lone surrogate has no UTF-8 form
    if (cp < 0x80) byte(cp);
    else if (cp < 0x800) {
      byte(0xc0 | (cp >> 6));
      byte(0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      byte(0xe0 | (cp >> 12));
      byte(0x80 | ((cp >> 6) & 0x3f));
      byte(0x80 | (cp & 0x3f));
    } else {
      byte(0xf0 | (cp >> 18));
      byte(0x80 | ((cp >> 12) & 0x3f));
      byte(0x80 | ((cp >> 6) & 0x3f));
      byte(0x80 | (cp & 0x3f));
    }
  }
  return out;
}

function hexToBits(hex: string): string {
  if (hex.length === 0) return '0';
  let bits = '';
  for (let i = 0; i < hex.length; i += 2) bits += parseInt(hex.slice(i, i + 2), 16).toString(2).padStart(8, '0');
  return bits;
}

function invalid(type: string): Error {
  return new Error(m().dialect.literal.invalid({ type }));
}

export function quoteLiteral(value: CellValue, type: string): string {
  if (value === null) return 'NULL';
  const kind = valueKind(type);
  if (kind === 'unsupported') throw new Error(m().dialect.literal.unsupported({ type }));
  if (typeof value === 'object') {
    // a binary value as the grid holds it: only complete values can be written back
    if (value.hex.length !== value.length * 2) throw new Error(m().dialect.literal.truncated);
    if (!HEX.test(value.hex)) throw invalid(type);
    if (kind === 'bit') return `b'${hexToBits(value.hex)}'`;
    return `X'${value.hex.toLowerCase()}'`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw invalid(type);
  const text = String(value);
  switch (kind) {
    case 'integer':
      if (!INTEGER.test(text)) throw invalid(type);
      return text;
    case 'decimal':
      if (!DECIMAL.test(text)) throw invalid(type);
      return text;
    case 'float':
      if (!FLOAT.test(text)) throw invalid(type);
      return text;
    case 'bit':
      if (!BITS.test(text)) throw invalid(type);
      return `b'${text}'`;
    case 'binary':
      return `X'${utf8Hex(text)}'`;
    default:
      if (NEEDS_HEX.test(text)) return `_utf8mb4 X'${utf8Hex(text)}'`;
      return `'${text.replace(/'/g, "''")}'`;
  }
}

export const quoteIdent = (name: string): string => '`' + name.replace(/`/g, '``') + '`';

/**
 * `UPDATE db.table SET … WHERE <every key column> = …` and where each SET value literal sits in the text, so a caller
 * can select the literal for the person to type over.
 */
export function buildUpdateLocated(spec: UpdateSpec): { sql: string; setValues: { from: number; to: number }[] } {
  if (spec.set.length === 0 || spec.where.length === 0) throw new Error(m().dialect.literal.noKey);
  const assign = spec.set.map((c) => ({ name: quoteIdent(c.column), literal: quoteLiteral(c.value, c.type) }));
  const match = spec.where.map((c) => {
    // "= NULL" never matches: a key value is never NULL
    if (c.value === null) throw new Error(m().dialect.literal.noKey);
    return `${quoteIdent(c.column)} = ${quoteLiteral(c.value, c.type)}`;
  });
  // one row by its whole key, and no LIMIT (unsafe with statement-based replication, and it would hide a stale key)
  let sql = `UPDATE ${quoteIdent(spec.database)}.${quoteIdent(spec.table)} SET `;
  const setValues: { from: number; to: number }[] = [];
  assign.forEach((a, i) => {
    sql += `${i > 0 ? ', ' : ''}${a.name} = `;
    setValues.push({ from: sql.length, to: sql.length + a.literal.length });
    sql += a.literal;
  });
  return { sql: `${sql} WHERE ${match.join(' AND ')}`, setValues };
}

export const buildUpdate = (spec: UpdateSpec): string => buildUpdateLocated(spec).sql;
