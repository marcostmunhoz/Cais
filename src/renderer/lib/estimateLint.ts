import { forceLinting, forEachDiagnostic, linter, type Diagnostic } from '@codemirror/lint';
import { StateEffect, type EditorState, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { statementAtCursor } from '@shared/dialects/registry';
import type { Dialect } from '@shared/dialects/types';
import { errorSpan } from '@shared/estimate';
import { clearEstimate, estimateAvailable, estimateStatement } from './estimate';

/** The pause after the last keystroke before the statement is asked about. */
export const ESTIMATE_DELAY_MS = 800;
/** BigQuery takes a query up to about a megabyte: past that there is nothing to ask. */
const MAX_STATEMENT_CHARS = 1_000_000;

/** Asks the linter to look again though the text did not change (the switch, the connection). */
const refresh = StateEffect.define<null>();

/** Estimates the statement under the cursor now, without waiting for a keystroke or the pause. A no-op in an editor with no such linter. */
export function estimateNow(view: EditorView): void {
  view.dispatch({ effects: refresh.of(null) });
  forceLinting(view);
}

/** What Cmd+Enter would run: the selection when it holds one statement, otherwise the statement under the cursor. */
export function statementToEstimate(dialect: Dialect, state: EditorState): { text: string; start: number } | null {
  const doc = state.doc.toString();
  const { from, to, head } = state.selection.main;
  let found: { text: string; start: number } | undefined;
  if (to > from) {
    const inside = dialect.splitStatements(doc.slice(from, to));
    if (inside.length === 1) found = { text: inside[0]!.text, start: from + inside[0]!.start };
  } else {
    const all = dialect.splitStatements(doc);
    const index = statementAtCursor(all, head, doc);
    if (index !== -1) found = { text: all[index]!.text, start: all[index]!.start };
  }
  return found && found.text.length <= MAX_STATEMENT_CHARS ? found : null;
}

/**
 * The lint source of "Estimate while typing" (exported for tests). A run that is no longer the newest by the time its
 * answer comes back returns the diagnostics already shown instead of its own: @codemirror/lint applies whatever a run
 * returns while the text is unchanged, so a slow older run would otherwise wipe what a newer one just marked.
 */
export function estimateSource(tabId: string, dialect: Dialect): (view: EditorView) => Promise<Diagnostic[]> {
  let generation = 0;
  return async (view) => {
    const mine = ++generation;
    const shown = (): Diagnostic[] => {
      const out: Diagnostic[] = [];
      forEachDiagnostic(view.state, (d) => out.push(d));
      return out;
    };
    if (!estimateAvailable(tabId)) {
      clearEstimate(tabId);
      return [];
    }
    const target = statementToEstimate(dialect, view.state);
    if (!target) {
      clearEstimate(tabId);
      return [];
    }
    const answer = await estimateStatement(tabId, target.text);
    if (mine !== generation) return shown();
    if (answer?.state !== 'error' || !answer.error.inStatement) return [];
    const span = errorSpan(target.text, `${answer.error.detail ?? ''} ${answer.error.message}`);
    return [
      {
        from: target.start + span.from,
        to: target.start + span.to,
        severity: 'error',
        message: answer.error.hint ? `${answer.error.message}\n${answer.error.hint}` : answer.error.message,
      },
    ];
  };
}

/**
 * The editor side of "Estimate while typing": after a pause the statement under the cursor is dry-run (the answer also
 * lands in the status bar) and what the server says about the text is a diagnostic at the statement. With the
 * switch off, a tab that is not connected or an engine with no dry run, nothing is asked and nothing is marked.
 */
export function estimateLinter(tabId: string, dialect: Dialect): Extension {
  return linter(estimateSource(tabId, dialect), {
    delay: ESTIMATE_DELAY_MS,
    // a cursor that moves to another statement asks about that one
    needsRefresh: (update) => update.selectionSet || update.transactions.some((tr) => tr.effects.some((e) => e.is(refresh))),
  });
}
