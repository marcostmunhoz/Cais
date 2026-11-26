import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogStore } from '@main/store/catalog';
import { ScriptStore } from '@main/store/scripts';
import { CaisError } from '@main/errors';
import { setLocale } from '@shared/i18n';
import { duplicateName } from '@shared/scripts';
import { writeFileAtomic } from '@main/store/atomic';
import { TabsStore } from '@main/store/tabs';
import { FakeVault, SafeStorageVault, type SafeStorageLike } from '@main/store/vault';
import { resolveCredential } from '@main/auth/credentials';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cais-store-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function seeded() {
  const store = new CatalogStore(dir, new FakeVault());
  const project = await store.saveProject({ name: 'api' });
  const cred = await store.saveCredential({ name: 'root', kind: 'password', username: 'root' }, 's3cret!');
  const env = await store.saveEnvironment({
    projectId: project.id, name: 'dev', engine: 'mysql', host: 'h', port: 3306, credentialId: cred.id, production: false,
  });
  return { store, project, cred, env };
}

describe('CatalogStore', () => {
  it('never writes the password in plain text and keeps it out of the snapshot', async () => {
    const { store, cred } = await seeded();
    const secrets = readFileSync(join(dir, 'secrets.json'), 'utf8');
    expect(secrets).not.toContain('s3cret!');
    expect(readFileSync(join(dir, 'catalog.json'), 'utf8')).not.toContain('s3cret!');
    const snapshot = JSON.stringify(await store.snapshot());
    expect(snapshot).not.toContain('s3cret!');
    expect(snapshot).not.toContain(JSON.parse(secrets)[cred.id]);
    expect(store.getPassword(cred.id)).toBe('s3cret!');
    expect((await store.snapshot()).credentialsWithSecret).toEqual([cred.id]);
  });

  it('keeps the current password when the new one is empty and replaces it otherwise', async () => {
    const { store, cred } = await seeded();
    await store.saveCredential({ id: cred.id, name: 'root', kind: 'password', username: 'root2' }, '');
    expect(store.getPassword(cred.id)).toBe('s3cret!');
    await store.saveCredential({ id: cred.id, name: 'root', kind: 'password', username: 'root2' }, 'novaSenha');
    expect(store.getPassword(cred.id)).toBe('novaSenha');
  });

  it('refuses to save a password when the vault is unavailable', async () => {
    const store = new CatalogStore(dir, new FakeVault(false));
    await expect(store.saveCredential({ name: 'x', kind: 'password', username: 'u' }, 'pw')).rejects.toThrow(
      'cofre de senhas',
    );
    expect(existsSync(join(dir, 'secrets.json'))).toBe(false);
    expect((await store.snapshot()).credentials).toEqual([]);
  });

  it('requires a password for a new password credential', async () => {
    const store = new CatalogStore(dir, new FakeVault());
    await expect(store.saveCredential({ name: 'x', kind: 'password', username: 'u' })).rejects.toThrow('Informe a senha');
  });

  it('refuses to delete a credential in use and lists the environments', async () => {
    const { store, cred, env } = await seeded();
    await expect(store.deleteCredential(cred.id)).rejects.toThrow('api · dev');
    await store.deleteEnvironment(env.id);
    await store.deleteCredential(cred.id);
    expect(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'))).toEqual({});
  });

  it('refuses to delete a project that still has environments', async () => {
    const { store, project, env } = await seeded();
    await expect(store.deleteProject(project.id)).rejects.toThrow('dev');
    await store.deleteEnvironment(env.id);
    await store.deleteProject(project.id);
    expect((await store.snapshot()).projects).toEqual([]);
  });

  it('persists and reloads', async () => {
    const { cred } = await seeded();
    const again = new CatalogStore(dir, new FakeVault());
    const snap = await again.snapshot();
    expect(snap.projects).toHaveLength(1);
    expect(snap.environments).toHaveLength(1);
    expect(again.getPassword(cred.id)).toBe('s3cret!');
  });

  it('drops the stored secret when a credential becomes IAM', async () => {
    const { store, cred } = await seeded();
    await store.saveCredential({
      id: cred.id, name: 'root', kind: 'gcloud-iam', account: 'a@x.com', dbUsername: 'a',
    });
    expect(store.getPassword(cred.id)).toBeUndefined();
  });

  it('rejects an environment pointing to a missing credential or project', async () => {
    const { store, project } = await seeded();
    await expect(
      store.saveEnvironment({ projectId: project.id, name: 'x', engine: 'mysql', host: 'h', port: 1, credentialId: 'nope', production: false }),
    ).rejects.toThrow('credencial');
    await expect(
      store.saveEnvironment({ projectId: 'nope', name: 'x', engine: 'mysql', host: 'h', port: 1, credentialId: 'x', production: false }),
    ).rejects.toThrow('Projeto');
  });

  it('serializes concurrent saves', async () => {
    const store = new CatalogStore(dir, new FakeVault());
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.saveProject({ name: `p${i}` })));
    const reloaded = await new CatalogStore(dir, new FakeVault()).snapshot();
    expect(reloaded.projects.map((p) => p.order).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CaisError);
    return (e as CaisError).code;
  }
  throw new Error('expected a refusal');
};
const readCatalogFile = () => JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));

describe('projects: rename and duplicate', () => {
  it('renames a project in place, keeping its id, environments and order; an unknown id is refused', async () => {
    const { store, project, env } = await seeded();
    const { project: renamed, previousName } = await store.renameProject(project.id, '  core ');
    expect(previousName).toBe('api');
    expect(renamed).toEqual({ ...project, name: 'core' });
    const reloaded = await new CatalogStore(dir, new FakeVault()).snapshot();
    expect(reloaded.projects).toEqual([{ ...project, name: 'core' }]);
    expect(reloaded.environments.map((e) => [e.id, e.projectId])).toEqual([[env.id, project.id]]);
    expect(await codeOf(store.renameProject('nope', 'x'))).toBe('not-found');
    // an unknown id never creates a project
    expect((await store.snapshot()).projects).toHaveLength(1);
  });

  it('names are trimmed, NFC and without invisible text, unique ignoring case', async () => {
    const { store, project } = await seeded();
    const nfd = 'Cafe\u0301';
    const other = await store.saveProject({ name: ` ${nfd}\u200B ` });
    expect(other.name).toBe('Café');
    expect(other.name).toBe('Café'.normalize('NFC'));
    expect(await codeOf(store.saveProject({ name: 'CAFÉ' }))).toBe('duplicate-name');
    expect(await codeOf(store.saveProject({ name: 'CAFE\u0301' }))).toBe('duplicate-name');
    expect(await codeOf(store.renameProject(project.id, 'café'))).toBe('duplicate-name');
    expect(await codeOf(store.renameProject(project.id, '\u200B\u202E '))).toBe('invalid-name');
    // a case-only rename of the project itself is allowed
    expect((await store.renameProject(other.id, 'CAFÉ')).project.name).toBe('CAFÉ');
  });

  it('environment names follow the same rules inside a project', async () => {
    const { store, project, cred } = await seeded();
    const base = { projectId: project.id, engine: 'mysql' as const, host: 'h', port: 3306, credentialId: cred.id, production: false };
    const hml = await store.saveEnvironment({ ...base, name: 'Ho\u0301molog\u200D' });
    expect(hml.name).toBe('Hómolog');
    expect(await codeOf(store.saveEnvironment({ ...base, name: 'HO\u0301MOLOG' }))).toBe('duplicate-name');
    expect(await codeOf(store.saveEnvironment({ ...base, name: 'DEV' }))).toBe('duplicate-name');
  });

  it('"/" is refused in a new or changed name; a stored name with "/" keeps working while unchanged', async () => {
    const { store, project, cred, env } = await seeded();
    const base = { projectId: project.id, engine: 'mysql' as const, host: 'h', port: 3306, credentialId: cred.id, production: false };
    expect(await codeOf(store.saveProject({ name: 'a/b' }))).toBe('invalid-name');
    expect(await codeOf(store.renameProject(project.id, 'a/b'))).toBe('invalid-name');
    expect(await codeOf(store.saveEnvironment({ ...base, name: 'x/y' }))).toBe('invalid-name');
    expect(await codeOf(store.saveEnvironment({ ...env, name: 'dev/2' }))).toBe('invalid-name');
    // names already stored with "/" (the file may hold them)
    const c = readCatalogFile();
    c.projects[0].name = 'legacy/api';
    c.environments[0].name = 'old/dev';
    writeFileSync(join(dir, 'catalog.json'), JSON.stringify(c));
    const again = new CatalogStore(dir, new FakeVault());
    await again.load();
    expect((await again.saveEnvironment({ ...env, name: 'old/dev', host: 'h2' } as typeof env & { host: string })).name).toBe('old/dev');
    expect((await again.renameProject(project.id, 'legacy/api')).project.name).toBe('legacy/api');
    expect(await codeOf(again.renameProject(project.id, 'legacy/core'))).toBe('invalid-name');
    expect((await again.renameProject(project.id, 'core')).project.name).toBe('core');
    expect(await codeOf(again.renameProject(project.id, 'legacy/api'))).toBe('invalid-name');
  });

  it('duplicates a project with every environment in one write: new ids, same credential, no scripts', async () => {
    const { store, project, cred, env } = await seeded();
    const pro = await store.saveEnvironment({
      projectId: project.id, name: 'pro', engine: 'mysql', host: 'db', port: 3307, defaultDatabase: 'app', credentialId: cred.id, production: true, agentLevel: 'free-reads',
    });
    const scripts = new ScriptStore(dir, { getProject: (id) => store.getProject(id), getEnvironment: (id) => store.getEnvironment(id), now: () => 1 });
    await scripts.load();
    await scripts.save({ projectId: project.id, name: 'q', sql: 'SELECT 1' }, 'user');
    const { project: copy, copies } = await store.duplicateProject(project.id, 'api (cópia)');
    expect(copy.name).toBe('api (cópia)');
    expect(copy.order).toBe(project.order + 1);
    expect(copies.map((c) => c.source.id)).toEqual([env.id, pro.id]);
    for (const { source, copy: e } of copies) {
      expect(e.id).not.toBe(source.id);
      expect(e.projectId).toBe(copy.id);
      const { id: _a, projectId: _b, ...rest } = e;
      const { id: _c, projectId: _d, ...was } = source;
      expect(rest).toEqual(was);
    }
    const reloaded = await new CatalogStore(dir, new FakeVault()).snapshot();
    expect(reloaded.environments).toHaveLength(4);
    expect(reloaded.credentials).toHaveLength(1);
    expect(scripts.countForProject(copy.id)).toBe(0);
    expect(scripts.countForProject(project.id)).toBe(1);
    // the copy's name follows the project rules
    expect(await codeOf(store.duplicateProject(project.id, 'API (CÓPIA)'))).toBe('duplicate-name');
    expect(await codeOf(store.duplicateProject(project.id, 'x/y'))).toBe('invalid-name');
    expect(await codeOf(store.duplicateProject('nope', 'x'))).toBe('not-found');
    expect((await store.snapshot()).projects).toHaveLength(2);
  });

  it('duplicateName takes the suffix from the app locale', () => {
    expect(duplicateName('api', () => false, 200)).toBe('api (cópia)');
    setLocale('en');
    try {
      expect(duplicateName('api', (n) => n === 'api (copy)', 200)).toBe('api (copy 2)');
    } finally {
      setLocale('pt-BR');
    }
  });
});

describe('credential resolution', () => {
  it('password: tls off', async () => {
    const r = await resolveCredential(
      { id: 'c', name: 'n', kind: 'password', username: 'root' },
      { getPassword: () => 'pw', getToken: async () => 'unused' },
      'mysql',
    );
    expect(r).toEqual({ user: 'root', password: 'pw', tls: 'off' });
  });
  it('IAM: token as password, clear-text plugin, tls required', async () => {
    const calls: unknown[] = [];
    const r = await resolveCredential(
      { id: 'c', name: 'n', kind: 'gcloud-iam', account: 'a@x.com', dbUsername: 'a', impersonateServiceAccount: 'sa@p.iam.gserviceaccount.com' },
      { getPassword: () => undefined, getToken: async (...a) => (calls.push(a), 'TOKEN') },
      'mysql',
    );
    expect(r).toEqual({ user: 'a', password: 'TOKEN', authPlugin: 'mysql_clear_password', tls: 'required' });
    expect(calls).toEqual([['a@x.com', 'sa@p.iam.gserviceaccount.com']]);
  });
});

describe('atomic writes and tabs', () => {
  it('leaves no temporary files behind', async () => {
    await writeFileAtomic(join(dir, 'a.json'), '{"x":1}');
    await writeFileAtomic(join(dir, 'a.json'), '{"x":2}');
    expect(readdirSync(dir)).toEqual(['a.json']);
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe('{"x":2}');
  });

  it('tabs round trip and survive a corrupt file', async () => {
    const tabs = new TabsStore(dir);
    expect(await tabs.load()).toEqual({ version: 1, tabs: [], activeTabId: null });
    const file = { version: 1 as const, tabs: [{ id: 't', environmentId: 'e', sql: 'SELECT 1' }], activeTabId: 't' };
    await tabs.save(file);
    expect(await tabs.load()).toEqual(file);
    await writeFileAtomic(join(dir, 'tabs.json'), '{broken');
    const reloaded = await tabs.load();
    expect(reloaded).toMatchObject({ version: 1, tabs: [], activeTabId: null });
    expect(reloaded.notice).toContain('tabs.json');
    expect(readdirSync(dir).some((f) => f.startsWith('tabs.corrupt-'))).toBe(true);
    expect(existsSync(join(dir, 'tabs.json'))).toBe(false);
  });
});

describe('corrupt files are set aside, never block startup', () => {
  it('catalog.json: invalid JSON or invalid shape is renamed and the store starts empty with a notice', async () => {
    for (const bad of ['{broken', '{"version":1,"projects":[null],"environments":[],"credentials":[]}', '[]']) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'catalog.json'), bad);
      const store = new CatalogStore(dir, new FakeVault());
      const snap = await store.snapshot();
      expect(snap.projects).toEqual([]);
      expect(snap.notices).toHaveLength(1);
      expect(snap.notices[0]).toContain('catalog.json');
      expect(snap.notices[0]).toContain('.corrupt-');
      const aside = readdirSync(dir).find((f) => f.startsWith('catalog.corrupt-'))!;
      expect(readFileSync(join(dir, aside), 'utf8')).toBe(bad);
      await store.saveProject({ name: 'novo' }); // usable afterwards
    }
  });

  it('secrets.json: set aside, credentials then lack a password', async () => {
    const { store, cred } = await seeded();
    expect((await store.snapshot()).credentialsWithSecret).toEqual([cred.id]);
    writeFileSync(join(dir, 'secrets.json'), '{"x": 1}');
    const again = new CatalogStore(dir, new FakeVault());
    const snap = await again.snapshot();
    expect(snap.credentials).toHaveLength(1);
    expect(snap.credentialsWithSecret).toEqual([]);
    expect(snap.notices[0]).toContain('secrets.json');
  });

  it('tabs.json with null entries is rejected as a whole', async () => {
    writeFileSync(join(dir, 'tabs.json'), '{"version":1,"tabs":[null],"activeTabId":null}');
    const loaded = await new TabsStore(dir).load();
    expect(loaded.tabs).toEqual([]);
    expect(loaded.notice).toContain('tabs.json');
  });
});

describe('main store messages in English', () => {
  afterEach(() => setLocale('pt-BR'));

  it('throws, notices and integrity notes follow the app locale; the ref is what the agents get (rendered in AGENT_LOCALE, English)', async () => {
    const { store, project, cred } = await seeded();
    setLocale('en');
    await expect(store.saveCredential({ name: 'x', kind: 'password', username: 'u' })).rejects.toThrow('Enter the password.');
    await expect(store.deleteCredential(cred.id)).rejects.toThrow('The credential is in use by: api · dev.');
    await expect(store.deleteProject(project.id)).rejects.toThrow('The project still has environments: dev. Delete the environments first.');
    await writeFileAtomic(join(dir, 'tabs.json'), '{broken');
    expect((await new TabsStore(dir).load()).notice).toMatch(/^The file tabs\.json was unreadable and was set aside at .+\. Cais opened without that data\.$/);
    const error = (await resolveCredential(
      { id: 'c', name: 'root', kind: 'password', username: 'root' },
      { getPassword: () => undefined, getToken: async () => 'x' },
      'mysql',
    ).catch((e: unknown) => e)) as CaisError;
    expect(error.message).toBe('The credential "root" has no saved password.');
    expect(error.ref).toEqual({ key: 'mainMisc.credentialNoPassword', params: { name: 'root' } });
  });
});

describe('SafeStorageVault availability', () => {
  const safe = (available: boolean, backend?: string): SafeStorageLike => ({
    isEncryptionAvailable: () => available,
    encryptString: (v) => Buffer.from(v),
    decryptString: (b) => b.toString(),
    ...(backend === undefined ? {} : { getSelectedStorageBackend: () => backend }),
  });

  it.each([
    ['basic_text', false],
    ['unknown', false],
    ['gnome_libsecret', true],
    ['kwallet6', true],
  ])('on linux with backend %s, available is %s', (backend, expected) => {
    expect(new SafeStorageVault(safe(true, backend), 'linux').isAvailable()).toBe(expected);
  });

  it('on linux without a backend report, is unavailable', () => {
    expect(new SafeStorageVault(safe(true), 'linux').isAvailable()).toBe(false);
  });

  it('on linux, is unavailable when encryption is not available', () => {
    expect(new SafeStorageVault(safe(false, 'gnome_libsecret'), 'linux').isAvailable()).toBe(false);
  });

  it('on darwin, ignores the backend', () => {
    expect(new SafeStorageVault(safe(true), 'darwin').isAvailable()).toBe(true);
    expect(new SafeStorageVault(safe(true, 'basic_text'), 'darwin').isAvailable()).toBe(true);
    expect(new SafeStorageVault(safe(false), 'darwin').isAvailable()).toBe(false);
  });

  it('adds the keyring hint to the refusal only on linux', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cais-vault-'));
    try {
      setLocale('pt-BR');
      const linux = new CatalogStore(dir, new SafeStorageVault(safe(true, 'basic_text'), 'linux'));
      await expect(linux.saveCredential({ name: 'x', kind: 'password', username: 'u' }, 'pw')).rejects.toThrow(
        'password-store=gnome-libsecret',
      );
      const mac = new CatalogStore(dir, new SafeStorageVault(safe(false), 'darwin'));
      await expect(mac.saveCredential({ name: 'y', kind: 'password', username: 'u' }, 'pw')).rejects.not.toThrow(
        'gnome-libsecret',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
