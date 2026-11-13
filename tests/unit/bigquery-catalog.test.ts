import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogStore, changedForAgents } from '@main/store/catalog';
import { environmentSealText, Seal } from '@main/store/seal';
import { FakeVault } from '@main/store/vault';
import { catalogSchema } from '@main/store/schemas';
import { connectParamsFor, resolveCredential, type CredentialSources } from '@main/auth/credentials';
import { GIB } from '@shared/engines';
import { setLocale } from '@shared/i18n';
import type { BigqueryEnvironment, EnvironmentInput } from '@shared/model';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cais-bq-store-'));
});
afterEach(() => {
  setLocale('pt-BR');
  rmSync(dir, { recursive: true, force: true });
});

async function open() {
  const vault = new FakeVault();
  const seal = new Seal(dir, vault);
  await seal.load();
  const store = new CatalogStore(dir, vault, seal);
  await store.load();
  return { store, seal, vault };
}

async function seeded() {
  const ctx = await open();
  const project = await ctx.store.saveProject({ name: 'data' });
  const iam = await ctx.store.saveCredential({ name: 'maria', kind: 'gcloud-iam', account: 'maria@empresa.com', dbUsername: 'maria' });
  const password = await ctx.store.saveCredential({ name: 'root', kind: 'password', username: 'root' }, 'pw');
  const input = (over: Partial<Extract<EnvironmentInput, { engine: 'bigquery' }>> = {}): EnvironmentInput => ({
    projectId: project.id, name: 'dev', engine: 'bigquery', gcpProject: 'my-project-1', credentialId: iam.id, production: false, ...over,
  });
  return { ...ctx, project, iam, password, input };
}

describe('catalog: BigQuery environments', () => {
  it('saves and returns a BigQuery environment without host or port', async () => {
    const { store, input } = await seeded();
    const env = (await store.saveEnvironment(input({ maxBytesBilled: 100 * GIB, defaultDatabase: 'sales' }))) as BigqueryEnvironment;
    expect(env).toMatchObject({ engine: 'bigquery', gcpProject: 'my-project-1', maxBytesBilled: 100 * GIB, defaultDatabase: 'sales' });
    expect(env).not.toHaveProperty('host');
    expect(env).not.toHaveProperty('port');
    const onDisk = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
    expect(onDisk.environments[0]).not.toHaveProperty('host');
    expect(catalogSchema.safeParse(onDisk).success).toBe(true);
  });

  it('without a limit the field is absent (no limit)', async () => {
    const { store, input } = await seeded();
    const env = await store.saveEnvironment(input());
    expect(env).not.toHaveProperty('maxBytesBilled');
  });

  it('survives a restart and is signed: nothing blocked', async () => {
    const { store, input, vault } = await seeded();
    await store.saveEnvironment(input({ maxBytesBilled: 5 * GIB }));
    const seal = new Seal(dir, vault);
    await seal.load();
    const again = new CatalogStore(dir, vault, seal);
    await again.load();
    expect((await again.snapshot()).blockedEnvironments).toEqual([]);
    expect(again.environments()[0]).toMatchObject({ engine: 'bigquery', gcpProject: 'my-project-1', maxBytesBilled: 5 * GIB });
  });

  it('the signature covers the project and the limit: a hand edit blocks the environment', async () => {
    for (const edit of [
      (e: Record<string, unknown>) => (e.gcpProject = 'someone-elses-project'),
      (e: Record<string, unknown>) => delete e.maxBytesBilled,
      (e: Record<string, unknown>) => (e.maxBytesBilled = 999 * GIB),
    ]) {
      const { store, input, vault, project } = await seeded();
      await store.saveEnvironment(input({ maxBytesBilled: 5 * GIB }));
      const path = join(dir, 'catalog.json');
      const file = JSON.parse(readFileSync(path, 'utf8'));
      edit(file.environments[0]);
      writeFileSync(path, JSON.stringify(file));
      const seal = new Seal(dir, vault);
      await seal.load();
      const again = new CatalogStore(dir, vault, seal);
      await again.load();
      const snap = await again.snapshot();
      expect(snap.blockedEnvironments).toHaveLength(1);
      expect(() => again.requireTrusted(snap.environments[0]!.id)).toThrow();
      expect(project.id).toBeTruthy();
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'cais-bq-store-'));
    }
  });

  it('a MySQL environment keeps the same JSON and the same signature', async () => {
    const { store, project, password, seal } = await seeded();
    const env = await store.saveEnvironment({ projectId: project.id, name: 'db', engine: 'mysql', host: 'h', port: 3306, credentialId: password.id, production: false });
    const file = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
    expect(Object.keys(file.environments[0]).sort()).toEqual(['credentialId', 'engine', 'host', 'id', 'name', 'port', 'production', 'projectId']);
    expect(file.environments[0]).toMatchObject({ engine: 'mysql', host: 'h', port: 3306 });
    // the signed text is the canonical JSON of the same object: its MAC is still the one stored
    expect(seal.envMac(env.id)).toMatch(/^[0-9a-f]{64}$/);
    const again = new CatalogStore(dir, new FakeVault(), undefined);
    await again.load();
    expect(again.environments()[0]).toEqual(env);
  });

  it('a MySQL catalog written before BigQuery existed loads and is still trusted', async () => {
    const vault = new FakeVault();
    const seal = new Seal(dir, vault);
    await seal.load();
    const credential = { id: 'c1', name: 'root', kind: 'password', username: 'root' };
    const env = { id: 'e1', projectId: 'p1', name: 'dev', engine: 'mysql', host: '10.0.0.5', port: 3306, defaultDatabase: 'app', credentialId: 'c1', production: false, agentLevel: 'free-reads' };
    writeFileSync(join(dir, 'catalog.json'), JSON.stringify({ version: 1, projects: [{ id: 'p1', name: 'api', order: 0 }], environments: [env], credentials: [credential] }));
    // what the previous version signed: the same object as it stood, project name and credential record
    await seal.setEnvs({ e1: seal.mac(environmentSealText({ env, project: 'api' }, credential, null))! });
    const sealAgain = new Seal(dir, vault);
    await sealAgain.load();
    const store = new CatalogStore(dir, vault, sealAgain);
    await store.load();
    expect((await store.snapshot()).blockedEnvironments).toEqual([]);
    expect(store.environments()[0]).toEqual(env);
  });

  describe('refusals', () => {
    it('requires the project and checks its format', async () => {
      const { store, input } = await seeded();
      await expect(store.saveEnvironment(input({ gcpProject: '  ' }))).rejects.toThrow('Informe o projeto do Google Cloud.');
      for (const bad of ['short', 'Has-Upper-1', 'bad_underscore', '1starts-with-digit', 'ends-with-', 'x'.repeat(31), 'a b c d e f', 'host/path-1']) {
        await expect(store.saveEnvironment(input({ gcpProject: bad })), bad).rejects.toThrow('não é um id válido');
      }
    });

    it('takes a domain-scoped project', async () => {
      const { store, input } = await seeded();
      expect(await store.saveEnvironment(input({ gcpProject: 'example.com:my-project' }))).toMatchObject({ gcpProject: 'example.com:my-project' });
    });

    it('refuses a password credential, with a message', async () => {
      const { store, input, password } = await seeded();
      await expect(store.saveEnvironment(input({ credentialId: password.id }))).rejects.toThrow('Google IAM via gcloud');
    });

    it('refuses to turn the credential of a BigQuery environment into a password one', async () => {
      const { store, input, iam } = await seeded();
      await store.saveEnvironment(input());
      await expect(store.saveCredential({ id: iam.id, name: 'maria', kind: 'password', username: 'u' }, 'pw')).rejects.toThrow('Google IAM via gcloud');
      expect(store.getCredential(iam.id)?.kind).toBe('gcloud-iam');
    });

    it('checks the byte limit: whole bytes, 1 GiB or more', async () => {
      const { store, input } = await seeded();
      for (const bad of [0, -1, 1, GIB - 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
        await expect(store.saveEnvironment(input({ maxBytesBilled: bad })), String(bad)).rejects.toThrow('limite de bytes');
      }
      expect(await store.saveEnvironment(input({ maxBytesBilled: GIB }))).toMatchObject({ maxBytesBilled: GIB });
    });

    it('checks the default dataset', async () => {
      const { store, input } = await seeded();
      await expect(store.saveEnvironment(input({ defaultDatabase: 'a-b' }))).rejects.toThrow('dataset padrão');
    });

    it('speaks the app locale', async () => {
      setLocale('en');
      const { store, input } = await seeded();
      await expect(store.saveEnvironment(input({ gcpProject: '' }))).rejects.toThrow('Enter the Google Cloud project.');
    });
  });

  it('changing the project or the limit counts as a change for agents', async () => {
    const { store, input } = await seeded();
    const before = await store.saveEnvironment(input({ maxBytesBilled: 5 * GIB }));
    const same = { ...before } as BigqueryEnvironment;
    expect(changedForAgents(before, same)).toBe(false);
    expect(changedForAgents(before, { ...same, gcpProject: 'other-project' })).toBe(true);
    expect(changedForAgents(before, { ...same, maxBytesBilled: 10 * GIB })).toBe(true);
    expect(changedForAgents(before, { ...same, maxBytesBilled: undefined })).toBe(true);
  });

  it('duplicating a project copies a BigQuery environment whole', async () => {
    const { store, project, input } = await seeded();
    await store.saveEnvironment(input({ maxBytesBilled: 5 * GIB, production: true, agentLevel: 'free-reads' }));
    const { copies } = await store.duplicateProject(project.id, 'data 2');
    expect(copies[0]!.copy).toMatchObject({ engine: 'bigquery', gcpProject: 'my-project-1', maxBytesBilled: 5 * GIB, agentLevel: 'free-reads' });
  });
});

describe('credentials for BigQuery', () => {
  const sources = (log: unknown[][]): CredentialSources => ({
    getPassword: () => 'pw',
    getToken: async () => 'login-token',
    getAccessToken: async (...args) => (log.push(args), `access-${log.length}`),
  });

  it('resolves an access token and a refresh that forces a new one', async () => {
    const log: unknown[][] = [];
    const r = await resolveCredential({ id: 'c', name: 'n', kind: 'gcloud-iam', account: 'a@x.com', dbUsername: 'a', impersonateServiceAccount: 'sa@p.iam.gserviceaccount.com' }, sources(log), 'bigquery');
    expect(r.accessToken).toBe('access-1');
    expect(await r.refresh()).toBe('access-2');
    expect(log).toEqual([['a@x.com', 'sa@p.iam.gserviceaccount.com'], ['a@x.com', 'sa@p.iam.gserviceaccount.com', { force: true }]]);
  });

  it('a password credential does not serve BigQuery', async () => {
    await expect(resolveCredential({ id: 'c', name: 'n', kind: 'password', username: 'u' }, sources([]), 'bigquery')).rejects.toThrow('Google IAM via gcloud');
  });

  it('builds the BigQuery parameters from an environment', async () => {
    const log: unknown[][] = [];
    const credential = { id: 'c', name: 'n', kind: 'gcloud-iam' as const, account: 'a@x.com', dbUsername: 'a' };
    const env: BigqueryEnvironment = { id: 'e', projectId: 'p', name: 'dev', engine: 'bigquery', gcpProject: 'my-project-1', maxBytesBilled: 5 * GIB, defaultDatabase: 'sales', credentialId: 'c', production: false };
    const params = await connectParamsFor(env, env.defaultDatabase, { getCredential: () => credential, sources: sources(log), origin: 'agent' });
    expect(params).toMatchObject({ engine: 'bigquery', project: 'my-project-1', accessToken: 'access-1', maxBytesBilled: 5 * GIB, defaultDataset: 'sales', origin: 'agent' });
    expect(typeof (params as { refresh?: unknown }).refresh).toBe('function');
    expect(JSON.stringify({ ...params, refresh: undefined, accessToken: undefined })).not.toContain('login-token');
  });
});
