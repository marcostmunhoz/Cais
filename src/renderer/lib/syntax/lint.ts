// The editor's syntax diagnostics for an engine that has a local check: after a pause in typing, the statement under
// the cursor and the ones on screen are checked, and the first error of a statement is marked where the parser stopped.
// Never the whole document: a pasted dump has thousands of statements and the person is looking at a few.
import { linter, type Diagnostic } from '@codemirror/lint';
import type { EditorState, Extension } from '@codemirror/state';
import type { Dialect, SqlStatement } from '@shared/dialects/types';
import { statementAround, statementsOf } from '../completion';
import type { SyntaxCheck } from './client';

export interface SyntaxLintOptions {
  dialect: Dialect;
  check: SyntaxCheck;
  /** The text of a diagnostic, around the parser's own message (in the interface's language). */
  message: (parserMessage: string) => string;
  /** The pause after the last keystroke before the document is checked. */
  delay?: number;
}

/** The most statements one pass asks about, and the most characters of them (the cursor's statement is always asked). */
export const PASS_STATEMENTS = 40;
export const PASS_CHARS = 60_000;

export interface PassScope {
  /** The parts of the document in view; the whole document when absent. */
  ranges?: readonly { from: number; to: number }[];
  /** Aborts when a newer pass has begun: what has not reached the worker yet is dropped. */
  signal?: AbortSignal;
}

/** The statements one pass checks: the one under the cursor first, then the ones in view, up to the limits. */
export function statementsToCheck(state: EditorState, dialect: Dialect, ranges?: PassScope['ranges']): SqlStatement[] {
  const all = statementsOf(state, dialect);
  const typing = statementAround(state, dialect, state.selection.main.head);
  const out: SqlStatement[] = [];
  let chars = 0;
  const take = (s: SqlStatement, force: boolean): void => {
    if (out.includes(s)) return;
    if (!force && (out.length >= PASS_STATEMENTS || chars + s.text.length > PASS_CHARS)) return;
    out.push(s);
    chars += s.text.length;
  };
  const current = typing ? all.find((s) => s.start === typing.start) : undefined;
  if (current) take(current, true);
  for (const s of all) {
    if (ranges && !ranges.some((r) => s.start <= r.to && s.rangeEnd >= r.from)) continue;
    take(s, false);
  }
  return out;
}

/** The diagnostics of the statements of one pass: the first error of each the check flags. */
export async function syntaxDiagnostics(state: EditorState, { dialect, check, message }: SyntaxLintOptions, scope: PassScope = {}): Promise<Diagnostic[]> {
  const statements = statementsToCheck(state, dialect, scope.ranges);
  const head = state.selection.main.head;
  const typing = statementAround(state, dialect, head);
  const results = await Promise.all(statements.map((s) => check(s.text, scope.signal)));
  const out: Diagnostic[] = [];
  statements.forEach((s, i) => {
    for (const issue of results[i]!) {
      // the end of the statement the person is still typing is unfinished, not wrong
      if (typing?.start === s.start && head >= s.end && issue.to >= s.text.length) continue;
      out.push({ from: s.start + issue.from, to: s.start + issue.to, severity: 'error', message: message(issue.message) });
    }
  });
  return out;
}

/**
 * The lint extension. A pass that a newer one overtakes (the cursor moved, the view scrolled) is aborted so its queued
 * statements leave the worker's line, and answers with what the newer pass finds instead of with its own half.
 */
export function syntaxLint(options: SyntaxLintOptions): Extension {
  let controller: AbortController | null = null;
  let latest: Promise<Diagnostic[]> = Promise.resolve([]);
  return linter(
    (view) => {
      controller?.abort();
      const mine = new AbortController();
      controller = mine;
      const pass: Promise<Diagnostic[]> = syntaxDiagnostics(view.state, options, { ranges: view.visibleRanges, signal: mine.signal }).then((out) =>
        mine.signal.aborted ? latest : out,
      );
      latest = pass;
      return pass;
    },
    {
      delay: options.delay ?? 600,
      // the answer depends on where the cursor is (see above) and on what is in view: asked again when either changes
      // (the statements already read come from the cache, so this costs no worker time)
      needsRefresh: (update) => update.selectionSet || update.viewportChanged,
    },
  );
}
