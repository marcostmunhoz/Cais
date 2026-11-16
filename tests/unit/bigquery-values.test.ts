import { describe, expect, it } from 'vitest';
import { columnMeta, decodeRow, formatTimestamp, toCell, typeText, type SchemaField } from '@main/drivers/bigquery/values';

const f = (type: string, extra: Partial<SchemaField> = {}): SchemaField => ({ name: 'c', type, ...extra });

describe('BigQuery column types', () => {
  it('uses the standard SQL names for the legacy REST ones', () => {
    expect(typeText(f('INTEGER'))).toBe('INT64');
    expect(typeText(f('FLOAT'))).toBe('FLOAT64');
    expect(typeText(f('BOOLEAN'))).toBe('BOOL');
    expect(typeText(f('STRING'))).toBe('STRING');
    expect(typeText(f('TIMESTAMP'))).toBe('TIMESTAMP');
  });

  it('writes STRUCT and ARRAY in full, nested', () => {
    const s = f('RECORD', { fields: [f('INTEGER', { name: 'a' }), f('STRING', { name: 'b', mode: 'REPEATED' })] });
    expect(typeText(s)).toBe('STRUCT<a INT64, b ARRAY<STRING>>');
    expect(typeText({ ...s, mode: 'REPEATED' })).toBe('ARRAY<STRUCT<a INT64, b ARRAY<STRING>>>');
    expect(typeText(f('RECORD', { fields: [f('RECORD', { name: 'in', fields: [f('FLOAT', { name: 'x' })] })] }))).toBe('STRUCT<in STRUCT<x FLOAT64>>');
  });

  it('keeps length, precision and scale, and the element type of a RANGE', () => {
    expect(typeText(f('STRING', { maxLength: '10' }))).toBe('STRING(10)');
    expect(typeText(f('NUMERIC', { precision: '10', scale: '2' }))).toBe('NUMERIC(10, 2)');
    expect(typeText(f('BIGNUMERIC', { precision: '40' }))).toBe('BIGNUMERIC(40)');
    expect(typeText(f('RANGE', { rangeElementType: { type: 'DATE' } }))).toBe('RANGE<DATE>');
  });

  it('is nullable unless REQUIRED', () => {
    expect(columnMeta(f('STRING', { mode: 'REQUIRED' }))).toEqual({ name: 'c', type: 'STRING', nullable: false });
    expect(columnMeta(f('STRING', { mode: 'NULLABLE' })).nullable).toBe(true);
    expect(columnMeta(f('STRING')).nullable).toBe(true);
  });
});

describe('BigQuery timestamps', () => {
  it('prints UTC with microseconds', () => {
    expect(formatTimestamp('1790845964123456')).toBe('2026-10-01 09:12:44.123456 UTC');
    expect(formatTimestamp('1790845964000000')).toBe('2026-10-01 09:12:44 UTC');
    expect(formatTimestamp('1790845964000001')).toBe('2026-10-01 09:12:44.000001 UTC');
  });
  it('handles the epoch, before it and the ends of the range', () => {
    expect(formatTimestamp('0')).toBe('1970-01-01 00:00:00 UTC');
    expect(formatTimestamp('-1')).toBe('1969-12-31 23:59:59.999999 UTC');
    expect(formatTimestamp('-62135596800000000')).toBe('0001-01-01 00:00:00 UTC');
    expect(formatTimestamp('253402300799999999')).toBe('9999-12-31 23:59:59.999999 UTC');
  });
  it('leaves what it cannot read as it came', () => {
    expect(formatTimestamp('1.79E9')).toBe('1.79E9');
  });
});

describe('BigQuery cell values', () => {
  it('keeps integers and decimals as text, without losing a digit', () => {
    expect(toCell('9223372036854775807', f('INTEGER'))).toBe('9223372036854775807');
    expect(toCell('-9223372036854775808', f('INT64'))).toBe('-9223372036854775808');
    expect(toCell('123456789012345678901234567890.123456789', f('NUMERIC'))).toBe('123456789012345678901234567890.123456789');
    expect(toCell('5.7896044618658097711785492504343953926634992332820282019728792003956564819968E+38', f('BIGNUMERIC'))).toContain('E+38');
  });

  it('reads FLOAT64 as a number and NaN or infinity as text', () => {
    expect(toCell('1.5', f('FLOAT'))).toBe(1.5);
    expect(toCell('-0.25', f('FLOAT64'))).toBe(-0.25);
    expect(toCell('NaN', f('FLOAT'))).toBe('NaN');
    expect(toCell('Infinity', f('FLOAT'))).toBe('Infinity');
    expect(toCell('-Infinity', f('FLOAT'))).toBe('-Infinity');
  });

  it('keeps BOOL, dates, times, intervals, ranges, geography and JSON as text', () => {
    expect(toCell('true', f('BOOLEAN'))).toBe('true');
    expect(toCell('false', f('BOOL'))).toBe('false');
    expect(toCell('2026-10-01', f('DATE'))).toBe('2026-10-01');
    expect(toCell('2026-10-01T09:12:44.123456', f('DATETIME'))).toBe('2026-10-01T09:12:44.123456');
    expect(toCell('09:12:44', f('TIME'))).toBe('09:12:44');
    expect(toCell('0-0 1 2:3:4', f('INTERVAL'))).toBe('0-0 1 2:3:4');
    expect(toCell('[2020-01-01, 2021-01-01)', f('RANGE'))).toBe('[2020-01-01, 2021-01-01)');
    expect(toCell('POINT(1 2)', f('GEOGRAPHY'))).toBe('POINT(1 2)');
    expect(toCell('{"a":1}', f('JSON'))).toBe('{"a":1}');
    expect(toCell('olá', f('STRING'))).toBe('olá');
  });

  it('turns a TIMESTAMP into UTC text', () => {
    expect(toCell('1790845964123456', f('TIMESTAMP'))).toBe('2026-10-01 09:12:44.123456 UTC');
  });

  it('shows BYTES as a hex preview cut at 256 bytes, with the real length', () => {
    expect(toCell(Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64'), f('BYTES'))).toEqual({ kind: 'binary', hex: 'deadbeef', length: 4 });
    const big = toCell(Buffer.alloc(1000, 1).toString('base64'), f('BYTES'));
    expect(big).toMatchObject({ kind: 'binary', length: 1000 });
    expect((big as { hex: string }).hex).toHaveLength(512);
  });

  it('turns STRUCT and ARRAY into JSON text', () => {
    const struct = f('RECORD', { fields: [f('INTEGER', { name: 'a' }), f('STRING', { name: 'b' }), f('TIMESTAMP', { name: 't' }), f('BOOLEAN', { name: 'ok' }), f('FLOAT', { name: 'x' })] });
    const raw = { f: [{ v: '1' }, { v: null }, { v: '0' }, { v: 'true' }, { v: '2.5' }] };
    expect(JSON.parse(toCell(raw, struct) as string)).toEqual({ a: '1', b: null, t: '1970-01-01 00:00:00 UTC', ok: true, x: 2.5 });
    const array = f('INTEGER', { mode: 'REPEATED' });
    expect(toCell([{ v: '1' }, { v: '2' }], array)).toBe('["1","2"]');
    expect(toCell([], array)).toBe('[]');
    const nested = f('RECORD', { mode: 'REPEATED', fields: [f('STRING', { name: 's', mode: 'REPEATED' })] });
    expect(JSON.parse(toCell([{ v: { f: [{ v: [{ v: 'x' }, { v: 'y' }] }] } }], nested) as string)).toEqual([{ s: ['x', 'y'] }]);
  });

  it('names an anonymous struct field by position', () => {
    const struct = f('RECORD', { fields: [{ type: 'INTEGER' }, { type: 'STRING' }] });
    expect(JSON.parse(toCell({ f: [{ v: '1' }, { v: 'a' }] }, struct) as string)).toEqual({ _0: '1', _1: 'a' });
  });

  it('null stays null', () => {
    expect(toCell(null, f('INTEGER'))).toBeNull();
    expect(toCell(undefined, f('RECORD'))).toBeNull();
    expect(toCell(null, f('STRING', { mode: 'REPEATED' }))).toBeNull();
  });

  it('decodes a whole row by schema', () => {
    const fields = [f('INTEGER', { name: 'n' }), f('STRING', { name: 's' })];
    expect(decodeRow({ f: [{ v: '7' }, { v: 'x' }] }, fields)).toEqual(['7', 'x']);
    expect(decodeRow({ f: [{ v: '7' }] }, fields)).toEqual(['7', null]);
  });
});
