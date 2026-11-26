// Engines that read columns per dataset (BigQuery) have columns only for the datasets that were opened in the tree.
// The editor reads the ones the statement under the cursor names, after a pause in typing, so its columns complete
// without opening the dataset first. The read is `tables.get` (metadata: no bytes are processed), once per dataset
// until the schema is refreshed (a failed read is not repeated while the person types).
import type { EditorState, Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { referencedDatabases } from '@shared/completion';
import { getDialect } from '@shared/dialects/registry';
import { allTables } from '@shared/dialects/scope';
import { capabilitiesOf } from '@shared/engines';
import type { Engine } from '@shared/model';
import { loadDatasetColumns } from './actions';
import { statementAround } from './completion';
import { getState } from './store';

export interface DatasetReadContext {
  environmentId: string;
  engine: Engine;
  /** The dataset a name without one belongs to. */
  database: string | null;
}

/** Starts the read of the columns of the datasets the statement under the cursor names, for the engines that read them on demand. */
export function loadReferencedColumns(context: DatasetReadContext, state: EditorState): void {
  if (!capabilitiesOf(context.engine).lazyColumns) return;
  const view = getState().schemas[context.environmentId];
  if (!view?.tree) return;
  const dialect = getDialect(context.engine);
  const around = statementAround(state, dialect, state.selection.main.head);
  if (!around) return;
  const names = referencedDatabases(view.tree, context.database, allTables(dialect.analyze(around.text)));
  for (const name of names) {
    // no state yet: never asked for. A dataset that failed stays failed until a refresh clears it.
    if (!view.datasets?.[name]) void loadDatasetColumns(context.environmentId, name);
  }
}

/** Runs `read` with the editor's state after a pause in typing (and once when the editor starts). */
export function referencedDatasetsWatcher(read: (state: EditorState) => void, delay = 600): Extension {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | undefined;
      constructor(private view: EditorView) {
        this.schedule();
      }
      update(update: ViewUpdate): void {
        this.view = update.view;
        if (update.docChanged || update.selectionSet) this.schedule();
      }
      private schedule(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => read(this.view.state), delay);
      }
      destroy(): void {
        clearTimeout(this.timer);
      }
    },
  );
}
