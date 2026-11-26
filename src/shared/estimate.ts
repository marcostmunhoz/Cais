// The dry run of a statement while it is typed: where the server's error points. Pure TypeScript.

/**
 * Where in `statement` a server error points, as offsets into the statement: the word at the "at [line:column]" the
 * server writes in its messages (1-based; a syntax error or an unknown name says where), or the whole statement when
 * the message gives no place (or one outside the text).
 */
export function errorSpan(statement: string, serverText: string | undefined): { from: number; to: number } {
  const whole = { from: 0, to: statement.length };
  const at = /\bat \[(\d+):(\d+)\]/.exec(serverText ?? '');
  if (!at) return whole;
  const line = Number(at[1]);
  const column = Number(at[2]);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) return whole;
  let from = 0;
  for (let n = 1; n < line; n++) {
    const next = statement.indexOf('\n', from);
    if (next === -1) return whole;
    from = next + 1;
  }
  from += column - 1;
  if (from >= statement.length) return whole;
  // the word the position falls on (a quoted name or a dotted path counts as one); a lone symbol is one character
  const word = /^[`\w.$-]+/u.exec(statement.slice(from));
  const to = Math.min(statement.length, from + Math.max(1, word?.[0].length ?? 1));
  return { from, to };
}
