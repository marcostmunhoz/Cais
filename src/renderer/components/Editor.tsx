import { useEffect, useRef } from 'react';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { sql, SQLDialect, type SQLNamespace } from '@codemirror/lang-sql';
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
import { getDialect, statementAtCursor } from '@shared/dialects/registry';
import { planAppend } from '@shared/grid';
import type { Engine } from '@shared/model';
import type { Dialect } from '@shared/dialects/types';
import type { SchemaTree } from '@shared/results';
import { registerEditor, updateTabSql } from '../lib/actions';
import { CODEMIRROR_DIALECTS } from '../lib/codemirrorDialects';
import { m } from '../lib/i18n';

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

function buildNamespace(tree: SchemaTree | undefined, term: Dialect['databaseTerm']): SQLNamespace {
  const t = m().editor;
  const ns: Record<string, SQLNamespace> = {};
  for (const db of tree?.databases ?? []) {
    const tables: Record<string, SQLNamespace> = {};
    for (const table of db.tables) {
      tables[table.name] = {
        self: { label: table.name, type: 'class', detail: table.type === 'view' ? t.viewDetail : t.tableDetail },
        children: table.columns.map((c) => ({
          label: c.name,
          type: 'property',
          detail: c.key === 'PRI' ? `${c.type} · PK` : c.type,
        })),
      };
    }
    ns[db.name] = { self: { label: db.name, type: 'namespace', detail: t.databaseDetail[term] }, children: tables };
  }
  return ns;
}


function sqlExtension(dialect: Dialect, tree: SchemaTree | undefined, database: string | null): Extension {
  const base = CODEMIRROR_DIALECTS[dialect.codemirrorDialect];
  const withKeywords = SQLDialect.define({
    ...base.spec,
    keywords: `${base.spec.keywords ?? ''} ${dialect.keywords.join(' ').toLowerCase()}`,
  });
  return sql({
    dialect: withKeywords,
    schema: buildNamespace(tree, dialect.databaseTerm),
    ...(database ? { defaultSchema: database } : {}),
    upperCaseKeywords: true,
  });
}

interface Props {
  tabId: string;
  initialSql: string;
  engine: Engine;
  schema: SchemaTree | undefined;
  database: string | null;
}

/** One CodeMirror view for all tabs: each tab keeps its own EditorState (text, cursor, undo history). */
export function Editor({ tabId, initialSql, engine, schema, database }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const compartment = useRef(new Compartment());
  const current = useRef({ tabId, schema, database, engine });
  current.current = { tabId, schema, database, engine };

  const createState = (id: string, doc: string): EditorState => {
    const dialect = getDialect(current.current.engine);
    const t = m().editor;
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
        // several ranges: Gerar UPDATE da célula selects one value per row, and typing replaces them all
        EditorState.allowMultipleSelections.of(true),
        // only Gerar UPDATE da célula makes several ranges: a click never adds one
        EditorView.clickAddsSelectionRange.of(() => false),
        drawSelection(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ icons: false, defaultKeymap: true }),
        keymap.of([...closeBracketsKeymap, ...completionKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap]),
        compartment.current.of(sqlExtension(dialect, current.current.schema, current.current.database)),
        syntaxHighlighting(highlightStyle),
        activeStatementPlugin(dialect),
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
          // several ranges (Gerar UPDATE da célula): run the whole block from the first statement to the last
          const doc = view.state.doc.toString();
          const statements = getDialect(current.current.engine).splitStatements(doc);
          const first = statementAtCursor(statements, ranges[0]!.from, doc);
          const last = statementAtCursor(statements, ranges[ranges.length - 1]!.to, doc);
          if (first !== -1 && last !== -1 && first <= last) {
            return { cursor: main.head, selection: { from: statements[first]!.start, to: statements[last]!.end } };
          }
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

  // schema or current database changed: refresh the completion source
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartment.current.reconfigure(sqlExtension(getDialect(engine), schema, database)),
    });
  }, [schema, database, engine]);

  return <div className="editor-host" ref={host} data-testid="editor" />;
}
