import { describe, expect, it } from 'vitest';
import { errorSpan } from '@shared/estimate';

describe('where a server error points in the statement', () => {
  it('the word at "at [line:column]" (1-based)', () => {
    const sql = 'SELECT FROM vendas.pedidos';
    expect(errorSpan(sql, 'Syntax error: Unexpected keyword FROM at [1:8]')).toEqual({ from: 7, to: 11 });
    expect(sql.slice(7, 11)).toBe('FROM');
  });

  it('counts lines, so the mark lands on the right line of a statement that spans several', () => {
    const sql = 'SELECT id,\n       valr\nFROM vendas.pedidos';
    const span = errorSpan(sql, 'Unrecognized name: valr at [2:8]');
    expect(sql.slice(span.from, span.to)).toBe('valr');
  });

  it('a quoted or dotted path is one word', () => {
    const sql = 'SELECT * FROM `proj.ds.t`';
    const span = errorSpan(sql, 'Not found: Table proj:ds.t at [1:15]');
    expect(sql.slice(span.from, span.to)).toBe('`proj.ds.t`');
  });

  it('a symbol that is not part of a word is one character', () => {
    const sql = 'SELECT 1 +';
    const span = errorSpan(sql, 'Syntax error: Unexpected end of script at [1:10]');
    expect(sql.slice(span.from, span.to)).toBe('+');
  });

  it('no place, or one outside the text, is the whole statement', () => {
    const sql = 'SELECT 1';
    const whole = { from: 0, to: sql.length };
    expect(errorSpan(sql, 'Access Denied')).toEqual(whole);
    expect(errorSpan(sql, undefined)).toEqual(whole);
    expect(errorSpan(sql, 'x at [9:1]')).toEqual(whole);
    expect(errorSpan(sql, 'x at [1:99]')).toEqual(whole);
    expect(errorSpan(sql, 'x at [0:0]')).toEqual(whole);
    expect(errorSpan('', 'x at [1:1]')).toEqual({ from: 0, to: 0 });
  });
});
