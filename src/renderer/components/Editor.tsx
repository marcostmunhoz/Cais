import { useEffect, useRef } from 'react';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { addCursorAbove, addCursorBelow, defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { sql, SQLDialect } from '@codemirror/lang-sql';
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorSelection, EditorState, type Extension, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { getDialect, multiSelectionBlock, statementAtCursor } from '@shared/dialects/registry';
import { capabilitiesOf } from '@shared/engines';
import { planAppend } from '@shared/grid';
import type { Engine } from '@shared/model';
import type { Dialect } from '@shared/dialects/types';
import type { SchemaTree } from '@shared/results';
import { registerEditor, updateTabSql } from '../lib/actions';
import { CODEMIRROR_DIALECTS } from '../lib/codemirrorDialects';
import { schemaCompletion } from '../lib/completion';
import { loadReferencedColumns, referencedDatasetsWatcher } from '../lib/datasets';
import { estimateLinter, estimateNow } from '../lib/estimateLint';
import { m } from '../lib/i18n';
import { useStore } from '../lib/store';
import { syntaxCheckFor } from '../lib/syntax';
import { syntaxLint } from '../lib/syntax/lint';

// no keystroke adds a cursor: only Generate cell UPDATE makes several ranges (addCursorAbove/Below are Mod-Alt-ArrowUp/Down)
const editorKeymap = defaultKeymap.filter((b) => b.run !== addCursorAbove && b.run !== addCursorBelow);

export const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--accent-text)', fontWeight: '500' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--text-success)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--text-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--text-primary)' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--text-secondary)' },
]);

/** Softly highlights the lines of the statement under the cursor (the one Cmd+Enter runs). */
function activeStatementPlugin(dialect: Dialect) {
  const line = Decoration.line({ class: 'cm-active-statement' });
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet) this.decorations = this.build(update.view);
      }
      build(view: EditorView): DecorationSet {
        const doc = view.state.doc;
        const statements = dialect.splitStatements(doc.toString());
        const index = statementAtCursor(statements, view.state.selection.main.head, doc.toString());
        const builder = new RangeSetBuilder<Decoration>();
        const selection = view.state.selection.main;
        if (index === -1 || !selection.empty) return builder.finish();
        const st = statements[index]!;
        const first = doc.lineAt(st.start).number;
        const last = doc.lineAt(Math.max(st.start, st.end)).number;
        // Only worth showing when there is more than one statement to tell apart.
        if (statements.length < 2) return builder.finish();
        for (let n = first; n <= last; n++) builder.add(doc.line(n).from, doc.line(n).from, line);
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/**
 * The language reads the text (highlighting, keywords); the names of the schema come from `schemaCompletion`, which
 * knows what the statement reads and what the position waits for.
 */
function sqlExtension(dialect: Dialect, tree: SchemaTree | undefined, database: string | null): Extension {
  const base = CODEMIRROR_DIALECTS[dialect.codemirrorDialect];
  const withKeywords = SQLDialect.define({
    ...base.spec,
    keywords: `${base.spec.keywords ?? ''} ${dialect.keywords.join(' ').toLowerCase()}`,
  });
  const t = m().editor;
  const words = { table: t.tableDetail, view: t.viewDetail, database: t.databaseDetail[dialect.databaseTerm] };
  return [
    sql({ dialect: withKeywords, upperCaseKeywords: true }),
    withKeywords.language.data.of({ autocomplete: schemaCompletion({ dialect, tree, database, words }) }),
  ];
}

interface Props {
  tabId: string;
  environmentId: string;
  initialSql: string;
  engine: Engine;
  schema: SchemaTree | undefined;
  database: string | null;
}

/** One CodeMirror view for all tabs: each tab keeps its own EditorState (text, cursor, undo history). */
export function Editor({ tabId, environmentId, initialSql, engine, schema, database }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const compartment = useRef(new Compartment());
  const current = useRef({ tabId, environmentId, schema, database, engine });
  current.current = { tabId, environmentId, schema, database, engine };

  const createState = (id: string, doc: string): EditorState => {
    const dialect = getDialect(current.current.engine);
    const t = m().editor;
    const check = syntaxCheckFor(current.current.engine);
    return EditorState.create({
      doc,
      extensions: [
        EditorState.phrases.of({
          'Control character': t.codemirror.controlCharacter,
          Completions: t.codemirror.completions,
          'Selection deleted': t.codemirror.selectionDeleted,
        }),
        lineNumbers(),
        // invisible, direction and zero-width characters shown as placeholders (scripts may come from agents)
        highlightSpecialChars({
          addSpecialChars: /[\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\r\u000b\u000c\u0085]/,
        }),
        history(),
        // several ranges: Generate cell UPDATE selects one value per row, and typing replaces them all
        EditorState.allowMultipleSelections.of(true),
        // only Generate cell UPDATE makes several ranges: a click never adds one
        EditorView.clickAddsSelectionRange.of(() => false),
        drawSelection(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ icons: false, defaultKeymap: true }),
        keymap.of([...closeBracketsKeymap, ...completionKeymap, ...historyKeymap, indentWithTab, ...editorKeymap]),
        compartment.current.of(sqlExtension(dialect, current.current.schema, current.current.database)),
        syntaxHighlighting(highlightStyle),
        activeStatementPlugin(dialect),
        // engines with a grammar of their own mark the first syntax error of each statement
        ...(check ? [syntaxLint({ dialect, check, message: (text) => t.syntaxError({ message: text }) })] : []),
        // engines that read columns per dataset read the ones the statement names
        referencedDatasetsWatcher((state) => loadReferencedColumns(current.current, state)),
        // an engine that answers a dry run (BigQuery): the statement under the cursor is estimated after a pause, while the switch is on
        ...(capabilitiesOf(current.current.engine).dryRun ? [estimateLinter(id, dialect)] : []),
        EditorView.contentAttributes.of({ 'aria-label': t.ariaLabel, spellcheck: 'false' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && current.current.tabId === id) updateTabSql(id, update.state.doc.toString());
        }),
      ],
    });
  };

  // mount once
  useEffect(() => {
    const view = new EditorView({ parent: host.current!, state: createState(tabId, initialSql) });
    viewRef.current = view;
    registerEditor({
      getSelection: () => {
        const { main, ranges } = view.state.selection;
        if (ranges.length > 1) {
          // several ranges: only the shape Generate cell UPDATE makes runs as a block; anything else runs the main range
          const doc = view.state.doc.toString();
          const block = multiSelectionBlock(getDialect(current.current.engine).splitStatements(doc), ranges, doc);
          if (block) return { cursor: main.head, selection: block };
        }
        return { cursor: main.head, ...(main.empty ? {} : { selection: { from: main.from, to: main.to } }) };
      },
      focus: () => view.focus(),
      insertText: (text, ranges) => {
        // the dialect knows what the script leaves open (an unterminated statement, a DELIMITER block)
        const { changes, selections } = planAppend(getDialect(current.current.engine), view.state.doc.toString(), text, ranges);
        view.dispatch({
          changes,
          selection: EditorSelection.create(selections.map((r) => EditorSelection.range(r.from, r.to))),
          scrollIntoView: true,
        });
        view.focus();
      },
    });
    view.focus();
    return () => {
      registerEditor(null);
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // switching tabs: park the old state, restore (or create) the new one
  const shownTab = useRef(tabId);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || shownTab.current === tabId) return;
    states.current.set(shownTab.current, view.state);
    shownTab.current = tabId;
    const next = states.current.get(tabId) ?? createState(tabId, initialSql);
    view.setState(next);
    view.dispatch({
      effects: compartment.current.reconfigure(sqlExtension(getDialect(engine), schema, database)),
    });
    view.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // "Estimate while typing" turned on, or the tab connected: estimate now, without waiting for a keystroke (off clears the marks)
  const estimateOn = useStore((st) => st.estimateAsYouType);
  // idle and running are both "connected": a run flips the status to running and back, and that is not a new connection
  const connected = useStore((st) => {
    const status = st.sessions[tabId]?.status;
    return status === 'idle' || status === 'running';
  });
  // (a new default dataset is another question for the same text, so it estimates again too)
  const tabDatabase = useStore((st) => st.sessions[tabId]?.database);
  useEffect(() => {
    if (viewRef.current && capabilitiesOf(engine).dryRun) estimateNow(viewRef.current);
  }, [estimateOn, connected, tabId, engine, tabDatabase]);

  // schema or current database changed: refresh the completion source
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: compartment.current.reconfigure(sqlExtension(getDialect(engine), schema, database)) });
    // the tree may have arrived after the statement was typed: its datasets are read now
    loadReferencedColumns({ environmentId, engine, database }, view.state);
  }, [schema, database, engine]);

  return <div className="editor-host" ref={host} data-testid="editor" />;
}
