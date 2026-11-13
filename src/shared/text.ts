// Text safety for what a person reviews. Pure TypeScript.
import { getLocale, messagesFor, type Locale } from './i18n';

/**
 * Characters that can make text read differently from what it is: bidi controls (U+061C, U+200E/F, U+202A-E,
 * U+2066-9), zero-width and other default-ignorable code points (U+200B-D, U+2060-4, U+FEFF, U+00AD, variation
 * selectors, tag characters), format characters (Cf), line/paragraph separators, and blank-looking letters
 * (Hangul fillers, braille blank), and spaces other than U+0020 (NBSP, U+2000-U+200A, U+3000…): MySQL reads
 * them as part of a name, so "WHERE<NBSP>id" is not a WHERE.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Cf}\p{Zl}\p{Zp}\u0085\u115F\u1160\u3164\uFFA0\u2800\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/gu;
/** Every Cc character: C0, DEL and C1 (U+0080-U+009F draws as nothing or a box, so "pr<U+0081>od" looks like "prod"). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** Line breaks other than \n (lone CR, VT, FF): an editor may draw a new line where MySQL keeps a comment going. */
const ODD_BREAK = /\r(?!\n)|[\u000b\u000c]/g;
const OTHER_CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/;
const OTHER_CONTROL_ALL = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;

/** Removes bidi and invisible controls (and turns C0/C1 controls into spaces) in short free text: reason, client, script names. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '').replace(CONTROL, ' ');
}

const marker = (c: string): string => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`;

/** Shows each invisible control (and each line break other than \n) as a visible marker, e.g. ⟨U+202E⟩. The text that runs is not changed. */
export function markInvisible(text: string): string {
  return text.replace(INVISIBLE, marker).replace(ODD_BREAK, marker).replace(OTHER_CONTROL_ALL, marker);
}

/**
 * Why SQL written by an agent cannot be shown honestly to the person, or null. Invisible or direction
 * characters, line breaks other than \n (a lone CR is drawn as a new line but MySQL keeps a -- comment going)
 * and other control characters are refused: an agent has no need for them. In the current locale unless one is
 * given (the broker passes AGENT_LOCALE: the reply goes to the agent).
 */
export function hiddenTextProblem(text: string, locale: Locale = getLocale()): string | null {
  const msg = messagesFor(locale).text.hidden;
  INVISIBLE.lastIndex = 0;
  const invisible = INVISIBLE.exec(text);
  INVISIBLE.lastIndex = 0;
  if (invisible) return msg.invisible({ marker: marker(invisible[0]) });
  ODD_BREAK.lastIndex = 0;
  const odd = ODD_BREAK.exec(text);
  ODD_BREAK.lastIndex = 0;
  if (odd) return msg.oddBreak({ marker: marker(odd[0]) });
  const control = OTHER_CONTROL.exec(text);
  if (control) return msg.control({ marker: marker(control[0]) });
  return null;
}

/** Runs of 2 or more blank lines become one visible marker line: "⋯ 300 linhas em branco" (current locale). */
export function collapseBlankRuns(text: string): string {
  const blank = messagesFor(getLocale()).text.blankLines;
  const lines = text.split('\n');
  const out: string[] = [];
  let run = 0;
  const flush = (): void => {
    if (run >= 2) out.push(blank({ count: run }));
    else for (let i = 0; i < run; i++) out.push('');
    run = 0;
  };
  for (const line of lines) {
    if (line.trim() === '') run++;
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join('\n');
}

/** What the approval modal shows for SQL. */
export function displaySql(text: string): string {
  return collapseBlankRuns(markInvisible(text));
}
