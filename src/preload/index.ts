import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type CaisApi, type IpcErrorInfo, type IpcResult } from '@shared/ipc';
import { parseLocaleArg } from '@shared/i18n/locale';

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (result.ok) return result.value;
  // a plain object crosses the context bridge with its fields; an Error would arrive with the message only
  const error: IpcErrorInfo = { message: result.error.message, ...(result.error.code ? { code: result.error.code } : {}) };
  throw error;
}

const api: CaisApi = {
  platform: process.platform,
  // chosen by main (--cais-locale=); anything unknown falls back to pt-BR
  locale: parseLocaleArg(process.argv),
  catalog: {
    get: () => invoke(CHANNELS.catalogGet),
    saveProject: (input) => invoke(CHANNELS.catalogSaveProject, input),
    renameProject: (id, name) => invoke(CHANNELS.catalogRenameProject, id, name),
    duplicateProject: (id, name) => invoke(CHANNELS.catalogDuplicateProject, id, name),
    deleteProject: (id) => invoke(CHANNELS.catalogDeleteProject, id),
    saveEnvironment: (input) => invoke(CHANNELS.catalogSaveEnvironment, input),
    deleteEnvironment: (id) => invoke(CHANNELS.catalogDeleteEnvironment, id),
    saveCredential: (input) => invoke(CHANNELS.catalogSaveCredential, input),
    deleteCredential: (id) => invoke(CHANNELS.catalogDeleteCredential, id),
    gcloudAccounts: () => invoke(CHANNELS.catalogGcloudAccounts),
  },
  connection: {
    test: (draft) => invoke(CHANNELS.connectionTest, draft),
  },
  session: {
    open: (tabId, environmentId, opts) => invoke(CHANNELS.sessionOpen, tabId, environmentId, opts),
    setMode: (tabId, mode, opts) => invoke(CHANNELS.sessionSetMode, tabId, mode, opts),
    run: (tabId, request) => invoke(CHANNELS.sessionRun, tabId, request),
    cancel: (tabId) => invoke(CHANNELS.sessionCancel, tabId),
    commit: (tabId) => invoke(CHANNELS.sessionCommit, tabId),
    rollback: (tabId) => invoke(CHANNELS.sessionRollback, tabId),
    useDatabase: (tabId, database) => invoke(CHANNELS.sessionUseDatabase, tabId, database),
    close: (tabId, opts) => invoke(CHANNELS.sessionClose, tabId, opts),
    disconnect: (tabId) => invoke(CHANNELS.sessionDisconnect, tabId),
    state: (tabId) => invoke(CHANNELS.sessionState, tabId),
  },
  schema: {
    get: (environmentId, opts) => invoke(CHANNELS.schemaGet, environmentId, opts),
  },
  scripts: {
    list: () => invoke(CHANNELS.scriptsList),
    save: (input) => invoke(CHANNELS.scriptsSave, input),
    rename: (id, name) => invoke(CHANNELS.scriptsRename, id, name),
    duplicate: (id) => invoke(CHANNELS.scriptsDuplicate, id),
    delete: (id) => invoke(CHANNELS.scriptsDelete, id),
    markRun: (id, environmentId) => invoke(CHANNELS.scriptsMarkRun, id, environmentId),
  },
  agents: {
    get: () => invoke(CHANNELS.agentsGet),
    setEnabled: (enabled) => invoke(CHANNELS.agentsSetEnabled, enabled),
    approve: (id, options) => invoke(CHANNELS.agentsApprove, id, options),
    reject: (id, reason) => invoke(CHANNELS.agentsReject, id, reason),
    commit: (id) => invoke(CHANNELS.agentsCommit, id),
    rollback: (id) => invoke(CHANNELS.agentsRollback, id),
    revokeGrant: (environmentId) => invoke(CHANNELS.agentsRevokeGrant, environmentId),
  },
  trail: {
    list: (query) => invoke(CHANNELS.trailList, query),
  },
  tabs: {
    load: () => invoke(CHANNELS.tabsLoad),
    save: (tabs) => invoke(CHANNELS.tabsSave, tabs),
  },
  app: {
    quitCancelled: () => invoke(CHANNELS.appQuitCancelled),
  },
  events: {
    onSessionState: (cb) => {
      const listener = (_event: unknown, state: Parameters<typeof cb>[0]): void => cb(state);
      ipcRenderer.on(CHANNELS.eventSessionState, listener);
      return () => ipcRenderer.removeListener(CHANNELS.eventSessionState, listener);
    },
    onScriptsChanged: (cb) => {
      const listener = (): void => cb();
      ipcRenderer.on(CHANNELS.eventScriptsChanged, listener);
      return () => ipcRenderer.removeListener(CHANNELS.eventScriptsChanged, listener);
    },
    onAgents: (cb) => {
      const listener = (_event: unknown, snapshot: Parameters<typeof cb>[0]): void => cb(snapshot);
      ipcRenderer.on(CHANNELS.eventAgents, listener);
      return () => ipcRenderer.removeListener(CHANNELS.eventAgents, listener);
    },
    onResolveTransactions: (cb) => {
      const listener = (_event: unknown, pending: Parameters<typeof cb>[0]): void => cb(pending);
      ipcRenderer.on(CHANNELS.eventResolveTransactions, listener);
      return () => ipcRenderer.removeListener(CHANNELS.eventResolveTransactions, listener);
    },
  },
};

contextBridge.exposeInMainWorld('cais', api);
