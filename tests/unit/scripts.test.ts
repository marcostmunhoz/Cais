import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Environment } from '@shared/model';
import { duplicateName, isScriptDirty, lastRunText, pickEnvironmentForScript, scriptRecency, sortByRecency } from '@shared/scripts';
import { CatalogStore } from '@main/store/catalog';
import { ScriptStore } from '@main/store/scripts';
import { FakeVault } from '@main/store/vault';
import { AGENT_LOCALE, renderRef, setLocale } from '@shared/i18n';
import { CaisError } from '@main/errors';

let dir: string;
let clock = 1_000;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cais-scripts-'));
  clock = 1_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function seeded() {
  const catalog = new CatalogStore(dir, new FakeVault());
  const api = await catalog.saveProject({ name: 'api' });
  const web = await catalog.saveProject({ name: 'web' });
  const cred = await catalog.saveCredential({ name: 'root', kind: 'password', username: 'root' }, 'pw');
  const mk = (projectId: string, name: string, production = false) =>
    catalog.saveEnvironment({ projectId, name, engine: 'mysql', host: 'h', port: 3306, credentialId: cred.id, production });
  const dev = await mk(api.id, 'dev');
  const pro = await mk(api.id, 'pro', true);
  const scripts = new ScriptStore(dir, {
    getProject: (id) => catalog.getProject(id),
    getEnvironment: (id) => catalog.getEnvironment(id),
    now: () => ++clock,
  });
  catalog.setScriptCounter((id) => scripts.countForProject(id));
  await scripts.load();
  return { catalog, scripts, api, web, dev, pro };
}

describe('ScriptStore', () => {
  it('creates, trims the name and persists in scripts.json', async () => {
    const { scripts, api } = await seeded();
    const s = await scripts.save({ projectId: api.id, name: '  Cartões bloqueados  ', sql: 'SELECT 1', database: 'api' });
    expect(s).toMatchObject({ name: 'Cartões bloqueados', createdBy: 'user', database: 'api' });
    const file = JSON.parse(readFileSync(join(dir, 'scripts.json'), 'utf8'));
    expect(file.version).toBe(1);
    expect(file.scripts).toHaveLength(1);
    const again = new ScriptStore(dir, { getProject: () => undefined, getEnvironment: () => undefined, now: () => 1 });
    await again.load();
    expect(again.list()).toEqual([s]);
  });

  it('keeps names unique per project ignoring case, but not across projects', async () => {
    const { scripts, api, web } = await seeded();
    await scripts.save({ projectId: api.id, name: 'Faturas', sql: 'a' });
    await expect(scripts.save({ projectId: api.id, name: 'faturas', sql: 'b' })).rejects.toThrow(
      'Já existe um script com esse nome em api.',
    );
    await expect(scripts.save({ projectId: api.id, name: '   ', sql: 'b' })).rejects.toThrow('Informe o nome');
    await expect(scripts.save({ projectId: api.id, name: 'x'.repeat(121), sql: 'b' })).rejects.toThrow('120');
    await scripts.save({ projectId: web.id, name: 'Faturas', sql: 'c' });
    expect(scripts.list()).toHaveLength(2);
  });

  it('updates by id; a person saving clears the agent mark; the name stays unique', async () => {
    const { scripts, api } = await seeded();
    const made = await scripts.save({ projectId: api.id, name: 'Duplicados', sql: 'a' }, 'agent');
    expect(made.createdBy).toBe('agent');
    const other = await scripts.save({ projectId: api.id, name: 'Outro', sql: 'x' });
    const saved = await scripts.save({ id: made.id, projectId: api.id, name: 'Duplicados', sql: 'b', database: 'api' });
    expect(saved).toMatchObject({ sql: 'b', createdBy: 'user', database: 'api' });
    expect(saved.updatedAt).toBeGreaterThan(made.updatedAt);
    await expect(scripts.save({ id: made.id, projectId: api.id, name: 'outro', sql: 'b' })).rejects.toThrow('Já existe');
    expect(other.id).not.toBe(made.id);
  });

  it('agents can only create: updating by id as an agent is refused', async () => {
    const { scripts, api } = await seeded();
    const made = await scripts.save({ projectId: api.id, name: 'A', sql: 'a' });
    await expect(scripts.save({ id: made.id, projectId: api.id, name: 'A', sql: 'drop' }, 'agent')).rejects.toThrow('Agentes não editam');
    expect(scripts.get(made.id)!.sql).toBe('a');
  });

  it('renames (clearing the agent mark), duplicates with a free "(cópia N)" name and deletes', async () => {
    const { scripts, api } = await seeded();
    const a = await scripts.save({ projectId: api.id, name: 'Faturas', sql: 'q' }, 'agent');
    const renamed = await scripts.rename(a.id, 'Faturas abertas');
    expect(renamed).toMatchObject({ name: 'Faturas abertas', createdBy: 'user' });
    const c1 = await scripts.duplicate(a.id);
    const c2 = await scripts.duplicate(a.id);
    const c3 = await scripts.duplicate(c1.id);
    expect([c1.name, c2.name, c3.name]).toEqual(['Faturas abertas (cópia)', 'Faturas abertas (cópia 2)', 'Faturas abertas (cópia) (cópia)']);
    expect(c1.sql).toBe('q');
    await scripts.delete(c1.id);
    expect(scripts.list().map((s) => s.name)).not.toContain('Faturas abertas (cópia)');
    await expect(scripts.delete('nope')).rejects.toThrow('não encontrado');
  });

  it('markRun records the environment and refuses an environment of another project', async () => {
    const { scripts, api, web, pro, catalog } = await seeded();
    const a = await scripts.save({ projectId: api.id, name: 'A', sql: 'q' });
    const ran = await scripts.markRun(a.id, pro.id);
    expect(ran.lastRun).toEqual({ environmentId: pro.id, at: expect.any(Number) });
    const cred = (await catalog.snapshot()).credentials[0]!;
    const foreign = await catalog.saveEnvironment({
      projectId: web.id, name: 'dev', engine: 'mysql', host: 'h', port: 1, credentialId: cred.id, production: false,
    });
    await expect(scripts.markRun(a.id, foreign.id)).rejects.toThrow('Ambiente não encontrado');
  });

  it('a project that has scripts cannot be deleted', async () => {
    const { scripts, catalog, web } = await seeded();
    await scripts.save({ projectId: web.id, name: 'A', sql: 'q' });
    await scripts.save({ projectId: web.id, name: 'B', sql: 'q' });
    await expect(catalog.deleteProject(web.id)).rejects.toThrow('O projeto tem 2 scripts.');
    const [first] = scripts.list();
    await scripts.delete(first!.id);
    await expect(catalog.deleteProject(web.id)).rejects.toThrow('O projeto tem 1 script.');
    await scripts.delete(scripts.list()[0]!.id);
    await catalog.deleteProject(web.id);
  });

  it('sets a corrupt scripts.json aside, starts empty and exposes the notice', async () => {
    writeFileSync(join(dir, 'scripts.json'), '{"version":1,"scripts":[{"id":1}]}');
    const store = new ScriptStore(dir, { getProject: () => undefined, getEnvironment: () => undefined, now: () => 5 });
    await store.load();
    expect(store.list()).toEqual([]);
    expect(store.notice).toContain('scripts.json');
    expect(existsSync(join(dir, 'scripts.json'))).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith('scripts.corrupt-'))).toBe(true);
  });

  it('names are NFC-normalized and compared case-insensitively; bidi and control characters are stripped', async () => {
    const { scripts, api } = await seeded();
    const made = await scripts.save({ projectId: api.id, name: 'Relatório', sql: 'a' }); // precomposed
    expect(made.name).toBe('Relatório');
    // the decomposed spelling of the same name is a duplicate
    await expect(scripts.save({ projectId: api.id, name: 'Relatório'.normalize('NFD'), sql: 'b' })).rejects.toThrow('Já existe');
    await expect(scripts.save({ projectId: api.id, name: 'RELATÓRIO'.normalize('NFD'), sql: 'b' })).rejects.toThrow('Já existe');
    const clean = await scripts.save({ projectId: api.id, name: 'ok\u202e\u200fx\nfoo\ufeff', sql: 'c' }, 'agent');
    expect(clean.name).toBe('okx foo');
    await expect(scripts.save({ projectId: api.id, name: '\u202e\u200f\n', sql: 'c' })).rejects.toThrow('Informe o nome');
    const renamed = await scripts.rename(clean.id, 'novo\u202enome');
    expect(renamed.name).toBe('novonome');
  });

  it('keeps inconsistent scripts.json content (duplicate names, unknown project) and tells the person', async () => {
    const { catalog, api } = await seeded();
    const mk = (id: string, projectId: string, name: string) => ({ id, projectId, name, sql: 'x', createdAt: 1, updatedAt: 1, createdBy: 'user' });
    writeFileSync(
      join(dir, 'scripts.json'),
      JSON.stringify({ version: 1, scripts: [mk('1', api.id, 'A'), mk('2', api.id, 'a'), mk('3', 'ghost', 'B'), mk('4', api.id, 'C')] }),
    );
    const store = new ScriptStore(dir, { getProject: (id) => catalog.getProject(id), getEnvironment: () => undefined, now: () => 9 });
    await store.load();
    expect(store.list()).toHaveLength(4);
    expect(store.notice).toBe('O arquivo scripts.json tem scripts inconsistentes (1 com nome repetido no mesmo projeto; 1 de projeto que não existe mais). Eles foram mantidos.');
    const clean = new ScriptStore(join(dir, 'x'), { getProject: () => undefined, getEnvironment: () => undefined, now: () => 9 });
    await clean.load();
    expect(clean.notice).toBeUndefined();
  });

  it('refuses a script for a project that does not exist', async () => {
    const { scripts } = await seeded();
    await expect(scripts.save({ projectId: 'ghost', name: 'A', sql: 'q' })).rejects.toThrow('Projeto não encontrado');
  });
});

const env = (id: string, projectId: string, production = false): Environment => ({
  id, projectId, name: id, engine: 'mysql', host: 'h', port: 1, credentialId: 'c', production,
});

describe('script helpers', () => {
  it('shows the dirty mark only when the text differs from the saved one', () => {
    expect(isScriptDirty('SELECT 1', { sql: 'SELECT 1' })).toBe(false);
    expect(isScriptDirty('SELECT 1 ', { sql: 'SELECT 1' })).toBe(true);
  });

  it('orders by the later of last run and last save, most recent first', () => {
    const list = [
      { name: 'old', updatedAt: 10 },
      { name: 'ran', updatedAt: 5, lastRun: { environmentId: 'e', at: 100 } },
      { name: 'saved', updatedAt: 50 },
    ];
    expect(scriptRecency(list[1]!)).toBe(100);
    expect(sortByRecency(list).map((s) => s.name)).toEqual(['ran', 'saved', 'old']);
  });

  it('picks the environment for Cmd+O: active tab, then last run, then first non-production, then first', () => {
    const envs = [env('pro', 'p1', true), env('dev', 'p1'), env('hml', 'p1'), env('x', 'p2')];
    const script = { projectId: 'p1', lastRun: { environmentId: 'hml', at: 1 } };
    expect(pickEnvironmentForScript(script, envs, 'dev')?.id).toBe('dev');
    expect(pickEnvironmentForScript(script, envs, 'x')?.id).toBe('hml'); // active tab is another project
    expect(pickEnvironmentForScript({ projectId: 'p1' }, envs, null)?.id).toBe('dev');
    expect(pickEnvironmentForScript({ projectId: 'p1', lastRun: { environmentId: 'gone', at: 1 } }, [envs[0]!, envs[3]!], 'zzz')?.id).toBe('pro');
    expect(pickEnvironmentForScript({ projectId: 'none' }, envs)).toBeUndefined();
  });

  it('builds the copy name and the last-run tooltip', () => {
    expect(duplicateName('A', () => false)).toBe('A (cópia)');
    expect(duplicateName('A', (n) => n === 'A (cópia)' || n === 'A (cópia 2)')).toBe('A (cópia 3)');
    expect(duplicateName('x'.repeat(120), () => false)).toHaveLength(120);
    const now = 10 * 86_400_000;
    const envs = [env('pro', 'p')];
    expect(lastRunText({ lastRun: { environmentId: 'pro', at: now - 2 * 86_400_000 } }, envs, now)).toBe('rodou em pro há 2 dias');
    expect(lastRunText({}, envs, now)).toBe('ainda não rodou');
  });
});

describe('ScriptStore messages in English', () => {
  afterEach(() => setLocale('pt-BR'));

  it('shows the person English and keeps a ref that renders in pt-BR for agents', async () => {
    const { scripts, catalog, api, web } = await seeded();
    await scripts.save({ projectId: api.id, name: 'faturas', sql: 'a' });
    setLocale('en');
    const taken = (await scripts.save({ projectId: api.id, name: 'Faturas', sql: 'b' }, 'agent').catch((e: unknown) => e)) as CaisError;
    expect(taken.message).toBe('A script with this name already exists in api.');
    expect(taken.code).toBe('duplicate-name');
    expect(renderRef(taken.ref!, AGENT_LOCALE)).toBe('Já existe um script com esse nome em api.');
    await expect(scripts.save({ projectId: api.id, name: ' ', sql: 'b' })).rejects.toThrow('Enter the script name.');
    await expect(scripts.save({ projectId: api.id, name: 'x'.repeat(121), sql: 'b' })).rejects.toThrow('The name can have up to 120 characters.');
    await expect(scripts.delete('nope')).rejects.toThrow('Script not found.');
    await scripts.save({ projectId: web.id, name: 'w', sql: 'q' });
    await expect(catalog.deleteProject(web.id)).rejects.toThrow('The project has 1 script.');
  });
});
