import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { CellValue, ColumnMeta } from '../../src/shared/results';

// The renderer's format module reads `window` when it loads and is outside the node project: loaded by a variable path
const RENDERER_FORMAT = '../../src/renderer/lib/format';
type Selection = { r1: number; c1: number; r2: number; c2: number };
interface Format {
  copyValueText: (value: CellValue) => string;
  isPartialBinary: (value: CellValue) => boolean;
  isSingleCell: (sel: Selection | null) => boolean;
  toMarkdown: (columns: ColumnMeta[], rows: CellValue[][], sel: Selection | null) => string;
  toDelimited: (columns: ColumnMeta[], rows: CellValue[][], sel: Selection | null, separator: '\t' | ',') => string;
}
let f: Format;
beforeAll(async () => {
  vi.stubGlobal('window', { cais: { locale: 'pt-BR' } });
  vi.stubGlobal('document', { documentElement: {} });
  f = (await import(/* @vite-ignore */ RENDERER_FORMAT)) as Format;
});

const cols = (...defs: [string, string][]): ColumnMeta[] => defs.map(([name, type]) => ({ name, type }));
const bin = (hex: string, length: number): CellValue => ({ kind: 'binary', hex, length });

describe('copy value of a single cell', () => {
  it('is the value as the server sent it, with no quoting', () => {
    expect(f.copyValueText('Café "Aurora"')).toBe('Café "Aurora"');
    expect(f.copyValueText('linha 1\nlinha 2\tfim')).toBe('linha 1\nlinha 2\tfim');
    expect(f.copyValueText('a,b')).toBe('a,b');
    expect(f.copyValueText('{"a":1,"b":[1,2]}')).toBe('{"a":1,"b":[1,2]}');
    expect(f.copyValueText(42)).toBe('42');
    expect(f.copyValueText(0)).toBe('0');
    expect(f.copyValueText('')).toBe('');
  });
  it('NULL is the word NULL, so it differs from an empty string', () => {
    expect(f.copyValueText(null)).toBe('NULL');
    expect(f.copyValueText('NULL')).toBe('NULL');
    expect(f.copyValueText('')).not.toBe(f.copyValueText(null));
  });
  it('binary is 0x..., with an ellipsis when the driver cut it', () => {
    expect(f.copyValueText(bin('cafe', 2))).toBe('0xcafe');
    expect(f.isPartialBinary(bin('cafe', 2))).toBe(false);
    expect(f.copyValueText(bin('ca', 300))).toBe('0xca…');
    expect(f.isPartialBinary(bin('ca', 300))).toBe(true);
    for (const v of ['x', 1, null]) expect(f.isPartialBinary(v)).toBe(false);
  });
  it('a single cell is one row and one column of the selection', () => {
    expect(f.isSingleCell({ r1: 2, c1: 1, r2: 2, c2: 1 })).toBe(true);
    expect(f.isSingleCell({ r1: 2, c1: 1, r2: 3, c2: 1 })).toBe(false);
    expect(f.isSingleCell({ r1: 2, c1: 1, r2: 2, c2: 2 })).toBe(false);
    expect(f.isSingleCell(null)).toBe(false);
  });
  it('a range keeps the TSV with header', () => {
    const columns = cols(['id', 'int'], ['name', 'varchar']);
    const rows: CellValue[][] = [[1, 'a'], [2, 'b "q"']];
    expect(f.toDelimited(columns, rows, { r1: 0, c1: 0, r2: 1, c2: 1 }, '\t')).toBe('id\tname\n1\ta\n2\t"b ""q"""');
  });
});

describe('Markdown table', () => {
  const columns = cols(['id', 'int'], ['name', 'varchar'], ['price', 'decimal'], ['big', 'INT64'], ['when', 'datetime']);

  it('header, separator with right alignment for numbers, then the rows', () => {
    const rows: CellValue[][] = [[1, 'Aurora', '9.90', 7, '2024-01-02 03:04:05']];
    expect(f.toMarkdown(columns, rows, null)).toBe(
      ['| id | name | price | big | when |', '| ---: | --- | ---: | ---: | --- |', '| 1 | Aurora | 9.90 | 7 | 2024-01-02 03:04:05 |'].join('\n'),
    );
  });
  it('NULL as NULL and an empty string as an empty cell', () => {
    const c = cols(['a', 'varchar'], ['b', 'varchar'], ['c', 'varchar']);
    expect(f.toMarkdown(c, [[null, '', 'x']], null)).toBe('| a | b | c |\n| --- | --- | --- |\n| NULL |  | x |');
  });
  it('escapes the backslash first and then the pipe', () => {
    const c = cols(['v', 'varchar']);
    expect(f.toMarkdown(c, [['a|b']], null).split('\n')[2]).toBe('| a\\|b |');
    expect(f.toMarkdown(c, [['a\\b']], null).split('\n')[2]).toBe('| a\\\\b |');
    // a backslash and a pipe in the data: `\|` must not end up as one escaped pipe plus a stray backslash
    expect(f.toMarkdown(c, [['a\\|b']], null).split('\n')[2]).toBe('| a\\\\\\|b |');
  });
  it('always leaves a space before each pipe, even when the cell ends in a backslash', () => {
    const c = cols(['v', 'varchar'], ['w', 'varchar']);
    const line = f.toMarkdown(c, [['end\\', 'next']], null).split('\n')[2]!;
    expect(line).toBe('| end\\\\ | next |');
    expect(line).not.toMatch(/[^ ]\|[^ ]|[^ \\]\|$/);
  });
  it('escapes the column names too', () => {
    expect(f.toMarkdown(cols(['a|b', 'varchar']), [], null)).toBe('| a\\|b |\n| --- |');
  });
  it('line breaks become <br> and tabs become spaces', () => {
    const c = cols(['v', 'varchar']);
    expect(f.toMarkdown(c, [['l1\r\nl2\nl3\rl4\tx']], null).split('\n')[2]).toBe('| l1<br>l2<br>l3<br>l4 x |');
  });
  it('binary as cellText, with the ellipsis when cut; no truncation of long text', () => {
    const c = cols(['b', 'blob'], ['t', 'text']);
    const long = 'x'.repeat(5000);
    const out = f.toMarkdown(c, [[bin('ca', 300), long], [bin('cafe', 2), 'y']], null).split('\n');
    expect(out[2]).toBe(`| 0xca… | ${long} |`);
    expect(out[3]).toBe('| 0xcafe | y |');
  });
  it('follows the selection rectangle, and the whole result without one', () => {
    const rows: CellValue[][] = [[1, 'a', '1.5', 1, 'd1'], [2, 'b', '2.5', 2, 'd2'], [3, 'c', '3.5', 3, 'd3']];
    expect(f.toMarkdown(columns, rows, { r1: 1, c1: 1, r2: 2, c2: 2 })).toBe('| name | price |\n| --- | ---: |\n| b | 2.5 |\n| c | 3.5 |');
    expect(f.toMarkdown(columns, rows, { r1: 0, c1: 1, r2: 0, c2: 1 })).toBe('| name |\n| --- |\n| a |');
    expect(f.toMarkdown(columns, rows, null).split('\n')).toHaveLength(5);
  });
  it('no rows: only the header and the separator', () => {
    expect(f.toMarkdown(cols(['id', 'int']), [], null)).toBe('| id |\n| ---: |');
  });
});
