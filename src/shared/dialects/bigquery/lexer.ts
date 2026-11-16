/**
 * GoogleSQL lexical rules (https://cloud.google.com/bigquery/docs/reference/standard-sql/lexical) shared by the
 * splitter and the classifier, so both see the same strings, comments and names the server does.
 *
 * Two points the documentation does not state (the spike found the server follows one rule in each, but the readings stay as a precaution) are read under both rules by the classifier, which refuses when the
 * readings differ: whether a backslash still keeps a quote from ending a raw string (`r'\''`), and whether a
 * backslash escapes inside a backtick name. `lex(text, escapes)` takes the rule as a flag.
 */
import { AGENT_LOCALE, messagesFor, type Locale } from '../../i18n';

/** GoogleSQL whitespace: ASCII only. */
export const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

const isWordStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isWordChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
const isQuote = (c: string | undefined): boolean => c === "'" || c === '"';

export type TokKind = 'word' | 'string' | 'ident' | 'param' | 'sysvar' | 'number' | 'punct' | 'comment';

export interface Tok {
  kind: TokKind;
  /** The source text of the token (a string or quoted name includes its quotes and prefix). */
  text: string;
  pos: number;
  end: number;
  /** False for a string, quoted name or block comment that runs to the end of the text. */
  closed: boolean;
  /** String with an r/R prefix. */
  raw?: boolean;
  /** String with three quotes. */
  triple?: boolean;
  /** The body of a string or quoted name has a backslash. */
  backslash?: boolean;
}

const STRING_PREFIXES = new Set(['r', 'b', 'rb', 'br']);
const NUMBER = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;
const SYSVAR = /^@@[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;

/** Ends of `#` and `--` comments: a line feed or a carriage return (the earlier one wins: reading the end sooner is the safe side). */
function lineEnd(text: string, from: number): number {
  let e = from;
  while (e < text.length && text[e] !== '\n' && text[e] !== '\r') e++;
  return e;
}

/**
 * Scans a quoted string or name that opens at `i` (the quote itself; a prefix is the caller's business).
 * A `flagged` literal (raw string, backtick name) follows `escapes`: true when a backslash skips the next character.
 * Any other string always skips it.
 */
function scanQuoted(text: string, i: number, flagged: boolean, escapes: boolean): { end: number; closed: boolean; triple: boolean; backslash: boolean } {
  const n = text.length;
  const q = text[i]!;
  const triple = q !== '`' && text[i + 1] === q && text[i + 2] === q;
  let j = i + (triple ? 3 : 1);
  let backslash = false;
  while (j < n) {
    const c = text[j]!;
    if (c === '\\') {
      backslash = true;
      if (!flagged || escapes) {
        j += 2;
        continue;
      }
      j++;
      continue;
    }
    if (triple) {
      if (c === q && text[j + 1] === q && text[j + 2] === q) return { end: j + 3, closed: true, triple, backslash };
    } else if (c === q) {
      return { end: j + 1, closed: true, triple, backslash };
    }
    j++;
  }
  return { end: n, closed: false, triple, backslash };
}

/** Tokens of the text, comments included. `escapes` is the rule for raw strings and backtick names (see the file header). */
export function lex(text: string, escapes = true): Tok[] {
  const out: Tok[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (isWs(c)) {
      i++;
      continue;
    }
    if (c === '#' || (c === '-' && text[i + 1] === '-')) {
      const end = lineEnd(text, i);
      out.push({ kind: 'comment', text: text.slice(i, end), pos: i, end, closed: true });
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      out.push({ kind: 'comment', text: text.slice(i, end), pos: i, end, closed: close !== -1 });
      i = end;
      continue;
    }
    if (isWordStart(c)) {
      let e = i + 1;
      while (e < n && isWordChar(text[e]!)) e++;
      const word = text.slice(i, e);
      if (isQuote(text[e]) && STRING_PREFIXES.has(word.toLowerCase())) {
        const raw = word.toLowerCase().includes('r');
        const s = scanQuoted(text, e, raw, escapes);
        out.push({ kind: 'string', text: text.slice(i, s.end), pos: i, end: s.end, closed: s.closed, raw, triple: s.triple, backslash: s.backslash });
        i = s.end;
        continue;
      }
      out.push({ kind: 'word', text: word, pos: i, end: e, closed: true });
      i = e;
      continue;
    }
    if (isQuote(c)) {
      const s = scanQuoted(text, i, false, escapes);
      out.push({ kind: 'string', text: text.slice(i, s.end), pos: i, end: s.end, closed: s.closed, raw: false, triple: s.triple, backslash: s.backslash });
      i = s.end;
      continue;
    }
    if (c === '`') {
      const s = scanQuoted(text, i, true, escapes); // like a raw string: both readings are tried
      out.push({ kind: 'ident', text: text.slice(i, s.end), pos: i, end: s.end, closed: s.closed, backslash: s.backslash });
      i = s.end;
      continue;
    }
    if (c === '@') {
      const sys = SYSVAR.exec(text.slice(i, i + 200));
      if (sys) {
        out.push({ kind: 'sysvar', text: sys[0], pos: i, end: i + sys[0].length, closed: true });
        i += sys[0].length;
        continue;
      }
      if (isWordStart(text[i + 1] ?? '')) {
        let e = i + 2;
        while (e < n && isWordChar(text[e]!)) e++;
        out.push({ kind: 'param', text: text.slice(i, e), pos: i, end: e, closed: true });
        i = e;
        continue;
      }
      out.push({ kind: 'punct', text: c, pos: i, end: i + 1, closed: true });
      i++;
      continue;
    }
    const prev = out[out.length - 1];
    const afterName = prev !== undefined && (prev.kind === 'word' || prev.kind === 'ident') && prev.end === i;
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? '') && !afterName)) {
      const num = NUMBER.exec(text.slice(i, i + 100));
      if (num) {
        out.push({ kind: 'number', text: num[0], pos: i, end: i + num[0].length, closed: true });
        i += num[0].length;
        continue;
      }
    }
    // one code point of punctuation (or of anything the language has no use for)
    const len = text.codePointAt(i)! > 0xffff ? 2 : 1;
    out.push({ kind: 'punct', text: text.slice(i, i + len), pos: i, end: i + len, closed: true });
    i += len;
  }
  return out;
}

/** Upper case for ASCII letters only. */
export const asciiUpper = (s: string): string => s.replace(/[a-z]/g, (ch) => ch.toUpperCase());

/** The text of a backtick name, without the quotes and with `\x` read as `x`. */
export function unquoteIdent(tok: Tok): string {
  return tok.text.slice(1, tok.closed ? -1 : undefined).replace(/\\(.)/gs, '$1');
}

/** The dot-separated parts of a name token: a word is one part, a backtick name may hold a whole path (`proj.ds.t`). */
export function nameParts(tok: Tok): string[] {
  return tok.kind === 'ident' ? unquoteIdent(tok).split('.') : [tok.text];
}

/**
 * Why SQL written by an agent could read differently to a person (CodeMirror, `GOOGLESQL` in renderer/lib/codemirrorDialects.ts) than to
 * the server, or null:
 * - a character outside ASCII in the code itself (outside strings, `quoted names` and comments), or a non-ASCII
 *   quoted name right before "(" (a function) or right after @ or ? (a parameter);
 * - "/*" inside a block comment (the highlighter nests them, GoogleSQL does not), a carriage return that ends a
 *   line comment for the server but not for the highlighter;
 * - strings of three quotes (the highlighter reads `'''a'''` as three strings);
 * - `#legacySQL` and `#standardSQL`;
 * - a raw string with a backslash (the documentation does not state the rule; refused as a precaution) and
 *   a backtick name with a backslash (the highlighter has no escapes there): the end may be elsewhere. A raw
 *   string without a backslash ends in the same place under every reading, so it passes;
 * - the letter x glued to a quote (`x'41'`): the highlighter reads it as a hex number and loses the string;
 * - a `--` comment with no space or tab after the dashes and a string with a `b` prefix (`b'a'`, `rb'a'`, `br'a'`):
 *   a reading with MySQL's rules (no space after the dashes is not a comment; `b'` opens a bit literal) differs.
 * The text goes to the agent that sent the SQL, so it is in `AGENT_LOCALE` (pt-BR, fixed) unless asked otherwise.
 */
/**
 * The GoogleSQL chained call, `(x).fn()` or `(x).(ds.fn)()`: the function is named after the expression, where the
 * path scan of the classifier does not look for calls. Refused for agents (when in doubt, refuse): a "." that does not
 * follow a name and leads to a call, or a ")" glued to a "(".
 */
function isChainedCall(tokens: Tok[], k: number): boolean {
  const tk = tokens[k]!;
  const isP = (t: Tok | undefined, p: string): boolean => t !== undefined && t.kind === 'punct' && t.text === p;
  const isN = (t: Tok | undefined): boolean => t !== undefined && (t.kind === 'word' || t.kind === 'ident');
  if (tk.text === ')') return isP(tokens[k + 1], '(');
  if (tk.text !== '.') return false;
  if (isP(tokens[k + 1], '(')) return true;
  if (isN(tokens[k - 1])) return false;
  let j = k + 1;
  if (!isN(tokens[j])) return false;
  while (isP(tokens[j + 1], '.') && isN(tokens[j + 2])) j += 2;
  return isP(tokens[j + 1], '(');
}

export function agentCodeProblem(text: string, locale: Locale = AGENT_LOCALE): string | null {
  const msg = messagesFor(locale).dialect.bigquery.agentCode;
  const tokens = lex(text, true);
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k]!;
    switch (tk.kind) {
      case 'comment':
        if (tk.text.startsWith('/*')) {
          if (tk.text.slice(2, Math.max(2, tk.text.length - (tk.closed ? 2 : 0))).includes('/*')) return msg.nestedComment;
        } else {
          if (/^#\s*(legacysql|standardsql)/i.test(tk.text)) return msg.legacyDirective;
          // the stock MySQL reading wants a space after the dashes; GoogleSQL does not
          if (tk.text.startsWith('--') && tk.text.length > 2 && !/[ \t]/.test(tk.text[2]!)) return msg.dashComment;
          if (text[tk.end] === '\r' && text[tk.end + 1] !== '\n') return msg.carriageReturn;
        }
        break;
      case 'string':
        if (tk.triple) return msg.tripleQuote;
        if (tk.raw && tk.backslash) return msg.rawBackslash;
        if (/^[a-z]*b/i.test(tk.text.slice(0, 2)) && !isQuote(tk.text[0])) return msg.bytesPrefix;
        if (text[tk.pos - 1] === '@' || text[tk.pos - 1] === '?') return msg.quotedVariable;
        break;
      case 'ident': {
        if (tk.backslash) return msg.backslashIdent;
        if (text[tk.pos - 1] === '@' || text[tk.pos - 1] === '?') return msg.quotedVariable;
        if (/[^\x00-\x7f]/.test(tk.text)) {
          const next = tokens[k + 1];
          const before = tokens[k - 1];
          const isTable = before?.kind === 'word' && /^(INTO|TABLE|UPDATE|WITH|RECURSIVE|INSERT|MERGE)$/i.test(before.text);
          if (next?.kind === 'punct' && next.text === '(' && !isTable) return msg.nonAsciiFunction({ name: tk.text });
        }
        break;
      }
      case 'word':
        if ((tk.text === 'x' || tk.text === 'X') && isQuote(text[tk.end]) && text[tk.end] === "'") return msg.hexPrefix;
        break;
      case 'punct': {
        if (isChainedCall(tokens, k)) return msg.chainedCall;
        const code = tk.text.codePointAt(0)!;
        if (code > 0x7f) {
          return msg.nonAsciiCode({ marker: `⟨U+${code.toString(16).toUpperCase().padStart(4, '0')}⟩`, char: tk.text });
        }
        break;
      }
      default:
        break;
    }
  }
  return null;
}
