import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { z } from 'zod';
import { CHANNELS, type IpcResult } from '@shared/ipc';
import { getDialect } from '@shared/dialects/registry';
import { AGENT_LEVEL_LABEL, agentLevelOf, type Environment, type EnvironmentDraft } from '@shared/model';
import { TRAIL_RETENTION_DAYS } from '@shared/agents';
import { m } from '@shared/i18n';
import type { SchemaTree } from '@shared/results';
import { connectParamsFor, type CredentialSources } from './auth/credentials';
import type { GcloudTokenProvider } from './auth/gcloud';
import type { AgentAccess } from './agents/access';
import type { AgentBroker } from './agents/broker';
import { AgentError } from './agents/errors';
import { CaisError } from './errors';
import { getDriver } from './drivers/registry';
import { DriverError } from './drivers/types';
import { SessionManager } from './sessions';
import { changedForAgents, type CatalogStore } from './store/catalog';
import type { ScriptStore } from './store/scripts';
import type { SettingsStore } from './store/settings';
import type { TabsStore } from './store/tabs';
import type { Trail } from './trail';

export interface Services {
  store: CatalogStore;
  tabs: TabsStore;
  scripts: ScriptStore;
  settings: SettingsStore;
  agents: { access: AgentAccess; broker: AgentBroker };
  gcloud: GcloudTokenProvider;
  /** Accounts the registry offers for Google IAM; the gcloud provider's when absent (the e2e hook replaces it with a fixed list). */
  listGcloudAccounts?: () => ReturnType<GcloudTokenProvider['listAccounts']>;
  /** BigQuery access token; the gcloud provider when absent (the e2e hook replaces it with a fixed fake). */
  getAccessToken?: CredentialSources['getAccessToken'];
  sessions: SessionManager;
  /** Called after a session closes, to continue a pending quit. */
  afterSessionClose(): void;
  onQuitCancelled(): void;
  isMainWindow(contents: WebContents): boolean;
  trail: Trail;
  /** A change to what agents may do, by the person, on the trail. */
  recordConfig(detail: string, environment?: Environment): void;
}

const id = z.string().min(1).max(100);
const name = z.string().max(200);
const mode = z.enum(['read-only', 'transaction', 'autocommit']);

// creating only: renaming goes through catalogRenameProject (trail, agents); an id here is ignored
const projectInput = z.object({ name });
const environmentBase = {
  id: id.optional(),
  projectId: id,
  name,
  defaultDatabase: z.string().max(200).optional(),
  credentialId: id,
  production: z.boolean(),
  agentLevel: z.enum(['approve-all', 'free-reads', 'free-reads-writes']).optional(),
};
const environmentInput = z.discriminatedUnion('engine', [
  z.object({ ...environmentBase, engine: z.literal('mysql'), host: z.string().max(255), port: z.number().int().min(1).max(65535) }),
  z.object({
    ...environmentBase,
    engine: z.literal('bigquery'),
    gcpProject: z.string().max(100),
    maxBytesBilled: z.number().int().positive().safe().optional(),
  }),
]);
const credentialInput = z.discriminatedUnion('kind', [
  z.object({
    id: id.optional(),
    name,
    kind: z.literal('password'),
    username: z.string().max(200),
    password: z.string().max(4096).optional(),
  }),
  z.object({
    id: id.optional(),
    name,
    kind: z.literal('gcloud-iam'),
    account: z.string().max(320),
    impersonateServiceAccount: z.string().max(320).optional(),
    dbUsername: z.string().max(200),
  }),
]);
const environmentDraft = z.discriminatedUnion('engine', [
  z.object({
    engine: z.literal('mysql'),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    defaultDatabase: z.string().max(200).optional(),
    credentialId: id,
  }),
  z.object({
    engine: z.literal('bigquery'),
    gcpProject: z.string().min(1).max(100),
    defaultDatabase: z.string().max(200).optional(),
    credentialId: id,
    maxBytesBilled: z.number().int().positive().safe().optional(),
  }),
]);
const runRequest = z.object({
  sql: z.string().max(5_000_000),
  scope: z.enum(['current', 'all']),
  cursor: z.number().int().min(0),
  selection: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).optional(),
  maxRows: z.number().int().min(1).max(50_000),
  confirmed: z.boolean().optional(),
  confirmedBytes: z.array(z.object({ sql: z.string().max(5_000_000), bytes: z.number().int().min(0).safe() })).max(10_000).optional(),
  refetch: z.boolean().optional(),
  origin: z.literal('grid').optional(),
});
const trailQuery = z.object({
  before: z.number().finite().optional(),
  days: z.number().int().min(1).max(TRAIL_RETENTION_DAYS),
  actor: z.enum(['person', 'agent', 'cais']).optional(),
  environmentId: id.optional(),
  text: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(500),
});
const scriptSaveInput = z.object({
  id: id.optional(),
  projectId: id,
  name: z.string().max(1000),
  sql: z.string().max(5_000_000),
  database: z.string().max(200).optional(),
});
const tabsFile = z.object({
  version: z.literal(1),
  tabs: z
    .array(
      z.object({
        id,
        environmentId: z.string().max(100),
        sql: z.string().max(5_000_000),
        database: z.string().max(200).nullable().optional(),
        scriptId: z.string().max(100).optional(),
      }),
    )
    .max(200),
  activeTabId: z.string().max(100).nullable(),
});

function describeError(error: unknown): { message: string; code?: string } {
  if (error instanceof z.ZodError) return { message: m().mainIpc.invalidData, code: 'invalid' };
  if (error instanceof AgentError) return { message: error.message, code: error.code };
  if (error instanceof CaisError) return { message: error.message, ...(error.code ? { code: error.code } : {}) };
  if (error instanceof DriverError) return { message: error.message, ...(error.info.code ? { code: error.info.code } : {}) };
  return { message: error instanceof Error ? error.message : m().mainIpc.unexpected };
}

export function registerIpc(services: Services): void {
  const { store, tabs, scripts, settings, gcloud, sessions, agents } = services;
  const schemaCache = new Map<string, SchemaTree>();
  /** Forgets the environment's schema, the per-dataset reads included (their keys start with the environment id). */
  const dropSchema = (envId: string): void => {
    for (const key of [...schemaCache.keys()]) if (key === envId || key.startsWith(`${envId}\u0000`)) schemaCache.delete(key);
  };

  /** Registers a handler that validates its arguments with zod and never throws across the wire. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handle<R>(channel: string, schema: z.ZodType<any[]>, fn: (...args: any[]) => Promise<R> | R): void {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...raw: unknown[]): Promise<IpcResult<R>> => {
      try {
        if (!services.isMainWindow(event.sender)) throw new CaisError(m().mainIpc.unauthorizedOrigin);
        const args = schema.parse(raw);
        return { ok: true, value: await fn(...args) };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    });
  }

  const sources: CredentialSources = {
    getPassword: (credentialId) => store.getPassword(credentialId),
    getToken: (account, sa) => gcloud.getToken(account, sa),
    getAccessToken: services.getAccessToken ?? ((account, sa, opts) => gcloud.getAccessToken(account, sa, opts)),
  };
  const paramsFor = (target: Parameters<typeof connectParamsFor>[0], database?: string) =>
    connectParamsFor(target, database, { getCredential: (credentialId) => store.getCredential(credentialId), sources, origin: 'person' });

  const t = (...items: z.ZodType[]) => z.tuple(items as [z.ZodType, ...z.ZodType[]]) as unknown as z.ZodType<unknown[]>;
  const none = z.tuple([]) as unknown as z.ZodType<unknown[]>;

  handle(CHANNELS.catalogGet, none, () => store.snapshot());
  handle(CHANNELS.catalogSaveProject, t(projectInput), (input) => store.saveProject({ name: (input as z.infer<typeof projectInput>).name }));
  // a rename changes the agents' "projeto/ambiente" slug of every environment of the project: each one is recorded
  // and its grants and pending requests end
  handle(CHANNELS.catalogRenameProject, t(id, name), async (projectId, newName) => {
    const { project, previousName } = await store.renameProject(projectId as string, newName as string);
    if (project.name !== previousName) {
      for (const env of store.environments().filter((e) => e.projectId === project.id)) {
        services.recordConfig(m().mainIpc.trail.projectRenamed({ from: previousName, to: project.name }), env);
        await agents.broker.environmentChanged(env.id);
      }
    }
    return project;
  });
  // main copies from its own catalog by id; nothing the renderer sends becomes an environment
  handle(CHANNELS.catalogDuplicateProject, t(id, name), async (projectId, newName) => {
    const { project, copies } = await store.duplicateProject(projectId as string, newName as string);
    const sourceName = store.getProject(projectId as string)?.name ?? '?';
    for (const { source, copy } of copies) {
      services.recordConfig(
        m().mainIpc.trail.environmentCopied({ source: `${sourceName}/${source.name}`, level: AGENT_LEVEL_LABEL[agentLevelOf(copy)] }),
        copy,
      );
    }
    return project;
  });
  handle(CHANNELS.catalogDeleteProject, t(id), (projectId) => store.deleteProject(projectId as string));
  handle(CHANNELS.catalogSaveEnvironment, t(environmentInput), async (input) => {
    const before = input.id ? store.getEnvironment(input.id as string) : undefined;
    const wasBlocked = before ? store.isBlocked(before.id) : false;
    const env = await store.saveEnvironment(input as z.infer<typeof environmentInput>);
    dropSchema(env.id);
    const tr = m().mainIpc.trail;
    if (!before) {
      const level = AGENT_LEVEL_LABEL[agentLevelOf(env)];
      services.recordConfig(env.production ? tr.environmentCreatedProduction({ level }) : tr.environmentCreated({ level }), env);
    } else {
      const changes: string[] = [];
      // a rename or a move to another project changes the agents' project/environment slug
      if (before.name !== env.name) changes.push(tr.changeName({ from: before.name, to: env.name }));
      if (before.projectId !== env.projectId) {
        const projectName = (projectId: string): string => store.getProject(projectId)?.name ?? '?';
        changes.push(tr.changeProject({ from: projectName(before.projectId), to: projectName(env.projectId) }));
      }
      const yesNo = (v: boolean): string => (v ? tr.yes : tr.no);
      if (before.production !== env.production) changes.push(tr.changeProduction({ from: yesNo(before.production), to: yesNo(env.production) }));
      if (agentLevelOf(before) !== agentLevelOf(env)) {
        changes.push(tr.changeAgentLevel({ from: AGENT_LEVEL_LABEL[agentLevelOf(before)], to: AGENT_LEVEL_LABEL[agentLevelOf(env)] }));
      }
      if (changes.length > 0) services.recordConfig(tr.environmentChanged({ changes: changes.join('; ') }), env);
      if (wasBlocked) services.recordConfig(tr.environmentReleased, env);
    }
    await sessions.environmentChanged(env.id);
    // grants, pending requests and the agents' connections follow what the agent would reach and the slug it uses
    if (before && changedForAgents(before, env)) await agents.broker.environmentChanged(env.id);
    return env;
  });
  handle(CHANNELS.catalogDeleteEnvironment, t(id), async (envId) => {
    const gone = store.getEnvironment(envId as string);
    await store.deleteEnvironment(envId as string);
    if (gone) services.recordConfig(m().mainIpc.trail.environmentDeleted, gone);
    dropSchema(envId as string);
    await agents.broker.environmentChanged(envId as string);
  });
  handle(CHANNELS.catalogSaveCredential, t(credentialInput), async (raw) => {
    const input = raw as z.infer<typeof credentialInput>;
    let saved;
    if (input.kind === 'password') {
      const { password, ...rest } = input;
      saved = await store.saveCredential(rest, password);
    } else {
      saved = await store.saveCredential(input);
    }
    // a changed credential (user, password, account) is a changed environment for every environment that uses it
    if (input.id) {
      for (const e of store.environments().filter((env) => env.credentialId === saved.id)) {
        await agents.broker.environmentChanged(e.id);
      }
    }
    return saved;
  });
  handle(CHANNELS.catalogDeleteCredential, t(id), (credentialId) => store.deleteCredential(credentialId as string));
  handle(CHANNELS.catalogGcloudAccounts, none, () => (services.listGcloudAccounts ?? (() => gcloud.listAccounts()))());

  handle(CHANNELS.connectionTest, t(environmentDraft), async (raw) => {
    const draft = raw as EnvironmentDraft;
    // a credential used by an environment changed outside the Cais goes nowhere until it is reviewed:
    // the draft's host may be the edited one
    if (store.environments().some((e) => e.credentialId === draft.credentialId && store.isBlocked(e.id))) {
      return { ok: false as const, error: m().mainIpc.blockedCredentialTest };
    }
    try {
      const params = await paramsFor(draft, draft.defaultDatabase?.trim() || undefined);
      const result = await getDriver(draft.engine).test(params);
      return { ok: true as const, serverVersion: result.serverVersion };
    } catch (error) {
      return { ok: false as const, error: describeError(error).message };
    }
  });

  handle(
    CHANNELS.sessionOpen,
    t(id, id, z.object({ mode: mode.optional(), confirmed: z.boolean().optional() }).optional()),
    (tabId, envId, opts) =>
      sessions.open(tabId as string, envId as string, (opts ?? {}) as { mode?: 'read-only'; confirmed?: boolean }),
  );
  handle(CHANNELS.sessionSetMode, t(id, mode, z.object({ confirmed: z.boolean().optional() }).optional()), (tabId, m, opts) =>
    sessions.setMode(tabId as string, m as 'read-only', opts as { confirmed?: boolean } | undefined),
  );
  handle(CHANNELS.sessionRun, t(id, runRequest), (tabId, req) =>
    sessions.run(tabId as string, req as z.infer<typeof runRequest>),
  );
  handle(CHANNELS.sessionCancel, t(id), (tabId) => sessions.cancel(tabId as string));
  handle(CHANNELS.sessionCommit, t(id), (tabId) => sessions.commit(tabId as string));
  handle(CHANNELS.sessionRollback, t(id), (tabId) => sessions.rollback(tabId as string));
  handle(CHANNELS.sessionUseDatabase, t(id, z.string().min(1).max(200)), (tabId, db) =>
    sessions.useDatabase(tabId as string, db as string),
  );
  handle(
    CHANNELS.sessionClose,
    t(id, z.object({ resolve: z.enum(['commit', 'rollback']).optional() }).optional()),
    async (tabId, opts) => {
      await sessions.close(tabId as string, (opts ?? {}) as { resolve?: 'commit' | 'rollback' });
      services.afterSessionClose();
    },
  );
  handle(CHANNELS.sessionDisconnect, t(id), (tabId) => sessions.disconnect(tabId as string));
  handle(CHANNELS.sessionState, t(id), (tabId) => sessions.state(tabId as string));
  // a dry run only: main refuses it while the switch is off and reclassifies the text before anything is sent
  handle(CHANNELS.sessionEstimate, t(id, z.string().max(1_100_000)), (tabId, sql) =>
    sessions.estimate(tabId as string, sql as string),
  );

  const userSettings = () => ({ estimateAsYouType: settings.estimateAsYouType });
  handle(CHANNELS.settingsGet, none, () => userSettings());
  handle(CHANNELS.settingsSetEstimateAsYouType, t(z.boolean()), async (enabled) => {
    await settings.setEstimateAsYouType(enabled as boolean);
    return userSettings();
  });

  handle(
    CHANNELS.schemaGet,
    t(id, z.object({ refresh: z.boolean().optional(), database: z.string().max(1024).optional() }).optional()),
    async (envId, opts) => {
      const key = envId as string;
      const { refresh, database } = (opts ?? {}) as { refresh?: boolean; database?: string };
      const environment = store.getEnvironment(key);
      if (!environment) throw new CaisError(m().mainSessions.environmentNotFound);
      const driver = getDriver(environment.engine);
      const read = async (scope?: { database: string }): Promise<SchemaTree> => {
        store.requireTrusted(environment.id);
        const params = await paramsFor(environment);
        return driver.introspect(params, scope);
      };
      const names = async (): Promise<SchemaTree> => {
        const cached = schemaCache.get(key);
        if (cached && !refresh) return cached;
        const tree = await read();
        schemaCache.set(key, tree);
        return tree;
      };
      if (!driver.lazyColumns || !database) return names();
      // the columns of one dataset: only a name the dataset list knows opens a read (and a cache entry) of its own
      const known = (await names()).databases.find((d) => d.name.toLowerCase() === database.toLowerCase());
      if (!known) return names();
      const scopedKey = `${key}\u0000${known.name.toLowerCase()}`;
      const cached = schemaCache.get(scopedKey);
      if (cached && !refresh) return cached;
      const tree = await read({ database: known.name });
      schemaCache.set(scopedKey, tree);
      return tree;
    },
  );

  handle(CHANNELS.scriptsList, none, () => scripts.list());
  handle(CHANNELS.scriptsSave, t(scriptSaveInput), (input) =>
    scripts.save(input as z.infer<typeof scriptSaveInput>, 'user'),
  );
  handle(CHANNELS.scriptsRename, t(id, z.string().max(1000)), (scriptId, newName) =>
    scripts.rename(scriptId as string, newName as string),
  );
  handle(CHANNELS.scriptsDuplicate, t(id), (scriptId) => scripts.duplicate(scriptId as string));
  handle(CHANNELS.scriptsDelete, t(id), (scriptId) => scripts.delete(scriptId as string));
  handle(CHANNELS.scriptsMarkRun, t(id, id), (scriptId, envId) => scripts.markRun(scriptId as string, envId as string));

  // Agent decisions: only the main window can make them (`handle` rejects every other sender).
  handle(CHANNELS.agentsGet, none, () => agents.access.snapshot());
  handle(CHANNELS.agentsSetEnabled, t(z.boolean()), async (enabled) => {
    const was = agents.broker.isEnabled();
    await agents.access.set(enabled as boolean);
    if (was !== agents.broker.isEnabled()) {
      services.recordConfig(enabled ? m().mainIpc.trail.agentAccessOn : m().mainIpc.trail.agentAccessOff);
    }
    return agents.access.snapshot();
  });
  handle(
    CHANNELS.agentsApprove,
    t(id, z.object({ shareResult: z.boolean(), grantReads: z.boolean().optional() })),
    (requestId, options) => agents.broker.approve(requestId as string, options as { shareResult: boolean; grantReads?: boolean }),
  );
  handle(CHANNELS.agentsReject, t(id, z.string().max(300).optional()), (requestId, reason) =>
    agents.broker.reject(requestId as string, reason as string | undefined),
  );
  handle(CHANNELS.agentsCommit, t(id), (requestId) => agents.broker.commit(requestId as string));
  handle(CHANNELS.agentsRollback, t(id), (requestId) => agents.broker.rollback(requestId as string));
  handle(CHANNELS.agentsRevokeGrant, t(id), (environmentId) => {
    agents.broker.revokeGrant(environmentId as string);
    return agents.access.snapshot();
  });

  handle(CHANNELS.trailList, t(trailQuery), (query) => services.trail.list(query as z.infer<typeof trailQuery>));

  handle(CHANNELS.tabsLoad, none, () => tabs.load());
  handle(CHANNELS.tabsSave, t(tabsFile), (file) => tabs.save(file as z.infer<typeof tabsFile>));
  handle(CHANNELS.appQuitCancelled, none, () => services.onQuitCancelled());
}

export { getDialect };
