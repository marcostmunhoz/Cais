import { useSyncExternalStore } from 'react';
import type { CatalogSnapshot, SavedScript, SessionMode, TabState } from '@shared/model';
import type { AgentsSnapshot } from '@shared/agents';
import type { PendingTransaction } from '@shared/ipc';
import type { SchemaTree, SessionState, StatementResult } from '@shared/results';
import type { PendingCells } from '@shared/grid';

/** Edits in the grid not yet applied nor sent to the editor. They belong to one result object. */
export interface GridEdits {
  result: StatementResult;
  cells: PendingCells;
}

export interface RunView {
  running: boolean;
  connecting: boolean;
  results: StatementResult[];
  active: number;
  /** Message for failures before any statement ran (connection, validation). */
  message?: string;
  /** Pending grid edits, valid only while `result` is still in `results`. */
  edits?: GridEdits;
  /** What Aplicar found (an UPDATE that did not find exactly one row, an error), shown above the grid. */
  editNotice?: string[];
}

export interface SchemaView {
  status: 'loading' | 'ready' | 'error';
  tree?: SchemaTree;
  error?: string;
  /** Engines that read columns per dataset (BigQuery): the state of that read, by dataset name. */
  datasets?: Record<string, { status: 'loading' | 'ready' | 'error'; error?: string }>;
}

/** BigQuery: statements estimated above the environment's byte limit, waiting for the person's answer. */
export interface BytesConfirmRequest {
  limit: number;
  statements: { index: number; sql: string; bytesEstimated: number }[];
  onConfirm: () => void;
}

export interface ConfirmRequest {
  title: string;
  body: string;
  items?: string[];
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

export interface RegistryRequest {
  section: 'environments' | 'credentials';
  /** id of the item to edit, or 'new' */
  editId?: string;
  /** Project to preselect on a new environment. */
  projectId?: string;
  /** New environment prefilled from this one (Duplicar). */
  duplicateOf?: string;
}

/** The project name prompt: rename, or the name of the copy when duplicating. */
export interface ProjectNameRequest {
  kind: 'rename' | 'duplicate';
  projectId: string;
  initialName: string;
}

/** The name prompt used by Cmd+S (save), Cmd+Shift+S (save as) and rename. */
export interface ScriptNameRequest {
  kind: 'save' | 'rename';
  /** save: the tab being saved. rename: unused. */
  tabId?: string;
  /** rename: the script being renamed. */
  scriptId?: string;
  /** save: project of the tab's environment. */
  projectId?: string;
  initialName: string;
}

export interface AppState {
  loaded: boolean;
  catalog: CatalogSnapshot;
  tabs: TabState[];
  activeTabId: string | null;
  /** Tab ids, most recently focused first. Memory only, for this run of the app. */
  focusOrder: string[];
  scripts: SavedScript[];
  agents: AgentsSnapshot;
  /** The Agentes panel is open. */
  agentPanel: boolean;
  /** The Trilha panel is open. */
  trailPanel: boolean;
  /** Requests whose modal the person closed with Esc: they stay pending, listed in the panel. */
  agentDismissed: string[];
  /** A request the person asked to review from the panel. */
  agentFocus: string | null;
  sessions: Record<string, SessionState>;
  pendingModes: Record<string, SessionMode>;
  runs: Record<string, RunView>;
  schemas: Record<string, SchemaView>;
  registry: RegistryRequest | null;
  picker: boolean;
  scriptPicker: boolean;
  scriptName: ScriptNameRequest | null;
  projectName: ProjectNameRequest | null;
  closeDirty: { tabId: string } | null;
  confirm: ConfirmRequest | null;
  bytesConfirm: BytesConfirmRequest | null;
  closeTx: { tabId: string } | null;
  quit: PendingTransaction[] | null;
  notices: string[];
  toast: { id: number; message: string; kind: 'error' | 'info' } | null;
}

const initial: AppState = {
  loaded: false,
  catalog: { version: 1, projects: [], environments: [], credentials: [], credentialsWithSecret: [], blockedEnvironments: [], notices: [] },
  tabs: [],
  activeTabId: null,
  focusOrder: [],
  scripts: [],
  agents: { enabled: false, pending: [], awaitingCommit: [], grants: [], recent: [] },
  agentPanel: false,
  trailPanel: false,
  agentDismissed: [],
  agentFocus: null,
  sessions: {},
  pendingModes: {},
  runs: {},
  schemas: {},
  registry: null,
  picker: false,
  scriptPicker: false,
  scriptName: null,
  projectName: null,
  closeDirty: null,
  confirm: null,
  bytesConfirm: null,
  closeTx: null,
  quit: null,
  notices: [],
  toast: null,
};

let state: AppState = initial;
const listeners = new Set<() => void>();

export const getState = (): AppState => state;

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}
