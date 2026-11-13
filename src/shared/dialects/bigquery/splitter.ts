import type { SqlStatement } from '../types';
import { asciiUpper, lex, type Tok } from './lexer';

/** Words that open a block of commands when one starts a statement (`END <word>` closes it). */
const BLOCK_OPENERS = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR', 'CASE']);
/** The word after END that names what it closes. */
const END_TARGETS = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR', 'CASE']);

interface Scan {
  statements: SqlStatement[];
  /** The last statement has no `;`. */
  open: boolean;
}

const isWord = (t: Tok | undefined, w?: string): boolean => t !== undefined && t.kind === 'word' && (w === undefined || asciiUpper(t.text) === w);
const isPunct = (t: Tok | undefined, p: string): boolean => t !== undefined && t.kind === 'punct' && t.text === p;

/**
 * Splits GoogleSQL text into statements. `;` ends one outside strings, comments, names and blocks. A script block
 * stays whole (a script is one command): `BEGIN … END`, `IF … END IF`, `LOOP … END LOOP`, `WHILE … END WHILE`,
 * `REPEAT … END REPEAT`, `FOR … END FOR`, `CASE … END CASE`, and `CREATE PROCEDURE … BEGIN … END`. Not blocks:
 * `BEGIN;` and `BEGIN TRANSACTION` (transaction control), a CASE expression and the function IF(…). A block that
 * is never closed takes the rest of the text, so a script can never be split into pieces that look harmless.
 */
export function splitStatements(sql: string): SqlStatement[] {
  return scan(sql).statements;
}

function scan(sql: string): Scan {
  const tokens = lex(sql, true).filter((t) => t.kind !== 'comment');
  const statements: SqlStatement[] = [];
  let first = -1; // index of the first token of the current statement
  let blocks = 0; // open script blocks
  let parens = 0;
  let exprCase = 0; // open CASE expressions
  let atStart = true; // the next token begins a statement (or a statement of a block)
  let procedure = false; // the statement is CREATE … PROCEDURE: its BEGIN opens a block
  let awaitDo = false; // FOR / WHILE header: the DO that ends it starts the body
  let sinceStart = 0; // tokens seen since the statement began

  const flush = (semi: Tok | null): void => {
    if (first !== -1) {
      const a = tokens[first]!;
      const b = tokens[semi ? tokens.indexOf(semi) - 1 : tokens.length - 1]!;
      statements.push({ text: sql.slice(a.pos, b.end), start: a.pos, end: b.end, rangeEnd: semi ? semi.end : b.end });
    }
    first = -1;
  };

  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k]!;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];

    if (isPunct(tk, ';') && blocks === 0) {
      flush(tk);
      parens = 0;
      atStart = true;
      procedure = false;
      awaitDo = false;
      exprCase = 0;
      sinceStart = 0;
      continue;
    }
    if (first === -1) first = k;

    if (isPunct(tk, ';')) {
      // inside a block: the next statement of the body begins
      parens = 0;
      atStart = true;
      sinceStart = 0;
      continue;
    }
    if (isPunct(tk, '(')) parens++;
    else if (isPunct(tk, ')')) parens = Math.max(0, parens - 1);

    // a label: `name:` right before a block
    if (sinceStart === 1 && isPunct(tk, ':') && (isWord(prev) || prev?.kind === 'ident')) {
      atStart = true;
      sinceStart = 0;
      continue;
    }

    const word = tk.kind === 'word' && !isPunct(prev, '.') ? asciiUpper(tk.text) : null;
    const startedHere = atStart;
    atStart = false;
    sinceStart++;
    if (word === null) continue;

    if (startedHere && parens === 0) {
      if (word === 'BEGIN') {
        // BEGIN; and BEGIN TRANSACTION are transaction control
        if (next !== undefined && !isPunct(next, ';') && !isWord(next, 'TRANSACTION')) {
          blocks++;
          atStart = true;
          sinceStart = 0;
        }
        continue;
      }
      if (BLOCK_OPENERS.has(word)) {
        blocks++;
        if (word === 'LOOP' || word === 'REPEAT') {
          atStart = true;
          sinceStart = 0;
        } else if (word === 'FOR' || word === 'WHILE') {
          awaitDo = true;
        }
        continue;
      }
      if (word === 'CREATE') {
        // CREATE [OR REPLACE] PROCEDURE: look a few tokens ahead
        for (let j = k + 1; j < Math.min(tokens.length, k + 6); j++) {
          if (isWord(tokens[j], 'PROCEDURE')) procedure = true;
        }
        continue;
      }
    }

    if (parens !== 0) {
      if (word === 'CASE') exprCase++;
      else if (word === 'END' && exprCase > 0) exprCase--;
      continue;
    }

    if (word === 'CASE') {
      exprCase++;
    } else if (word === 'END') {
      if (exprCase > 0) {
        exprCase--;
      } else if (blocks > 0) {
        blocks--;
        // END IF, END LOOP… name what they close: that second word is not a new block or a CASE expression
        if (next?.kind === 'word' && END_TARGETS.has(asciiUpper(next.text))) k++;
      }
    } else if (word === 'BEGIN' && procedure && blocks === 0) {
      blocks++;
      atStart = true;
      sinceStart = 0;
      procedure = false;
    } else if (blocks > 0 && exprCase === 0) {
      // the bodies of IF / CASE statements, WHILE / FOR loops and EXCEPTION handlers start statements
      if (word === 'THEN' || word === 'ELSE' || (word === 'DO' && awaitDo)) {
        atStart = true;
        sinceStart = 0;
        if (word === 'DO') awaitDo = false;
      }
    }
  }

  const open = first !== -1;
  flush(null);
  return { statements, open };
}

/**
 * How to append `;`-terminated statements to the end of a script so each one splits on its own: the last
 * statement, if it has no `;`, is ended with one, and the new statements go after a blank line.
 */
export function appendStatements(doc: string, text: string): { changes: { from: number; insert: string }[]; selection: { from: number; to: number } } {
  const { statements, open } = scan(doc);
  const changes: { from: number; insert: string }[] = [];
  const last = statements[statements.length - 1];
  let before = 0;
  if (open && last) {
    changes.push({ from: last.end, insert: ';' });
    before = 1;
  }
  const prefix = doc.length === 0 ? '' : doc.endsWith('\n') ? '\n' : '\n\n';
  changes.push({ from: doc.length, insert: prefix + text });
  const from = doc.length + before + prefix.length;
  return { changes, selection: { from, to: from + text.length } };
}
