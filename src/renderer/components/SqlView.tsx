import { useEffect, useRef } from 'react';
import { sql } from '@codemirror/lang-sql';
import { syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { displaySql } from '@shared/text';
import { getDialect } from '@shared/dialects/registry';
import { useStore } from '../lib/store';
import { CODEMIRROR_DIALECTS } from '../lib/codemirrorDialects';
import { highlightStyle } from './Editor';

/**
 * Read-only, highlighted SQL that scrolls. Used where a person reviews what an agent wants to run. It reads the
 * text the way the environment's engine does (a comment or a string must look like one only where the server sees
 * one); an environment that is not in the catalog (gone, or never known) gets no highlighting, never another
 * engine's reading.
 */
export function SqlView({ value, label, environmentId }: { value: string; label: string; environmentId?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useStore((s) => (environmentId ? s.catalog.environments.find((e) => e.id === environmentId)?.engine : undefined));
  useEffect(() => {
    const language = engine
      ? [
          sql({ dialect: CODEMIRROR_DIALECTS[getDialect(engine).codemirrorDialect], upperCaseKeywords: false }),
          syntaxHighlighting(highlightStyle),
        ]
      : [];
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: displaySql(value), // invisible controls shown as markers, blank-line runs folded; what runs is unchanged
        extensions: [
          ...language,
          EditorState.readOnly.of(true),
          // only \n starts a line, as for MySQL comments (a lone CR is shown as a marker by displaySql)
          EditorState.lineSeparator.of('\n'),
          // logical order: right-to-left letters or marks cannot reorder what the person reads
          EditorView.theme({ '.cm-line': { direction: 'ltr', unicodeBidi: 'bidi-override' } }),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': label, 'aria-readonly': 'true' }),
        ],
      }),
    });
    return () => view.destroy();
  }, [value, label, engine]);
  return <div className="sqlview" ref={host} data-testid="sqlview" />;
}
