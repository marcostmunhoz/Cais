/**
 * MySQL lexical rules shared by the splitter and the classifier, so both see the same
 * strings, comments and identifiers the server does.
 */
import { AGENT_LOCALE, m, messagesFor, type Locale } from '../../i18n';

/** ASCII whitespace only (MySQL's my_isspace). NBSP, BOM etc. are identifier bytes for the server. */
export const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

/** "-- " starts a comment only when followed by a space or a control character (or the end). */
export function startsDashComment(text: string, i: number): boolean {
  if (text[i] !== '-' || text[i + 1] !== '-') return false;
  if (i + 2 >= text.length) return true;
  const code = text.charCodeAt(i + 2);
  return code <= 0x20 || code === 0x7f;
}

export type Scanned =
  | { type: 'comment'; end: number }
  /** /*! ... *\/ and /*M! ... *\/: the content is code, only the opener is skipped (`opener` chars). */
  | { type: 'exec-comment'; end: number; opener: number }
  | { type: 'string' | 'ident'; end: number };

/** Scans a comment, string or quoted identifier starting at `i`; null when `i` starts none of them. */
export function scanSpecial(text: string, i: number, backslash = true): Scanned | null {
  const c = text[i]!;
  const n = text.length;
  if (startsDashComment(text, i) || c === '#') {
    let end = i;
    while (end < n && text[end] !== '\n') end++;
    return { type: 'comment', end };
  }
  if (c === '/' && text[i + 1] === '*') {
    const close = text.indexOf('*/', i + 2);
    const end = close === -1 ? n : close + 2;
    const bang = text[i + 2] === '!' ? 3 : text[i + 2] === 'M' && text[i + 3] === '!' ? 4 : 0;
    if (bang) {
      let opener = i + bang;
      while (opener < n && text[opener]! >= '0' && text[opener]! <= '9') opener++;
      return { type: 'exec-comment', end, opener: opener - i };
    }
    return { type: 'comment', end };
  }
  if (c === "'" || c === '"' || c === '`') {
    let k = i + 1;
    while (k < n) {
      const d = text[k]!;
      if (d === '\\' && c !== '`' && backslash) {
        k += 2;
        continue;
      }
      if (d === c) {
        k++;
        break;
      }
      k++;
    }
    return { type: c === '`' ? 'ident' : 'string', end: Math.min(k, n) };
  }
  return null;
}

export interface CommentFacts {
  /** `/*!NNNNN ... *\/` or `/*M! ... *\/`: the server may run the content or skip it, depending on its version. */
  versioned: boolean;
  /** `/*! ... *\/` with no version: always code for the server. */
  executable: boolean;
  /** An optimizer hint (`/*+ ... *\/`) that changes a session variable (SET_VAR) or the time limit. */
  setVarHint: boolean;
}

/**
 * What the comments of a statement can do, looked at under both string rules (with and without backslash
 * escapes), so a comment opener hidden inside what one rule calls a string is still seen.
 */
export function commentFacts(text: string): CommentFacts {
  const facts: CommentFacts = { versioned: false, executable: false, setVarHint: false };
  for (const backslash of [true, false]) {
    let i = 0;
    const n = text.length;
    while (i < n) {
      const s = scanSpecial(text, i, backslash);
      if (!s) {
        i++;
        continue;
      }
      if (s.type === 'exec-comment') {
        const versioned = text[i + 2] === 'M' || /[0-9]/.test(text[i + 3] ?? '');
        if (versioned) facts.versioned = true;
        else facts.executable = true;
        i += s.opener; // the content is code: keep scanning inside it
        continue;
      }
      if (s.type === 'comment' && text[i] === '/' && text[i + 2] === '+') {
        if (/SET_VAR|MAX_EXECUTION_TIME/i.test(text.slice(i, s.end))) facts.setVarHint = true;
      }
      i = s.end;
    }
  }
  return facts;
}

/**
 * Why SQL written by an agent could read differently to a person than to the server, or null:
 * - a character outside ASCII in the code itself (outside strings, `quoted names` and comments): MySQL takes
 *   NBSP and other non-ASCII characters as part of a name (so "WHERE<NBSP>id" is an alias, not a WHERE), and
 *   matches function and variable names ignoring accents;
 * - a non-ASCII name right after @ (user variable) or right before "(" (function), even quoted;
 * - "/*" inside a block comment: MySQL ends the comment at the first "*\/", the review highlighter nests.
 * Looked at under both string rules. The text goes to the agent that sent the SQL, so it is in `AGENT_LOCALE`
 * (pt-BR, fixed) unless another locale is asked for.
 */
export function agentCodeProblem(text: string, locale: Locale = AGENT_LOCALE): string | null {
  const msg = messagesFor(locale).dialect.agentCode;
  const n = text.length;
  for (const backslash of [true, false]) {
    let i = 0;
    while (i < n) {
      const s = scanSpecial(text, i, backslash);
      if (s) {
        if (s.type === 'comment' && text[i] === '/' && text.slice(i + 2, Math.max(i + 2, s.end - 2)).includes('/*')) {
          return msg.nestedComment;
        }
        if (s.type === 'comment' && text[i] === '-' && text[i + 2] !== ' ') {
          // MySQL also starts a comment at "--" + tab or line break; the review highlighter only at "-- "
          return msg.dashComment;
        }
        if ((s.type === 'ident' || s.type === 'string') && text[i - 1] === '@') {
          return msg.quotedVariable;
        }
        if (s.type === 'ident' && /[^\x00-\x7f]/.test(text.slice(i, s.end))) {
          let after = s.end;
          while (after < n && isWs(text[after]!)) after++;
          const before = /([A-Za-z_]+)\s*$/.exec(text.slice(Math.max(0, i - 40), i))?.[1]?.toUpperCase();
          const tableOrCte = before !== undefined && ['INTO', 'TABLE', 'REFERENCES', 'UPDATE', 'WITH', 'RECURSIVE', 'INSERT', 'REPLACE'].includes(before);
          if (text[after] === '(' && !tableOrCte) {
            return msg.nonAsciiFunction({ name: text.slice(i, s.end) });
          }
        }
        i = s.type === 'exec-comment' ? i + s.opener : s.end;
        continue;
      }
      const code = text.codePointAt(i)!;
      if (code > 0x7f) {
        const c = String.fromCodePoint(code);
        return msg.nonAsciiCode({ marker: `⟨U+${code.toString(16).toUpperCase().padStart(4, '0')}⟩`, char: c });
      }
      i += 1;
    }
  }
  return null;
}

/** The text with versioned executable comments (`/*!NNNNN`, `/*M!`) turned into plain spaces: the reading of a server that skips them. */
export function withoutVersionedComments(text: string, backslash = true): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const s = scanSpecial(text, i, backslash);
    if (!s) {
      out += text[i];
      i++;
      continue;
    }
    const versioned = s.type === 'exec-comment' && (text[i + 2] === 'M' || /[0-9]/.test(text[i + 3] ?? ''));
    out += versioned ? ' ' : text.slice(i, s.end);
    i = s.end;
  }
  return out;
}

/**
 * The statement as the server would see its code: strings and quoted identifiers become a
 * placeholder, comments become a space, executable comments (/*! *\/) are kept as code.
 * Used by the conservative danger scan.
 */
export function codeOnly(text: string, backslash = true): string {
  let out = '';
  let execOpen = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const s = scanSpecial(text, i, backslash);
    if (s) {
      if (s.type === 'comment') out += ' ';
      else if (s.type === 'string' || s.type === 'ident') out += ' Q ';
      else if (s.type === 'exec-comment') {
        out += ' ';
        i += s.opener;
        execOpen = true;
        continue;
      }
      i = s.end;
      continue;
    }
    // "*/" closes an executable comment only while one is open: in "2 */* x */" it is a multiplication and a comment
    if (execOpen && text[i] === '*' && text[i + 1] === '/') {
      out += ' ';
      i += 2;
      execOpen = false;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

const GAP = String.raw`[\s\u0000- \u007f   ﻿]+`;
const LEAD = String.raw`(?<![A-Za-z_$\u0080-￿])`;
const TAIL = String.raw`(?![A-Za-z0-9_$\u0080-￿])`;
const dangerRe = (words: string[]): RegExp => new RegExp(LEAD + words.join(GAP) + TAIL, 'i');

/** `reason` is built when a statement matches, in the current locale (the person's tab shows it). */
const DANGER: { re: RegExp; reason: () => string }[] = [
  { re: dangerRe(['INTO', 'OUTFILE']), reason: () => m().dialect.classify.intoOutfile },
  { re: dangerRe(['INTO', 'DUMPFILE']), reason: () => m().dialect.classify.intoDumpfile },
  { re: dangerRe(['FOR', 'UPDATE']), reason: () => m().dialect.classify.lockingRead({ clause: 'FOR UPDATE' }) },
  { re: dangerRe(['FOR', 'SHARE']), reason: () => m().dialect.classify.lockingRead({ clause: 'FOR SHARE' }) },
  { re: dangerRe(['LOCK', 'IN', 'SHARE', 'MODE']), reason: () => m().dialect.classify.lockingRead({ clause: 'LOCK IN SHARE MODE' }) },
];

/**
 * Conservative scan: digits and dots count as keyword boundaries (`1.INTO`, `.5FOR`, `1e0FOR`),
 * and any statement part, including subqueries, is searched. False refusals are acceptable.
 */
export function findDanger(statement: string): string | null {
  // The server's sql_mode may or may not have NO_BACKSLASH_ESCAPES: scan under both string rules.
  for (const backslash of [true, false]) {
    const code = codeOnly(statement, backslash);
    for (const { re, reason } of DANGER) if (re.test(code)) return reason();
  }
  return null;
}
