import type { Engine } from '../model';
import type { Dialect } from './types';
import { mysqlDialect } from './mysql';
import { m } from '../i18n';

const dialects: Record<Engine, Dialect> = {
  mysql: mysqlDialect,
};

export function getDialect(engine: Engine): Dialect {
  return dialects[engine];
}

/** "Nenhum comando sob o cursor.", in the current locale. Call it where the text is produced. */
export function noStatementMessage(): string {
  return m().dialect.noStatement;
}

const lineStart = (text: string, pos: number): number => text.lastIndexOf('\n', pos - 1) + 1;
const lineEnd = (text: string, pos: number): number => {
  const e = text.indexOf('\n', pos);
  return e === -1 ? text.length : e;
};

/** First index of the run of comment-only lines that sits directly above `start` (no blank line between). */
function commentBlockStart(text: string, start: number): number {
  let top = lineStart(text, start);
  while (top > 0) {
    const prevStart = lineStart(text, top - 1);
    const line = text.slice(prevStart, top - 1).trim();
    const isComment = line.startsWith('--') || line.startsWith('#') || (line.startsWith('/*') && line.endsWith('*/'));
    if (!isComment) break;
    top = prevStart;
  }
  return top;
}

/**
 * Picks the statement under the cursor, or -1 for none:
 * - inside a statement's range (comments directly above it count as part of it), or
 * - on the same line, after the `;` that ended it.
 * A blank line, or anything past the last statement on a later line, runs nothing.
 */
export function statementAtCursor(
  statements: { start: number; end: number; rangeEnd: number }[],
  cursor: number,
  text: string,
): number {
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i]!;
    if (cursor >= s.start && cursor <= s.rangeEnd) return i;
  }
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i]!;
    if (cursor > s.rangeEnd && cursor <= lineEnd(text, s.rangeEnd) && lineStart(text, cursor) === lineStart(text, s.rangeEnd)) {
      return i;
    }
  }
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i]!;
    const top = commentBlockStart(text, s.start);
    if (cursor >= top && cursor < s.start) {
      // only when nothing but the comment block precedes the cursor on those lines
      return i;
    }
  }
  return -1;
}
