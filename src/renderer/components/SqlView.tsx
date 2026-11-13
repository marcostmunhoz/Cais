import { useEffect, useRef } from 'react';
import { sql } from '@codemirror/lang-sql';
import { syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { displaySql } from '@shared/text';
import { highlightStyle, MYSQL_AS_SERVER } from './Editor';

/** Read-only, highlighted SQL that scrolls. Used where a person reviews what an agent wants to run. */
export function SqlView({ value, label }: { value: string; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: displaySql(value), // invisible controls shown as markers, blank-line runs folded; what runs is unchanged
        extensions: [
          sql({ dialect: MYSQL_AS_SERVER, upperCaseKeywords: false }),
          syntaxHighlighting(highlightStyle),
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
  }, [value, label]);
  return <div className="sqlview" ref={host} data-testid="sqlview" />;
}
