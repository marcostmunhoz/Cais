import type {
  CatalogSnapshot,
  Credential,
  CredentialInput,
  Environment,
  EnvironmentDraft,
  EnvironmentInput,
  Project,
  ProjectInput,
  SavedScript,
  ScriptSaveInput,
  SessionMode,
  TabsFile,
} from './model';
import type { AgentRequestView, AgentsSnapshot, ApproveOptions } from './agents';
import type { SchemaTree, SessionState, StatementResult } from './results';
import type { TrailPage, TrailQuery } from './trail';
import type { Locale } from './i18n/locale';

export interface GcloudAccount {
  account: string;
  status: string;
}

export type TestConnectionResult = { ok: true; serverVersion: string } | { ok: false; error: string };

/** What the About window shows. Versions come from main; the renderer cannot know them. */
export interface AboutInfo {
  version: string;
  electron: string;
  chromium: string;
  node: string;
  /** `<platform> <arch>`, e.g. `linux x64`. */
  system: string;
  /** For display only: the renderer opens it through `openLink('repository')`, never by address. */
  repository: string;
}

/**
 * Answer of the version check. `latest` (e.g. `0.2.0`, no `v`) comes with `newer` and `current`.
 * `unavailable` covers every failure (no network, rate limit, repository without releases, invalid answer).
 */
export type LatestCheck =
  | { status: 'newer'; latest: string }
  | { status: 'current'; latest: string }
  | { status: 'unavailable' };

/** The only pages the app opens in the browser. `release` is the page of the newest version the last check found. */
export type AboutLink = 'repository' | 'releases' | 'release';

export interface RunRequest {
  sql: string;
  scope: 'current' | 'all';
  cursor: number;
  selection?: { from: number; to: number };
  maxRows: number;
  confirmed?: boolean;
  /**
   * BigQuery: the estimate in bytes the person accepted, tied to the text of the statement it was asked about (the
   * answer to `needsConfirmation` with reason 'bytes'). A statement with another text, or whose new estimate passes
   * the accepted one, is asked about again.
   */
  confirmedBytes?: { sql: string; bytes: number }[];
  /** "Buscar até 50.000": run one read again with more rows. Main refuses anything that is not a plain read. */
  refetch?: boolean;
  /** "Aplicar" of the grid edits: main accepts it only for UPDATEs and labels them on the trail. */
  origin?: 'grid';
}

export interface RunResponse {
  results: StatementResult[];
  session: SessionState;
  needsConfirmation?:
    | { reason: 'implicit-commit'; statements: string[] }
    /** Statements estimated above the environment's byte limit, nothing ran. `index` is the place in the run. */
    | { reason: 'bytes'; statements: { index: number; sql: string; bytesEstimated: number }[]; limit: number };
}

export interface SetModeResponse {
  session: SessionState;
  needsConfirmation?: { reason: 'production-autocommit' };
}

export interface PendingTransaction {
  tabId: string;
  statements: number;
}

export type Unsubscribe = () => void;

export interface CaisApi {
  platform: string;
  /** App locale resolved by main and checked by the preload. */
  locale: Locale;
  catalog: {
    get(): Promise<CatalogSnapshot>;
    /** Creates a project (an id is ignored: renaming is `renameProject`). */
    saveProject(input: ProjectInput): Promise<Project>;
    /** Main reseals, writes the trail and revokes agent grants of the project's environments. */
    renameProject(id: string, name: string): Promise<Project>;
    /** A new project with a copy of every environment (not the scripts); refused if one is blocked. */
    duplicateProject(id: string, name: string): Promise<Project>;
    deleteProject(id: string): Promise<void>;
    saveEnvironment(input: EnvironmentInput): Promise<Environment>;
    deleteEnvironment(id: string): Promise<void>;
    /** `password`: sent once when saving, never returned. Empty keeps the current one. */
    saveCredential(input: CredentialInput & { password?: string }): Promise<Credential>;
    deleteCredential(id: string): Promise<void>;
    gcloudAccounts(): Promise<GcloudAccount[]>;
  };
  connection: {
    test(draft: EnvironmentDraft): Promise<TestConnectionResult>;
  };
  session: {
    /** `mode`: the tab's mode (a reconnect keeps the previous one when omitted). Production autocommit needs `confirmed`. */
    open(tabId: string, environmentId: string, opts?: { mode?: SessionMode; confirmed?: boolean }): Promise<SessionState>;
    setMode(tabId: string, mode: SessionMode, opts?: { confirmed?: boolean }): Promise<SetModeResponse>;
    run(tabId: string, request: RunRequest): Promise<RunResponse>;
    cancel(tabId: string): Promise<void>;
    commit(tabId: string): Promise<SessionState>;
    rollback(tabId: string): Promise<SessionState>;
    useDatabase(tabId: string, database: string): Promise<SessionState>;
    close(tabId: string, opts?: { resolve?: 'commit' | 'rollback' }): Promise<void>;
    /** Desconectar: keeps the tab, its mode and database. Refused by main with a transaction open (`transaction-open`). */
    disconnect(tabId: string): Promise<SessionState>;
    state(tabId: string): Promise<SessionState>;
  };
  schema: {
    /**
     * The schema tree. `database`, for engines that read columns on demand (BigQuery): the tree comes back with the
     * columns of that database (dataset) filled in; MySQL ignores it and always returns everything.
     */
    get(environmentId: string, opts?: { refresh?: boolean; database?: string }): Promise<SchemaTree>;
  };
  scripts: {
    list(): Promise<SavedScript[]>;
    /** With `id` updates that script (a person saving clears the "agent" mark); without, creates one. */
    save(input: ScriptSaveInput): Promise<SavedScript>;
    rename(id: string, name: string): Promise<SavedScript>;
    duplicate(id: string): Promise<SavedScript>;
    delete(id: string): Promise<void>;
    markRun(id: string, environmentId: string): Promise<SavedScript>;
  };
  agents: {
    get(): Promise<AgentsSnapshot>;
    /** Only the person turns agent access on or off. */
    setEnabled(enabled: boolean): Promise<AgentsSnapshot>;
    approve(id: string, options: ApproveOptions): Promise<AgentRequestView>;
    reject(id: string, reason?: string): Promise<AgentRequestView>;
    commit(id: string): Promise<AgentRequestView>;
    rollback(id: string): Promise<AgentRequestView>;
    revokeGrant(environmentId: string): Promise<AgentsSnapshot>;
  };
  trail: {
    /** The trail of executions (person and agents), newest first. Read-only: nothing edits it. */
    list(query: TrailQuery): Promise<TrailPage>;
  };
  tabs: {
    load(): Promise<TabsFile>;
    save(tabs: TabsFile): Promise<void>;
  };
  app: {
    /** The user backed out of quitting while transactions were open. */
    quitCancelled(): Promise<void>;
    /** What the About window shows: versions of the app and its runtime. */
    about(): Promise<AboutInfo>;
    /** Asks the GitHub releases API whether a newer version exists. Only when the person clicks; never automatic. */
    checkLatest(): Promise<LatestCheck>;
    /** Opens one of a few fixed pages in the system browser. Main builds the address; the renderer never sends one. */
    openLink(target: AboutLink): Promise<void>;
  };
  events: {
    onSessionState(cb: (state: SessionState) => void): Unsubscribe;
    /** A script was created outside the renderer (an agent). */
    onScriptsChanged(cb: () => void): Unsubscribe;
    /** Pending requests, open agent transactions, grants and the recent list changed. */
    onAgents(cb: (snapshot: AgentsSnapshot) => void): Unsubscribe;
    /** Main asks the renderer to resolve open transactions before quitting. */
    onResolveTransactions(cb: (pending: PendingTransaction[]) => void): Unsubscribe;
    /** The application menu asked for the About window. */
    onOpenAbout(cb: () => void): Unsubscribe;
  };
}

/** IPC channel names. */
export const CHANNELS = {
  catalogGet: 'catalog:get',
  catalogSaveProject: 'catalog:saveProject',
  catalogRenameProject: 'catalog:renameProject',
  catalogDuplicateProject: 'catalog:duplicateProject',
  catalogDeleteProject: 'catalog:deleteProject',
  catalogSaveEnvironment: 'catalog:saveEnvironment',
  catalogDeleteEnvironment: 'catalog:deleteEnvironment',
  catalogSaveCredential: 'catalog:saveCredential',
  catalogDeleteCredential: 'catalog:deleteCredential',
  catalogGcloudAccounts: 'catalog:gcloudAccounts',
  connectionTest: 'connection:test',
  sessionOpen: 'session:open',
  sessionSetMode: 'session:setMode',
  sessionRun: 'session:run',
  sessionCancel: 'session:cancel',
  sessionCommit: 'session:commit',
  sessionRollback: 'session:rollback',
  sessionUseDatabase: 'session:useDatabase',
  sessionClose: 'session:close',
  sessionDisconnect: 'session:disconnect',
  sessionState: 'session:state',
  schemaGet: 'schema:get',
  scriptsList: 'scripts:list',
  scriptsSave: 'scripts:save',
  scriptsRename: 'scripts:rename',
  scriptsDuplicate: 'scripts:duplicate',
  scriptsDelete: 'scripts:delete',
  scriptsMarkRun: 'scripts:markRun',
  agentsGet: 'agents:get',
  agentsSetEnabled: 'agents:setEnabled',
  agentsApprove: 'agents:approve',
  agentsReject: 'agents:reject',
  agentsCommit: 'agents:commit',
  agentsRollback: 'agents:rollback',
  agentsRevokeGrant: 'agents:revokeGrant',
  trailList: 'trail:list',
  tabsLoad: 'tabs:load',
  tabsSave: 'tabs:save',
  appQuitCancelled: 'app:quitCancelled',
  appAbout: 'app:about',
  appCheckLatest: 'app:checkLatest',
  appOpenLink: 'app:openLink',
  eventSessionState: 'event:sessionState',
  eventScriptsChanged: 'event:scriptsChanged',
  eventAgents: 'event:agents',
  eventResolveTransactions: 'event:resolveTransactions',
  eventOpenAbout: 'event:openAbout',
} as const;

/** Envelope used on the wire so errors keep their friendly message. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcErrorInfo };

/**
 * What a failed `window.cais` call rejects with: a plain object, because the context bridge copies an Error
 * with its message only (the `code` would be lost). The renderer reads it through `lib/errors.ts`.
 */
export interface IpcErrorInfo {
  message: string;
  code?: string;
}
