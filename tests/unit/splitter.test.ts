import { describe, expect, it } from 'vitest';
import { splitStatements } from '@shared/dialects/mysql/splitter';
import { statementAtCursor } from '@shared/dialects/registry';
import { mysqlDialect } from '@shared/dialects/mysql';

const texts = (sql: string) => splitStatements(sql).map((s) => s.text);

describe('splitStatements', () => {
  it('splits simple statements and keeps positions in the original text', () => {
    const sql = 'SELECT 1;\n  SELECT 2 ;SELECT 3';
    const parts = splitStatements(sql);
    expect(parts.map((p) => p.text)).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
    for (const p of parts) expect(sql.slice(p.start, p.end)).toBe(p.text);
    expect(parts[0]!.rangeEnd).toBe(9);
  });

  it('ignores semicolons inside strings, identifiers and escapes', () => {
    expect(texts("SELECT 'a;b', \"c;d\", `e;f`; SELECT 2")).toEqual(["SELECT 'a;b', \"c;d\", `e;f`", 'SELECT 2']);
    expect(texts("SELECT 'it\\'s; ok'; SELECT 2")).toEqual(["SELECT 'it\\'s; ok'", 'SELECT 2']);
    expect(texts("SELECT 'it''s; ok'; SELECT 2")).toEqual(["SELECT 'it''s; ok'", 'SELECT 2']);
    expect(texts('SELECT `a``;b`; SELECT 2')).toEqual(['SELECT `a``;b`', 'SELECT 2']);
  });

  it('ignores semicolons inside comments and drops comment-only statements', () => {
    const sql = '-- one; two\nSELECT 1; # three; four\nSELECT /* five; six */ 2;\n/* only comment */;';
    expect(texts(sql)).toEqual(['SELECT 1', 'SELECT /* five; six */ 2']);
  });

  it('requires whitespace after the double dash', () => {
    expect(texts('SELECT 5--1; SELECT 2')).toEqual(['SELECT 5--1', 'SELECT 2']);
  });

  it('treats executable comments as statement content', () => {
    expect(texts('/*!40101 SET NAMES utf8 */; SELECT 1')).toEqual(['/*!40101 SET NAMES utf8 */', 'SELECT 1']);
  });

  it('handles DELIMITER commands without emitting them', () => {
    const sql = 'DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END//\nDELIMITER ;\nSELECT 3;';
    expect(texts(sql)).toEqual(['CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', 'SELECT 3']);
  });

  it('returns nothing for blank input', () => {
    expect(splitStatements('  \n ; ; ')).toEqual([]);
  });

  it('keeps an unterminated string until the end', () => {
    expect(texts("SELECT 'abc; SELECT 2")).toEqual(["SELECT 'abc; SELECT 2"]);
  });
});

describe('statementAtCursor', () => {
  const at = (sql: string, cursor: number) => statementAtCursor(splitStatements(sql), cursor, sql);

  it('picks the statement containing the cursor, including right after its semicolon', () => {
    const sql = 'SELECT 1;\n\nSELECT 2;';
    expect(at(sql, 3)).toBe(0);
    expect(at(sql, 9)).toBe(0);
    expect(at(sql, 12)).toBe(1);
  });

  it('a blank line between statements runs nothing', () => {
    expect(at('SELECT 1;\n\nSELECT 2;', 10)).toBe(-1);
  });

  it('after the semicolon on the same line (even over a trailing comment) is that statement', () => {
    const sql = 'SELECT 1;  -- trailing\nSELECT 2;';
    expect(at(sql, 11)).toBe(0);
    expect(at(sql, sql.indexOf('trailing'))).toBe(0);
    expect(at('SELECT 1;  SELECT 2;', 10)).toBe(0);
  });

  it('a comment directly above a statement belongs to it, a blank line breaks the link', () => {
    const sql = 'DELETE FROM a;\n\n-- now the select\nSELECT 2;';
    expect(at(sql, sql.indexOf('now'))).toBe(1);
    expect(at(sql, sql.indexOf('SELECT 2'))).toBe(1);
    expect(at(sql, 15)).toBe(-1); // the blank line
    const stacked = 'DELETE FROM a;\n-- one\n-- two\nSELECT 2;';
    expect(at(stacked, stacked.indexOf('one'))).toBe(1);
    const separated = 'DELETE FROM a;\n-- note\n\nSELECT 2;';
    expect(at(separated, separated.indexOf('note'))).toBe(-1);
  });

  it('past the last statement on a later line, or in empty text, runs nothing', () => {
    expect(at('SELECT 1;\n\n', 11)).toBe(-1);
    expect(at('SELECT 1;\n  ', 12)).toBe(-1);
    expect(at('', 0)).toBe(-1);
    expect(at('  \nSELECT 1', 0)).toBe(-1);
  });

  it('inside a multi-line statement, even on a blank line within it', () => {
    const sql = 'SELECT 1\n\nFROM t;';
    expect(at(sql, 9)).toBe(0);
  });
});

// Gerar UPDATE appends `;`-terminated statements to the editor: each one must split on its own, whatever the
// script leaves open, and the person's own text must not change.
describe('appendStatements (MySQL)', () => {
  const updates = 'UPDATE t SET a = 1 WHERE id = 1;\nUPDATE t SET a = 2 WHERE id = 2;';
  const apply = (doc: string) => {
    const { changes, selection } = mysqlDialect.appendStatements(doc, updates);
    // as CodeMirror applies them: positions in the original text, inserts at the same position in order
    let out = '';
    let pos = 0;
    for (const c of [...changes].sort((a, b) => a.from - b.from)) {
      out += doc.slice(pos, c.from) + c.insert;
      pos = c.from;
    }
    out += doc.slice(pos);
    return { out, selection };
  };
  it.each([
    ['', [] as string[]],
    ['SELECT 1;', ['SELECT 1']],
    ['SELECT 1', ['SELECT 1']],
    ['SELECT 1 -- note', ['SELECT 1']],
    ['DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; END //', ['CREATE PROCEDURE p() BEGIN SELECT 1; END']],
    ['DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; END //\n', ['CREATE PROCEDURE p() BEGIN SELECT 1; END']],
    ['DELIMITER //\nSELECT 1', ['SELECT 1']],
    ['DELIMITER $$\nSELECT a$', ['SELECT a$']],
  ])('%j', (doc, before) => {
    const { out, selection } = apply(doc);
    expect(texts(out)).toEqual([...before, 'UPDATE t SET a = 1 WHERE id = 1', 'UPDATE t SET a = 2 WHERE id = 2']);
    expect(out.slice(selection.from, selection.to)).toBe(updates);
    // the person's text is kept: at most a delimiter is added after an unterminated last statement
    const inserts = mysqlDialect.appendStatements(doc, updates).changes.filter((c) => c.from < doc.length);
    expect(inserts.every((c) => /^ ?(;|\/\/|\$\$)$/.test(c.insert))).toBe(true);
    if (inserts.length === 0) expect(out.startsWith(doc)).toBe(true);
  });

  it('never puts a ; inside a DELIMITER block', () => {
    const doc = 'DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; END //';
    expect(apply(doc).out).not.toContain('END;');
  });
});
