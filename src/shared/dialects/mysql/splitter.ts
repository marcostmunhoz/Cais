import type { SqlStatement } from '../types';
import { isWs, scanSpecial } from './lexer';

const isSpace = isWs;

/**
 * Splits MySQL text into statements.
 * Respects '..', "..", `..` (with escapes), comments (-- , #, block, executable /*! ... *\/)
 * and DELIMITER client commands (never emitted as statements).
 */
export function splitStatements(sql: string): SqlStatement[] {
  return scan(sql).statements;
}

/** The statements, the delimiter in effect at the end, and whether the last statement has no delimiter. */
function scan(sql: string): { statements: SqlStatement[]; delimiter: string; open: boolean } {
  const out: SqlStatement[] = [];
  const n = sql.length;
  let delimiter = ';';
  let i = 0;
  let start = -1; // first content char of the current statement
  let contentEnd = -1; // exclusive end of the last content char

  const flush = (rangeEnd: number): void => {
    if (start !== -1) {
      out.push({ text: sql.slice(start, contentEnd), start, end: contentEnd, rangeEnd });
    }
    start = -1;
    contentEnd = -1;
  };

  while (i < n) {
    const c = sql[i]!;

    if (isSpace(c)) {
      i++;
      continue;
    }

    if (sql.startsWith(delimiter, i)) {
      flush(i + delimiter.length);
      i += delimiter.length;
      continue;
    }

    const special = scanSpecial(sql, i);
    if (special && (special.type === 'comment' || special.type === 'exec-comment')) {
      if (special.type === 'exec-comment') {
        // executable comment: it is part of the statement
        if (start === -1) start = i;
        contentEnd = special.end;
      }
      i = special.end;
      continue;
    }

    // DELIMITER client command, only where a statement could begin
    if (
      start === -1 &&
      (c === 'd' || c === 'D') &&
      sql.slice(i, i + 9).toLowerCase() === 'delimiter' &&
      i + 9 < n &&
      (sql[i + 9] === ' ' || sql[i + 9] === '\t')
    ) {
      let eol = sql.indexOf('\n', i);
      if (eol === -1) eol = n;
      const next = sql.slice(i + 9, eol).trim();
      if (next) delimiter = next;
      i = eol;
      continue;
    }

    if (start === -1) start = i;

    if (special) {
      i = special.end;
      contentEnd = i;
      continue;
    }

    i++;
    contentEnd = i;
  }

  const open = start !== -1;
  flush(n);
  return { statements: out, delimiter, open };
}

/**
 * How to append `;`-terminated statements to the end of a script so each one splits on its own: the last
 * statement, if unterminated, is ended with the delimiter in effect there (never a `;` inside a DELIMITER
 * block), and a `DELIMITER ;` line goes first when another delimiter is still in effect.
 */
export function appendStatements(doc: string, text: string): { changes: { from: number; insert: string }[]; selection: { from: number; to: number } } {
  const { statements, delimiter, open } = scan(doc);
  const changes: { from: number; insert: string }[] = [];
  const last = statements[statements.length - 1];
  let before = 0;
  if (open && last) {
    // "END$" + "$$" would read as "END" + "$$" + "$": a custom delimiter goes after a space
    const end = delimiter === ';' ? ';' : ` ${delimiter}`;
    changes.push({ from: last.end, insert: end });
    before = end.length;
  }
  let prefix = doc.length === 0 ? '' : doc.endsWith('\n') ? '\n' : '\n\n';
  if (delimiter !== ';') prefix += 'DELIMITER ;\n';
  changes.push({ from: doc.length, insert: prefix + text });
  const from = doc.length + before + prefix.length;
  return { changes, selection: { from, to: from + text.length } };
}
