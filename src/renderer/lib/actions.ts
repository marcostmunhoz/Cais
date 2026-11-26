import { getDialect } from '@shared/dialects/registry';
import { capabilitiesOf, initialModeFor } from '@shared/engines';
import { DEFAULT_MAX_ROWS, EXTENDED_MAX_ROWS } from '@shared/model';
import type { AgentsSnapshot, ApproveOptions } from '@shared/agents';
import type { Environment, SavedScript, SessionMode, TabState } from '@shared/model';
import { duplicateName, isScriptDirty, pickEnvironmentForScript } from '@shared/scripts';
import type { PendingTransaction, RunRequest, RunResponse } from '@shared/ipc';
import type { SessionState } from '@shared/results';
import { focusTab, tabForEnvironment } from '@shared/tabs';
import { errorCode, errorMessage } from './errors';
import { MAX_CATALOG_NAME, sameName } from '@shared/names';
import { getState, setState, type GridEdits, type ProjectNameRequest, type RunView, type ScriptNameRequest } from './store';
import {
  buildGridUpdates,
  gridEditability,
  pendingCount,
  remapCells,
  sameCell,
  type EditTarget,
  type Editability,
  type KeyColumn,
  type PendingCells,
} from '@shared/grid';
import type { CellValue, SchemaTree, StatementResult } from '@shared/results';
import { m, render } from './i18n';
import { forgetEstimates, resetEstimates } from './estimate';

const api = (): Window['cais'] => window.cais;

// --- editor bridge -----------------------------------------------------------

export interface EditorHandle {
  getSelection(): { cursor: number; selection?: { from: number; to: number } };
  focus(): void;
  /** Appends statements at the end of the document (ending an unterminated last statement first) and selects them. */
  insertText(text: string): void;
}
let activeEditor: EditorHandle | null = null;
export function registerEditor(handle: EditorHandle | null): void {
  activeEditor = handle;
}

// --- helpers -----------------------------------------------------------------

export function findEnvironment(id: string): Environment | undefined {
  return getState().catalog.environments.find((e) => e.id === id);
}

export function initialMode(env: Environment | undefined): SessionMode {
  const engine = env?.engine ?? 'mysql';
  return initialModeFor(capabilitiesOf(engine), !!env?.production);
}

export function effectiveMode(tabId: string): SessionMode {
  const s = getState();
  const session = s.sessions[tabId];
  if (session && (session.status === 'idle' || session.status === 'running')) return session.mode;
  const tab = s.tabs.find((t) => t.id === tabId);
  const pending = s.pendingModes[tabId];
  if (pending) return pending;
  // disconnected (by the person or the idle timer) or after an error: main kept the tab's mode, which
  // survives reconnecting
  if (session && tab && session.environmentId === tab.environmentId) return session.mode;
  return initialMode(tab ? findEnvironment(tab.environmentId) : undefined);
}

let toastSeq = 0;
export function showToast(message: string, kind: 'error' | 'info' = 'error'): void {
  const id = ++toastSeq;
  setState({ toast: { id, message, kind } });
  setTimeout(() => {
    if (getState().toast?.id === id) setState({ toast: null });
  }, 5500);
}

function emptyRun(): RunView {
  return { running: false, connecting: false, results: [], active: 0 };
}

function patchRun(tabId: string, patch: Partial<RunView>): void {
  setState((s) => ({ runs: { ...s.runs, [tabId]: { ...(s.runs[tabId] ?? emptyRun()), ...patch } } }));
}

function setSession(state: SessionState): void {
  // a connection that comes back: what the server said through the old one is asked again
  const before = getState().sessions[state.tabId]?.status;
  if (state.status === 'idle' && before !== 'idle' && before !== 'running') forgetEstimates(state.environmentId);
  setState((s) => {
    if (!s.tabs.some((t) => t.id === state.tabId)) return {};
    return { sessions: { ...s.sessions, [state.tabId]: state } };
  });
}

// --- persistence -------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function scheduleSaveTabs(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushTabs, 500);
}
export function flushTabs(): void {
  clearTimeout(saveTimer);
  const { tabs, activeTabId, loaded } = getState();
  if (!loaded) return;
  void api()
    .tabs.save({ version: 1, tabs, activeTabId })
    .catch(() => undefined);
}

// --- init --------------------------------------------------------------------

export async function init(): Promise<void> {
  const [catalog, tabsFile, scripts, agents, settings] = await Promise.all([
    api().catalog.get(),
    api().tabs.load(),
    api().scripts.list(),
    api().agents.get(),
    api().settings.get(),
  ]);
  const tabs = (tabsFile.tabs ?? [])
    .filter((t) => t && typeof t.id === 'string' && catalog.environments.some((e) => e.id === t.environmentId))
    // a script that no longer exists leaves the tab loose, with its text
    .map((t) => (t.scriptId && !scripts.some((sc) => sc.id === t.scriptId) ? { ...t, scriptId: undefined } : t));
  const activeTabId = tabs.some((t) => t.id === tabsFile.activeTabId) ? tabsFile.activeTabId : (tabs[0]?.id ?? null);
  const notices = [...(catalog.notices ?? []), ...(tabsFile.notice ? [tabsFile.notice] : [])];
  setState({ catalog, tabs, scripts, agents, activeTabId, notices, estimateAsYouType: settings.estimateAsYouType, loaded: true });

  api().events.onSessionState(setSession);
  api().events.onScriptsChanged(() => void refreshScripts());
  api().events.onAgents(setAgents);
  api().events.onResolveTransactions((pending) => setState({ quit: pending }));
  window.addEventListener('beforeunload', flushTabs);
}

export async function reloadCatalog(): Promise<void> {
  const catalog = await api().catalog.get();
  setState((s) => ({
    catalog,
    // tabs whose environment disappeared are dropped
    tabs: s.tabs.filter((t) => catalog.environments.some((e) => e.id === t.environmentId)),
  }));
  const s = getState();
  if (s.activeTabId && !s.tabs.some((t) => t.id === s.activeTabId)) setState({ activeTabId: s.tabs[0]?.id ?? null });
  scheduleSaveTabs();
}

// --- projects ----------------------------------------------------------------

/** The name prompt for renaming a project. */
export function renameProject(projectId: string): void {
  const project = getState().catalog.projects.find((p) => p.id === projectId);
  if (project) setState({ projectName: { kind: 'rename', projectId, initialName: project.name } });
}

/** The name prompt for duplicating a project, with "<projeto> (cópia)" as the default. */
export function duplicateProject(projectId: string): void {
  const { projects } = getState().catalog;
  const project = projects.find((p) => p.id === projectId);
  if (!project) return;
  const taken = (candidate: string): boolean => projects.some((p) => sameName(p.name, candidate));
  setState({ projectName: { kind: 'duplicate', projectId, initialName: duplicateName(project.name, taken, MAX_CATALOG_NAME) } });
}

/** Confirms the project name prompt. Returns an error message to show inside the prompt, or null when done. */
export async function submitProjectName(request: ProjectNameRequest, name: string): Promise<string | null> {
  try {
    if (request.kind === 'rename') await api().catalog.renameProject(request.projectId, name);
    else await api().catalog.duplicateProject(request.projectId, name);
    await reloadCatalog();
    setState({ projectName: null });
    return null;
  } catch (e) {
    return errorMessage(e);
  }
}

// --- scripts -----------------------------------------------------------------

export function findScript(id: string | undefined): SavedScript | undefined {
  return id ? getState().scripts.find((sc) => sc.id === id) : undefined;
}

function applyScripts(scripts: SavedScript[]): void {
  setState((s) => ({
    scripts,
    // a tab linked to a script that disappeared becomes loose and keeps its text
    tabs: s.tabs.map((t) => (t.scriptId && !scripts.some((sc) => sc.id === t.scriptId) ? { ...t, scriptId: undefined } : t)),
  }));
  scheduleSaveTabs();
}

export async function refreshScripts(): Promise<void> {
  try {
    applyScripts(await api().scripts.list());
  } catch {
    // keep the list we have
  }
}

function upsertScript(script: SavedScript): void {
  const exists = getState().scripts.some((sc) => sc.id === script.id);
  applyScripts(exists ? getState().scripts.map((sc) => (sc.id === script.id ? script : sc)) : [...getState().scripts, script]);
}

export function tabIsDirty(tabId: string): boolean {
  const tab = getState().tabs.find((t) => t.id === tabId);
  const script = findScript(tab?.scriptId);
  return !!tab && !!script && isScriptDirty(tab.sql, script);
}

/** Opens the script in a tab of that environment, or focuses the tab that already has the same script there. */
export function openScript(scriptId: string, environmentId: string): void {
  const script = findScript(scriptId);
  if (!script) return;
  const existing = getState().tabs.find((t) => t.scriptId === scriptId && t.environmentId === environmentId);
  if (existing) {
    selectTab(existing.id);
    setState({ scriptPicker: false });
    return;
  }
  openTab(environmentId, { sql: script.sql, ...(script.database ? { database: script.database } : {}), scriptId });
  setState({ scriptPicker: false });
}

/** Cmd+O: the environment follows the rules in `pickEnvironmentForScript`. */
export function openScriptFromPicker(scriptId: string): void {
  const s = getState();
  const script = findScript(scriptId);
  if (!script) return;
  const activeEnv = s.tabs.find((t) => t.id === s.activeTabId)?.environmentId;
  const env = pickEnvironmentForScript(script, s.catalog.environments, activeEnv);
  if (!env) {
    showToast(m().actions.scriptProjectHasNoEnvironments);
    return;
  }
  openScript(scriptId, env.id);
}

function currentDatabaseOf(tabId: string): string | undefined {
  const s = getState();
  return s.sessions[tabId]?.database ?? s.tabs.find((t) => t.id === tabId)?.database ?? undefined;
}

/** Saves the tab into its linked script. Returns false (and says why) when it cannot. */
async function saveLinkedTab(tabId: string): Promise<boolean> {
  const tab = getState().tabs.find((t) => t.id === tabId);
  const script = findScript(tab?.scriptId);
  if (!tab || !script) return false;
  try {
    const saved = await api().scripts.save({
      id: script.id,
      projectId: script.projectId,
      name: script.name,
      sql: tab.sql,
      database: currentDatabaseOf(tabId),
    });
    upsertScript(saved);
    return true;
  } catch (e) {
    showToast(errorMessage(e));
    return false;
  }
}

/** Cmd+S (`saveAs` false) and Cmd+Shift+S (`saveAs` true). */
export async function saveTab(tabId: string, saveAs = false): Promise<void> {
  const s = getState();
  const tab = s.tabs.find((t) => t.id === tabId);
  const env = tab ? findEnvironment(tab.environmentId) : undefined;
  if (!tab || !env) return;
  const script = findScript(tab.scriptId);
  if (script && !saveAs) {
    if (await saveLinkedTab(tabId)) showToast(m().actions.scriptSaved, 'info');
    return;
  }
  const taken = (name: string): boolean =>
    getState().scripts.some((sc) => sc.projectId === env.projectId && sc.name.toLowerCase() === name.toLowerCase());
  setState({
    scriptName: {
      kind: 'save',
      tabId,
      projectId: env.projectId,
      initialName: script ? duplicateName(script.name, taken) : '',
    },
  });
}

/** Confirms the name prompt. Returns an error message to show inside the prompt, or null when done. */
export async function submitScriptName(request: ScriptNameRequest, name: string): Promise<string | null> {
  try {
    if (request.kind === 'rename' && request.scriptId) {
      upsertScript(await api().scripts.rename(request.scriptId, name));
    } else if (request.tabId && request.projectId) {
      const tab = getState().tabs.find((t) => t.id === request.tabId);
      if (!tab) return null;
      const saved = await api().scripts.save({
        projectId: request.projectId,
        name,
        sql: tab.sql,
        database: currentDatabaseOf(tab.id),
      });
      upsertScript(saved);
      setState((st) => ({ tabs: st.tabs.map((t) => (t.id === tab.id ? { ...t, scriptId: saved.id } : t)) }));
      scheduleSaveTabs();
    }
    setState({ scriptName: null });
    return null;
  } catch (e) {
    return errorMessage(e);
  }
}

export function renameScript(scriptId: string): void {
  const script = findScript(scriptId);
  if (script) setState({ scriptName: { kind: 'rename', scriptId, initialName: script.name } });
}

export async function duplicateScript(scriptId: string): Promise<void> {
  try {
    upsertScript(await api().scripts.duplicate(scriptId));
  } catch (e) {
    showToast(errorMessage(e));
  }
}

export function deleteScript(scriptId: string): void {
  const script = findScript(scriptId);
  if (!script) return;
  const text = m().actions.deleteScript;
  setState({
    confirm: {
      title: text.title,
      body: text.body({ name: script.name }),
      confirmLabel: text.confirm,
      danger: true,
      onConfirm: () => {
        setState({ confirm: null });
        api()
          .scripts.delete(scriptId)
          .then(() => refreshScripts())
          .catch((e) => showToast(errorMessage(e)));
      },
    },
  });
}

async function markScriptRun(tabId: string): Promise<void> {
  const tab = getState().tabs.find((t) => t.id === tabId);
  if (!tab?.scriptId || !findScript(tab.scriptId)) return;
  try {
    upsertScript(await api().scripts.markRun(tab.scriptId, tab.environmentId));
  } catch {
    // the run itself already happened; the "last run" mark is a convenience
  }
}

// --- settings ----------------------------------------------------------------

/** "Estimar ao digitar": on or off for every tab, kept by main. Turning it off drops what was estimated. */
export async function setEstimateAsYouType(enabled: boolean): Promise<void> {
  try {
    const settings = await api().settings.setEstimateAsYouType(enabled);
    // off then on asks again: nothing is kept from before
    resetEstimates();
    setState({ estimateAsYouType: settings.estimateAsYouType, ...(settings.estimateAsYouType ? {} : { estimates: {} }) });
  } catch (e) {
    showToast(errorMessage(e));
  }
}

// --- schema ------------------------------------------------------------------

export async function loadSchema(environmentId: string, refresh = false): Promise<void> {
  const current = getState().schemas[environmentId];
  if (!refresh && (current?.status === 'ready' || current?.status === 'loading')) return;
  // a refresh forgets the columns read so far: the datasets that were open are read again below
  if (refresh) forgetEstimates(environmentId);
  const reopen = refresh ? Object.entries(current?.datasets ?? {}).filter(([, d]) => d.status === 'ready').map(([name]) => name) : [];
  setState((s) => ({ schemas: { ...s.schemas, [environmentId]: { status: 'loading', tree: s.schemas[environmentId]?.tree } } }));
  try {
    const tree = await api().schema.get(environmentId, { refresh });
    setState((s) => ({ schemas: { ...s.schemas, [environmentId]: { status: 'ready', tree } } }));
    for (const name of reopen) void loadDatasetColumns(environmentId, name, true);
  } catch (e) {
    setState((s) => ({ schemas: { ...s.schemas, [environmentId]: { status: 'error', error: errorMessage(e) } } }));
  }
}

/**
 * Engines that read columns on demand (BigQuery): reads the columns of one dataset, when it is opened, and merges
 * them into the tree the renderer holds. The other datasets keep what they have.
 */
export async function loadDatasetColumns(environmentId: string, database: string, refresh = false): Promise<void> {
  const current = getState().schemas[environmentId]?.datasets?.[database];
  if (!refresh && (current?.status === 'ready' || current?.status === 'loading')) return;
  const mark = (state: { status: 'loading' | 'ready' | 'error'; error?: string }, tree?: SchemaTree): void =>
    setState((s) => {
      const view = s.schemas[environmentId];
      if (!view) return {};
      return { schemas: { ...s.schemas, [environmentId]: { ...view, ...(tree ? { tree } : {}), datasets: { ...view.datasets, [database]: state } } } };
    });
  mark({ status: 'loading' });
  try {
    const read = await api().schema.get(environmentId, { database, refresh });
    const scoped = read.databases.find((d) => d.name === database);
    const held = getState().schemas[environmentId]?.tree;
    mark(
      { status: 'ready' },
      held && scoped ? { ...held, databases: held.databases.map((d) => (d.name === database ? scoped : d)) } : undefined,
    );
  } catch (e) {
    mark({ status: 'error', error: errorMessage(e) });
  }
}

// --- tabs --------------------------------------------------------------------

export function openTab(
  environmentId: string,
  opts: { sql?: string; database?: string; run?: boolean; scriptId?: string } = {},
): string {
  const tab: TabState = {
    id: crypto.randomUUID(),
    environmentId,
    sql: opts.sql ?? '',
    database: opts.database ?? null,
    ...(opts.scriptId ? { scriptId: opts.scriptId } : {}),
  };
  setState((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, focusOrder: focusTab(s.focusOrder, tab.id), picker: false }));
  scheduleSaveTabs();
  void loadSchema(environmentId);
  // a tab the person opens connects right away, so a failure (no network route to the server) shows before
  // running; restored tabs never come through here, so starting the app opens no connection
  if (opts.run) void runTab(tab.id, 'all');
  else void ensureSession(tab.id);
  return tab.id;
}

export function selectTab(tabId: string): void {
  setState((s) => ({ activeTabId: tabId, focusOrder: focusTab(s.focusOrder, tabId) }));
  scheduleSaveTabs();
}

/** Single click on an environment: focus a tab of it, or open one. Returns the tab. */
export function focusOrOpenEnvironment(environmentId: string): string {
  const s = getState();
  const existing = tabForEnvironment(s.tabs, s.activeTabId, s.focusOrder, environmentId);
  if (!existing) return openTab(environmentId);
  if (existing !== s.activeTabId) selectTab(existing);
  return existing;
}

export function environmentHasTab(environmentId: string): boolean {
  return getState().tabs.some((t) => t.environmentId === environmentId);
}

export function updateTabSql(tabId: string, sql: string): void {
  setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, sql } : t)) }));
  scheduleSaveTabs();
}

function updateTabDatabase(tabId: string, database: string | null): void {
  setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, database } : t)) }));
  scheduleSaveTabs();
}

function removeTab(tabId: string): void {
  setState((s) => {
    const index = s.tabs.findIndex((t) => t.id === tabId);
    const tabs = s.tabs.filter((t) => t.id !== tabId);
    const { [tabId]: _session, ...sessions } = s.sessions;
    const { [tabId]: _run, ...runs } = s.runs;
    const { [tabId]: _mode, ...pendingModes } = s.pendingModes;
    const { [tabId]: _estimate, ...estimates } = s.estimates;
    const activeTabId =
      s.activeTabId === tabId ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : s.activeTabId;
    const remaining = s.focusOrder.filter((id) => id !== tabId);
    const focusOrder = activeTabId ? focusTab(remaining, activeTabId) : remaining;
    return { tabs, sessions, runs, pendingModes, estimates, activeTabId, focusOrder };
  });
  scheduleSaveTabs();
}

export async function requestCloseTab(tabId: string, discardEdits = false): Promise<void> {
  // closing drops the pending grid edits like running again does: ask first, before the
  // transaction question, so cancelling here leaves nothing committed or rolled back
  if (!discardEdits && pendingEditCount(tabId) > 0) {
    askDiscardEdits(tabId, () => void requestCloseTab(tabId, true));
    return;
  }
  const session = getState().sessions[tabId];
  if (session?.transaction.open) {
    setState({ closeTx: { tabId } });
    return;
  }
  await closeAfterChecks(tabId);
}

/** After the transaction question (if any): a linked tab with unsaved changes asks before closing. */
async function closeAfterChecks(tabId: string): Promise<void> {
  if (tabIsDirty(tabId)) {
    setState({ closeTx: null, closeDirty: { tabId } });
    return;
  }
  await finalizeClose(tabId);
}

/** Answer of the open-transaction dialog: resolve it, then continue with the other checks. */
export async function resolveTransactionThenClose(tabId: string, resolve: 'commit' | 'rollback'): Promise<void> {
  try {
    const state = resolve === 'commit' ? await api().session.commit(tabId) : await api().session.rollback(tabId);
    setSession(state);
  } catch (e) {
    showToast(errorMessage(e));
    return;
  }
  await closeAfterChecks(tabId);
}

export async function answerCloseDirty(tabId: string, choice: 'save' | 'discard'): Promise<void> {
  if (choice === 'save' && !(await saveLinkedTab(tabId))) return;
  setState({ closeDirty: null });
  await finalizeClose(tabId);
}

export async function finalizeClose(tabId: string, resolve?: 'commit' | 'rollback'): Promise<void> {
  try {
    await api().session.close(tabId, resolve ? { resolve } : undefined);
  } catch (e) {
    showToast(errorMessage(e));
    return;
  }
  removeTab(tabId);
  setState({ closeTx: null });
}

// --- sessions ----------------------------------------------------------------

/** Opens in progress, per tab: a Run during the open waits for it instead of doing nothing. */
const opening = new Map<string, Promise<boolean>>();

/** Connects the tab unless it already is. Always through `session.open` (seal check and zod in main). */
function ensureSession(tabId: string): Promise<boolean> {
  const inflight = opening.get(tabId);
  if (inflight) return inflight;
  const s = getState();
  if (!s.tabs.some((t) => t.id === tabId)) return Promise.resolve(false);
  if (s.sessions[tabId]?.status === 'idle') return Promise.resolve(true);
  const p = openSession(tabId).finally(() => opening.delete(tabId));
  opening.set(tabId, p);
  return p;
}

async function openSession(tabId: string): Promise<boolean> {
  const tab = getState().tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  patchRun(tabId, { connecting: true, message: undefined });
  try {
    // The mode belongs to the tab. A mode chosen before connecting is sent along (the production
    // autocommit confirmation was already given in the UI); on a reconnect main keeps the previous mode.
    const wanted = getState().pendingModes[tabId];
    let session = await api().session.open(tabId, tab.environmentId, wanted ? { mode: wanted, confirmed: true } : undefined);
    setSession(session);
    void loadSchema(tab.environmentId);
    if (tab.database && tab.database !== session.database) {
      try {
        session = await api().session.useDatabase(tabId, tab.database);
        setSession(session);
      } catch {
        // the saved database may not exist anymore; keep the default one
      }
    }
    setState((st) => {
      const { [tabId]: _used, ...pendingModes } = st.pendingModes;
      return { pendingModes };
    });
    patchRun(tabId, { connecting: false });
    return true;
  } catch (e) {
    // the tab was closed while it connected: main dropped the connection, there is nothing to show
    if (!getState().tabs.some((t) => t.id === tabId)) return false;
    // a connection error is on the session (chip and notice); anything refused before that goes to the results.
    // The state event and the reply are not ordered: ask main.
    const state = await api()
      .session.state(tabId)
      .catch(() => undefined);
    if (state && state.environmentId === tab.environmentId) setSession(state);
    const shown = getState().sessions[tabId]?.status === 'error';
    patchRun(tabId, { connecting: false, message: shown ? undefined : errorMessage(e) });
    return false;
  }
}

/** Conectar and Reconectar: the tab keeps its text, mode and database. */
export async function connectTab(tabId: string): Promise<void> {
  await ensureSession(tabId);
}

/**
 * Desconectar (also the notice of a dropped connection): the tab stays, with its text, mode and database.
 * Main refuses it with a transaction open; the button is disabled then too.
 */
export async function disconnectTab(tabId: string): Promise<void> {
  try {
    setSession(await api().session.disconnect(tabId));
    patchRun(tabId, { message: undefined });
  } catch (e) {
    showToast(errorMessage(e));
  }
}

/** Tabs with a Run waiting for the connection: a second Cmd+Enter meanwhile does nothing. */
const queuedRuns = new Set<string>();

export async function runTab(
  tabId: string,
  scope: 'current' | 'all',
  opts: { confirmed?: boolean; maxRows?: number; request?: Partial<RunRequest>; discardEdits?: boolean } = {},
): Promise<void> {
  const tab = getState().tabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (getState().runs[tabId]?.running || queuedRuns.has(tabId)) return;
  if (!opts.discardEdits && pendingEditCount(tabId) > 0) {
    // running again replaces the result the edits belong to
    askDiscardEdits(tabId, () => void runTab(tabId, scope, { ...opts, discardEdits: true }));
    return;
  }

  // waits for an open in progress (the tab was just opened) or connects a disconnected tab
  queuedRuns.add(tabId);
  let connected: boolean;
  try {
    connected = await ensureSession(tabId);
  } finally {
    queuedRuns.delete(tabId);
  }
  if (!connected) return;

  const editor = tabId === getState().activeTabId ? activeEditor?.getSelection() : undefined;
  const request: RunRequest = {
    sql: tab.sql,
    scope,
    cursor: editor?.cursor ?? tab.sql.length,
    ...(editor?.selection ? { selection: editor.selection } : {}),
    maxRows: opts.maxRows ?? DEFAULT_MAX_ROWS,
    ...(opts.confirmed ? { confirmed: true } : {}),
    ...opts.request,
  };

  patchRun(tabId, { running: true, message: undefined });
  let response: RunResponse;
  try {
    response = await api().session.run(tabId, request);
  } catch (e) {
    // the "no statement under the cursor" refusal is shown as a placeholder, in the renderer's own words
    patchRun(tabId, { running: false, message: errorCode(e) === 'no-statement' ? m().results.noStatement : errorMessage(e) });
    // the session may have been lost
    void api()
      .session.state(tabId)
      .then(setSession)
      .catch(() => undefined);
    return;
  }
  setSession(response.session);

  if (response.needsConfirmation?.reason === 'bytes') {
    // nothing ran: the person sees every statement over the limit and decides for the whole run
    patchRun(tabId, { running: false });
    const { statements, limit } = response.needsConfirmation;
    // what was accepted before stays (a second question is only about the statements whose estimate grew)
    const confirmedBytes = [...(opts.request?.confirmedBytes ?? [])];
    setState({
      bytesConfirm: {
        limit,
        statements,
        onConfirm: () => {
          setState({ bytesConfirm: null });
          // each acceptance is tied to the text it was asked about: main ignores it for any other text
          const next = confirmedBytes.filter((c) => !statements.some((s) => s.sql === c.sql));
          for (const s of statements) next.push({ sql: s.sql, bytes: s.bytesEstimated });
          void runTab(tabId, scope, { ...opts, request: { ...opts.request, confirmedBytes: next } });
        },
      },
    });
    return;
  }
  if (response.needsConfirmation) {
    patchRun(tabId, { running: false });
    const text = m().actions.implicitCommit;
    const engine = getDialect(findEnvironment(tab.environmentId)?.engine ?? 'mysql').displayName;
    setState({
      confirm: {
        title: text.title,
        body: text.body({ engine }),
        items: response.needsConfirmation.statements,
        confirmLabel: text.confirm,
        danger: true,
        onConfirm: () => {
          setState({ confirm: null });
          void runTab(tabId, scope, { ...opts, confirmed: true });
        },
      },
    });
    return;
  }

  const results = response.results;
  const lastWithRows = results.map((r) => !!r.columns).lastIndexOf(true);
  patchRun(tabId, {
    running: false,
    results,
    active: lastWithRows >= 0 ? lastWithRows : Math.max(0, results.length - 1),
    message: undefined,
    edits: undefined,
    editNotice: undefined,
  });
  if (response.session.database !== (tab.database ?? null)) updateTabDatabase(tabId, response.session.database);
  void markScriptRun(tabId);
}

/** Re-runs one truncated read with the extended limit. Only that statement runs. */
export async function fetchMore(tabId: string, resultIndex: number, discardEdits = false): Promise<void> {
  const run = getState().runs[tabId];
  const result = run?.results[resultIndex];
  if (!run || !result) return;
  if (!discardEdits && pendingEditCount(tabId) > 0) {
    askDiscardEdits(tabId, () => void fetchMore(tabId, resultIndex, true));
    return;
  }
  patchRun(tabId, { running: true });
  try {
    const response = await api().session.run(tabId, {
      sql: result.sql,
      scope: 'all',
      cursor: 0,
      maxRows: EXTENDED_MAX_ROWS,
      refetch: true,
    });
    setSession(response.session);
    const fresh = response.results[0];
    if (fresh?.error?.code === 'RESULT_EXPIRED') {
      // the job result is gone: the rows on screen stay, nothing ran again
      patchRun(tabId, { running: false });
      showToast(fresh.error.message);
    } else if (fresh) {
      const results = run.results.map((r, i) => (i === resultIndex ? { ...fresh, index: r.index } : r));
      patchRun(tabId, { running: false, results, edits: undefined, editNotice: undefined });
    } else {
      patchRun(tabId, { running: false });
    }
  } catch (e) {
    patchRun(tabId, { running: false });
    showToast(errorMessage(e));
  }
}

export async function cancelTab(tabId: string): Promise<void> {
  try {
    await api().session.cancel(tabId);
  } catch (e) {
    showToast(errorMessage(e));
  }
}

export function selectResult(tabId: string, index: number): void {
  const run = getState().runs[tabId];
  if (run && run.active !== index && pendingEditCount(tabId) > 0) {
    askDiscardEdits(tabId, () => patchRun(tabId, { active: index }));
    return;
  }
  patchRun(tabId, { active: index });
}

export async function changeMode(tabId: string, mode: SessionMode): Promise<void> {
  const tab = getState().tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const env = findEnvironment(tab.environmentId);
  const session = getState().sessions[tabId];
  const connected = session?.status === 'idle';

  const askProduction = (onConfirm: () => void): void =>
    setState({
      confirm: {
        title: m().actions.productionAutocommit.title,
        body: m().actions.productionAutocommit.body({ environment: env?.name ?? '' }),
        confirmLabel: m().actions.productionAutocommit.confirm,
        danger: true,
        onConfirm: () => {
          setState({ confirm: null });
          onConfirm();
        },
      },
    });

  if (!connected) {
    if (mode === 'autocommit' && env?.production) {
      askProduction(() => setState((s) => ({ pendingModes: { ...s.pendingModes, [tabId]: mode } })));
    } else {
      setState((s) => ({ pendingModes: { ...s.pendingModes, [tabId]: mode } }));
    }
    return;
  }
  try {
    const res = await api().session.setMode(tabId, mode);
    setSession(res.session);
    if (res.needsConfirmation) {
      askProduction(() => {
        void api()
          .session.setMode(tabId, mode, { confirmed: true })
          .then((r) => setSession(r.session))
          .catch((e) => showToast(errorMessage(e)));
      });
    }
  } catch (e) {
    showToast(errorMessage(e));
  }
}

export async function commitTab(tabId: string): Promise<void> {
  try {
    setSession(await api().session.commit(tabId));
  } catch (e) {
    showToast(errorMessage(e));
  }
}

export async function rollbackTab(tabId: string): Promise<void> {
  try {
    setSession(await api().session.rollback(tabId));
  } catch (e) {
    showToast(errorMessage(e));
  }
}

export async function chooseDatabase(tabId: string, database: string): Promise<void> {
  const session = getState().sessions[tabId];
  updateTabDatabase(tabId, database);
  if (session?.status !== 'idle') return;
  try {
    setSession(await api().session.useDatabase(tabId, database));
  } catch (e) {
    showToast(errorMessage(e));
  }
}

// --- quit flow ---------------------------------------------------------------

export async function resolveQuit(pending: PendingTransaction[], resolve: 'commit' | 'rollback'): Promise<void> {
  try {
    for (const p of pending) await api().session.close(p.tabId, { resolve });
    setState({ quit: null });
  } catch (e) {
    setState({ quit: null });
    showToast(errorMessage(e));
    await api().app.quitCancelled();
  }
}

export async function cancelQuit(): Promise<void> {
  setState({ quit: null });
  await api().app.quitCancelled();
}

// --- sidebar shortcuts -------------------------------------------------------

export function openTableTab(environmentId: string, database: string, table: string): void {
  const dialect = getDialect(findEnvironment(environmentId)?.engine ?? 'mysql');
  const sql = dialect.tablePreviewSql(database, table);
  openTab(environmentId, { sql, database, run: true });
}

// --- grid edits --------------------------------------------------------------

/** The tab's pending edits, if they still belong to one of its results. */
export function pendingEdits(tabId: string): GridEdits | undefined {
  const run = getState().runs[tabId];
  const edits = run?.edits;
  return edits && run.results.includes(edits.result) ? edits : undefined;
}

export function pendingEditCount(tabId: string): number {
  const edits = pendingEdits(tabId);
  return edits ? pendingCount(edits.cells).changes : 0;
}

function askDiscardEdits(tabId: string, then: () => void): void {
  setState({
    confirm: {
      title: m().grid.confirmDiscard.title,
      body: m().grid.confirmDiscard.body({ changes: pendingEditCount(tabId) }),
      confirmLabel: m().grid.confirmDiscard.confirm,
      danger: true,
      onConfirm: () => {
        setState({ confirm: null });
        patchRun(tabId, { edits: undefined });
        then();
      },
    },
  });
}

/** Whether (and how) a result of this tab can be edited, from the environment's schema as the renderer has it. */
export function editabilityOf(tabId: string, result: StatementResult): Editability {
  const s = getState();
  const tab = s.tabs.find((t) => t.id === tabId);
  const env = tab ? findEnvironment(tab.environmentId) : undefined;
  const schema = env ? s.schemas[env.id] : undefined;
  const engine = env?.engine ?? 'mysql';
  return gridEditability(result, schema?.status === 'ready' ? schema.tree : undefined, getDialect(engine).valueKind, {
    gridEdit: capabilitiesOf(engine).gridEdit,
    name: getDialect(engine).displayName,
  });
}

/** Sets (or, with `undefined`, removes) the new value of one cell. Typing the original value back removes the edit. */
export function setCellEdit(tabId: string, result: StatementResult, row: number, column: number, value: CellValue | undefined): void {
  const run = getState().runs[tabId];
  if (!run || !run.results.includes(result)) return;
  const current = pendingEdits(tabId);
  const cells: PendingCells = current?.result === result ? { ...current.cells } : {};
  const rowEdits = { ...(cells[row] ?? {}) };
  const original = result.rows?.[row]?.[column] ?? null;
  if (value === undefined || sameCell(value, original)) delete rowEdits[column];
  else rowEdits[column] = value;
  if (Object.keys(rowEdits).length > 0) cells[row] = rowEdits;
  else delete cells[row];
  patchRun(tabId, { edits: pendingCount(cells).changes > 0 ? { result, cells } : undefined, editNotice: undefined });
}

export function discardEdits(tabId: string): void {
  patchRun(tabId, { edits: undefined });
}

/** Tabs reading the schema again before Gerar UPDATE or Aplicar: a second click meanwhile does nothing. */
const preparingEdits = new Set<string>();

const sameKey = (a: readonly KeyColumn[], b: readonly KeyColumn[]): boolean =>
  a.length === b.length && a.every((k, i) => k.index === b[i]!.index && k.column === b[i]!.column && k.type === b[i]!.type);

/**
 * The UPDATEs of the pending edits. The key comes from the environment's schema, read when it was first needed:
 * it is read again here, because a key that grew by a column the query did not select (a migration while the
 * Cais was open) is invisible in the result and would make the WHERE match several rows.
 */
async function editStatements(
  tabId: string,
): Promise<{ edits: GridEdits; target: Editability & { editable: true }; updates: { row: number; sql: string }[] } | null> {
  const edits = pendingEdits(tabId);
  if (!edits || preparingEdits.has(tabId)) return null;
  const before = editabilityOf(tabId, edits.result);
  if (!before.editable) {
    showToast(render(before.reason));
    return null;
  }
  const tab = getState().tabs.find((t) => t.id === tabId);
  const environmentId = tab?.environmentId ?? '';
  preparingEdits.add(tabId);
  try {
    // quietly: the grid keeps its state while the schema is read (no "Carregando o schema")
    const tree = await api().schema.get(environmentId, { refresh: true });
    forgetEstimates(environmentId);
    setState((s) => ({ schemas: { ...s.schemas, [environmentId]: { status: 'ready', tree } } }));
  } catch (e) {
    showToast(m().grid.reason.schemaFailed({ message: errorMessage(e) }));
    return null;
  } finally {
    preparingEdits.delete(tabId);
  }
  // the person may have changed the edits (or run again) meanwhile
  if (pendingEdits(tabId) !== edits) return null;
  const target = editabilityOf(tabId, edits.result);
  if (!target.editable) {
    showToast(render(target.reason));
    return null;
  }
  if (!sameKey(before.key, target.key)) {
    showToast(m().grid.reason.staleSchema);
    return null;
  }
  // a column that changed on the server since the edit (e.g. text to number) is locked now: say which, in the catalog's words
  for (const cols of Object.values(edits.cells)) {
    for (const c of Object.keys(cols).map(Number)) {
      const col = target.columns[c];
      if (col && !col.editable) {
        showToast(render(col.reason));
        return null;
      }
    }
  }
  const dialect = getDialect(findEnvironment(environmentId)?.engine ?? 'mysql');
  try {
    const updates = buildGridUpdates(dialect, target, edits.result.rows ?? [], edits.cells);
    return updates.length > 0 ? { edits, target, updates } : null;
  } catch (e) {
    showToast(errorMessage(e));
    return null;
  }
}

/** Gerar UPDATE: the statements go to the end of the editor, selected, and the pending edits are cleared. Nothing runs. */
export async function generateUpdates(tabId: string): Promise<void> {
  if (getState().activeTabId !== tabId || !activeEditor) return;
  const plan = await editStatements(tabId);
  if (!plan || getState().activeTabId !== tabId || !activeEditor) return;
  activeEditor.insertText(plan.updates.map((u) => `${u.sql};`).join('\n'));
  patchRun(tabId, { edits: undefined, editNotice: undefined });
}

/** Aplicar: the UPDATEs run through the tab's normal path, so the mode decides. */
export async function applyEdits(tabId: string): Promise<void> {
  const tab = getState().tabs.find((t) => t.id === tabId);
  if (!tab || getState().runs[tabId]?.running) return;
  if (effectiveMode(tabId) === 'read-only') return;
  const plan = await editStatements(tabId);
  if (!plan || getState().runs[tabId]?.running) return;
  const mode = effectiveMode(tabId);
  if (mode === 'read-only') return;
  const env = findEnvironment(tab.environmentId);
  if (env?.production && mode === 'autocommit') {
    setState({
      confirm: {
        title: m().grid.confirmApply.title,
        body: m().grid.confirmApply.body({ environment: env.name }),
        items: plan.updates.map((u) => `${u.sql};`),
        confirmLabel: m().grid.confirmApply.confirm,
        danger: true,
        onConfirm: () => {
          setState({ confirm: null });
          void runEdits(tabId, plan);
        },
      },
    });
    return;
  }
  void runEdits(tabId, plan);
}

async function runEdits(tabId: string, plan: NonNullable<Awaited<ReturnType<typeof editStatements>>>): Promise<void> {
  const { edits, target, updates } = plan;
  if (getState().runs[tabId]?.running || queuedRuns.has(tabId)) return;
  queuedRuns.add(tabId);
  let connected: boolean;
  try {
    connected = await ensureSession(tabId);
  } finally {
    queuedRuns.delete(tabId);
  }
  if (!connected) return;

  patchRun(tabId, { running: true, editNotice: undefined });
  let response: RunResponse;
  try {
    response = await api().session.run(tabId, {
      sql: updates.map((u) => `${u.sql};`).join('\n'),
      scope: 'all',
      cursor: 0,
      maxRows: 1,
      origin: 'grid',
    });
  } catch (e) {
    patchRun(tabId, { running: false });
    showToast(errorMessage(e));
    return;
  }
  setSession(response.session);
  if (response.needsConfirmation) {
    // an UPDATE never commits implicitly: nothing ran
    patchRun(tabId, { running: false });
    return;
  }

  const notice: string[] = [];
  const ran = response.results.filter((r) => !r.error);
  const failed = response.results.find((r) => r.error);
  for (const r of ran) {
    // affected rows count the rows found (FOUND_ROWS): anything but one means a stale key or a changed row
    if (r.affectedRows !== 1) notice.push(m().grid.notice.notOne({ statement: r.index + 1, rows: r.affectedRows ?? 0 }));
  }
  if (failed?.error) notice.push(m().grid.notice.failed({ statement: failed.index + 1, message: failed.error.message }));
  if (notice.length > 0) {
    const session = response.session;
    if (session.mode === 'transaction' && session.transaction.open) notice.push(m().grid.notice.transaction);
    else if (failed && session.mode === 'autocommit') notice.push(m().grid.notice.autocommitSaved({ count: ran.length }));
  }
  // the rows whose UPDATE did not run keep their edits
  const kept: PendingCells = {};
  if (failed) for (const u of updates.slice(failed.index)) if (edits.cells[u.row]) kept[u.row] = edits.cells[u.row]!;

  if (ran.length === 0) {
    patchRun(tabId, { running: false, edits: pendingCount(kept).changes > 0 ? { result: edits.result, cells: kept } : undefined, editNotice: notice });
    return;
  }

  // the original read again, in the same session: what the server wrote (triggers, rounding, ON UPDATE)
  let fresh: StatementResult | undefined;
  try {
    const rows = edits.result.rows?.length ?? 0;
    const again = await api().session.run(tabId, {
      sql: edits.result.sql,
      scope: 'all',
      cursor: 0,
      maxRows: rows > DEFAULT_MAX_ROWS ? EXTENDED_MAX_ROWS : DEFAULT_MAX_ROWS,
    });
    setSession(again.session);
    fresh = again.results[0];
    if (fresh?.error) {
      notice.push(m().grid.notice.refreshFailed({ message: fresh.error.message }));
      fresh = undefined;
    }
  } catch (e) {
    notice.push(m().grid.notice.refreshFailed({ message: errorMessage(e) }));
  }
  const run = getState().runs[tabId];
  if (!run) return;
  let result = edits.result;
  let cells = kept;
  // the read runs in the session's current database: after a USE (or a database picked in the session bar)
  // it may read another table of the same name. Keep the old result then: its edits belong to the target.
  if (fresh && !fromTable(fresh, target)) {
    notice.push(m().grid.notice.refreshFailed({ message: m().grid.notice.otherTable }));
    fresh = undefined;
  }
  if (fresh && run.results.includes(edits.result)) {
    result = { ...fresh, index: edits.result.index };
    cells = remapCells(target.key, edits.result.rows ?? [], result.rows ?? [], kept);
  }
  patchRun(tabId, {
    running: false,
    results: run.results.map((r) => (r === edits.result ? result : r)),
    edits: pendingCount(cells).changes > 0 ? { result, cells } : undefined,
    editNotice: notice.length > 0 ? notice : undefined,
  });
  if (notice.length === 0) {
    const inTransaction = getState().sessions[tabId]?.transaction.open;
    showToast((inTransaction ? m().grid.notice.appliedInTransaction : m().grid.notice.applied)({ count: ran.length }), 'info');
  }
}

/** Whether every column of a result that comes from a table comes from the table the UPDATEs wrote. */
function fromTable(result: StatementResult, target: EditTarget): boolean {
  const sources = (result.columns ?? []).flatMap((c) => (c.source ? [c.source] : []));
  return sources.length > 0 && sources.every((s) => s.database === target.database && s.table === target.table);
}

export function dismissEditNotice(tabId: string): void {
  patchRun(tabId, { editNotice: undefined });
}

// --- agent access ------------------------------------------------------------

export function setAgents(agents: AgentsSnapshot): void {
  setState((s) => {
    const live = new Set([...agents.pending, ...agents.awaitingCommit].map((r) => r.id));
    return {
      agents,
      // forget dismissals of requests that are gone
      agentDismissed: s.agentDismissed.filter((id) => live.has(id)),
      agentFocus: s.agentFocus && live.has(s.agentFocus) ? s.agentFocus : null,
    };
  });
}

export async function setAgentAccess(enabled: boolean): Promise<void> {
  try {
    setAgents(await api().agents.setEnabled(enabled));
  } catch (e) {
    showToast(errorMessage(e));
  }
}

export function dismissAgentModal(id: string): void {
  setState((s) => ({ agentDismissed: s.agentDismissed.includes(id) ? s.agentDismissed : [...s.agentDismissed, id], agentFocus: null }));
}

/** From the panel: bring a request's modal back. */
export function reviewAgentRequest(id: string): void {
  setState((s) => ({ agentPanel: false, agentFocus: id, agentDismissed: s.agentDismissed.filter((d) => d !== id) }));
}

export async function approveAgent(id: string, options: ApproveOptions): Promise<void> {
  try {
    await api().agents.approve(id, options);
  } catch (e) {
    showToast(errorMessage(e));
  }
}

export async function rejectAgent(id: string, reason: string): Promise<void> {
  try {
    await api().agents.reject(id, reason.trim() || undefined);
  } catch (e) {
    showToast(errorMessage(e));
  }
}

export async function commitAgent(id: string): Promise<void> {
  try {
    await api().agents.commit(id);
  } catch (e) {
    showToast(errorMessage(e));
  }
}

export async function rollbackAgent(id: string): Promise<void> {
  try {
    const view = await api().agents.rollback(id);
    if (view.rollbackIncomplete) {
      showToast(m().actions.rollbackIncomplete);
    }
  } catch (e) {
    showToast(errorMessage(e));
  }
}

export async function revokeAgentGrant(environmentId: string): Promise<void> {
  try {
    setAgents(await api().agents.revokeGrant(environmentId));
  } catch (e) {
    showToast(errorMessage(e));
  }
}
