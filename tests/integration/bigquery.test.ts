import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import { GIB } from '@shared/engines';
import { setLocale } from '@shared/i18n';
import type { BigqueryEnvironment, Environment } from '@shared/model';
import type { SessionState } from '@shared/results';
import { connectParamsFor, type CredentialSources } from '@main/auth/credentials';
import { createBigqueryDriver } from '@main/drivers/bigquery';
import { DriverError, type BigqueryConnectParams } from '@main/drivers/types';
import { SessionManager, type PersonTrailLine } from '@main/sessions';
import { CatalogStore } from '@main/store/catalog';
import { Seal } from '@main/store/seal';
import { FakeVault } from '@main/store/vault';
import { FakeBigquery } from '../support/bigquery-fake';

const fake = new FakeBigquery();
beforeAll(() => fake.start());
afterAll(() => fake.stop());

const env = (over: Partial<BigqueryEnvironment> = {}): BigqueryEnvironment => ({
  id: 'e-bq', projectId: 'p', name: 'dev', engine: 'bigquery', gcpProject: 'my-project-1', credentialId: 'c', production: false, ...over,
});

let current: BigqueryEnvironment;
let refreshes: number;
let token: string;
let events: SessionState[];
let trail: PersonTrailLine[];
let manager: SessionManager;

function makeManager(baseUrl = fake.url): SessionManager {
  const driver = createBigqueryDriver({ baseUrl });
  return new SessionManager({
    getEnvironment: () => current,
    resolveConnectParams: async (e): Promise<BigqueryConnectParams> => ({
      engine: 'bigquery',
      project: (e as BigqueryEnvironment).gcpProject,
      accessToken: token,
      refresh: async () => {
        refreshes++;
        return 'fresh-token';
      },
      ...((e as BigqueryEnvironment).maxBytesBilled !== undefined ? { maxBytesBilled: (e as BigqueryEnvironment).maxBytesBilled } : {}),
      ...(e.defaultDatabase ? { defaultDataset: e.defaultDatabase } : {}),
      origin: 'person',
    }),
    getDriver: () => driver,
    getDialect,
    emit: (s) => events.push(s),
    now: () => Date.now(),
    trail: { append: (line) => void trail.push(line) },
  });
}

const run = (sql: string, over: Record<string, unknown> = {}) =>
  manager.run('t1', { sql, scope: 'current', cursor: 0, maxRows: 1000, ...over } as never);

beforeEach(() => {
  current = env();
  refreshes = 0;
  token = 'test-token';
  events = [];
  trail = [];
  fake.reset();
  fake.validTokens = new Set(['test-token', 'fresh-token']);
  fake.statementType = (sql) => (/^\s*\(*\s*(SELECT|WITH|FROM)\b/i.test(sql) ? 'SELECT' : sql.trim().split(/\s+/)[0]!.toUpperCase());
  fake.resultFor = () => ({ schema: [{ name: 'n', type: 'INTEGER' }, { name: 's', type: 'STRING' }], rows: [['1', 'a'], ['2', null]] });
  fake.bytesFor = () => 2048;
  fake.dryRunError = () => undefined;
  fake.runError = () => undefined;
  fake.expireJobs = false;
  fake.queryDelayMs = 0;
  fake.incompleteFirst = () => false;
  fake.failPath = undefined;
  fake.listPageSize = 1000;
  fake.datasets.clear();
  fake.addDataset('sales', { orders: { schema: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] } });
  manager = makeManager();
});

afterEach(async () => {
  await manager.closeAll();
  setLocale('pt-BR');
});

describe('BigQuery through the SessionManager', () => {
  it('opens a tab in Somente leitura, whatever the environment, and runs a SELECT', async () => {
    for (const production of [false, true]) {
      current = env({ production });
      await manager.close('t1');
      const state = await manager.open('t1', current.id);
      expect(state.mode).toBe('read-only');
      expect(state.serverVersion).toBe('BigQuery');
      expect(state.database).toBeNull();
    }
    const { results } = await run('SELECT n, s FROM sales.orders');
    const r = results[0]!;
    expect(r.error).toBeUndefined();
    expect(r.columns).toEqual([
      { name: 'n', type: 'INT64', nullable: true },
      { name: 's', type: 'STRING', nullable: true },
    ]);
    expect(r.rows).toEqual([['1', 'a'], ['2', null]]);
    expect(r.truncated).toBeUndefined();
    expect(r.stats).toMatchObject({ bytesEstimated: 2048, bytesProcessed: 2048, bytesBilled: 10_485_760, cacheHit: false, jobId: 'job_1' });
  });

  it('refuses any mode but Somente leitura', async () => {
    await expect(manager.open('t1', current.id, { mode: 'transaction' })).rejects.toThrow(/Transação não vale/);
    await expect(manager.open('t1', current.id, { mode: 'autocommit' })).rejects.toThrow();
    await manager.open('t1', current.id);
    await expect(manager.setMode('t1', 'transaction')).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });

  it('sends the job the way the plan says: dry run first, then the real one with labels and limits', async () => {
    current = env({ maxBytesBilled: 5 * GIB, defaultDatabase: 'sales' });
    await manager.open('t1', current.id);
    await run('SELECT 1');
    expect(fake.dryRuns).toHaveLength(1);
    expect(fake.realQueries).toHaveLength(1);
    const dry = fake.dryRuns[0]!.body;
    expect(dry).toMatchObject({ query: 'SELECT 1', dryRun: true, useLegacySql: false, defaultDataset: { projectId: 'my-project-1', datasetId: 'sales' } });
    const real = fake.realQueries[0]!.body;
    expect(real).toMatchObject({
      query: 'SELECT 1',
      useLegacySql: false,
      defaultDataset: { projectId: 'my-project-1', datasetId: 'sales' },
      maximumBytesBilled: String(5 * GIB),
      labels: { cais: 'person' },
      formatOptions: { useInt64Timestamp: true },
      jobCreationMode: 'JOB_CREATION_REQUIRED',
    });
    expect(real.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(real.dryRun).toBeUndefined();
    expect(real.timeoutMs).toBeLessThanOrEqual(10_000);
    expect(fake.requests.every((r) => r.authorization === 'Bearer test-token')).toBe(true);
    expect(fake.requests[0]!.path).toBe('/projects/my-project-1/queries');
  });

  it('without a limit it sends no maximumBytesBilled', async () => {
    await manager.open('t1', current.id);
    await run('SELECT 1');
    expect(fake.realQueries[0]!.body).not.toHaveProperty('maximumBytesBilled');
    expect(fake.realQueries[0]!.body).not.toHaveProperty('defaultDataset');
  });

  it('refuses what is not a query in the app, before anything leaves', async () => {
    await manager.open('t1', current.id);
    for (const sql of ['INSERT INTO sales.orders VALUES (1)', 'DELETE FROM sales.orders WHERE true', 'CREATE TABLE sales.x (a INT64)', 'DECLARE x INT64', 'BEGIN SELECT 1; END', 'CALL sales.p()', 'EXPORT DATA OPTIONS(uri="gs://b/x") AS SELECT 1']) {
      const { results } = await run(sql);
      expect(results[0]!.error?.code, sql).toBe('REFUSED');
    }
    expect(fake.requests).toHaveLength(0);
    expect(trail.some((l) => l.state === 'refused')).toBe(true);
  });

  it('refuses when the server reads another statement type, even if the classifier accepts the text', async () => {
    fake.statementType = () => 'INSERT';
    await manager.open('t1', current.id);
    const { results } = await run('SELECT 1');
    expect(results[0]!.error).toMatchObject({ code: 'REFUSED' });
    expect(results[0]!.error!.message).toContain('INSERT');
    expect(fake.dryRuns).toHaveLength(1);
    expect(fake.realQueries).toHaveLength(0);
    expect(trail.at(-1)).toMatchObject({ state: 'refused' });
  });

  it('refuses when the server says no type at all', async () => {
    fake.statementType = () => '';
    await manager.open('t1', current.id);
    const { results } = await run('SELECT 1');
    expect(results[0]!.error?.code).toBe('REFUSED');
    expect(results[0]!.error!.message).toContain('não disse');
    expect(fake.realQueries).toHaveLength(0);
  });

  it('the driver refuses on its own too, when called straight (no prepare, no SessionManager)', async () => {
    fake.statementType = () => 'DELETE';
    const driver = createBigqueryDriver({ baseUrl: fake.url });
    const session = await driver.open({ engine: 'bigquery', project: 'my-project-1', accessToken: 'test-token', origin: 'person' });
    const result = await session.execute('SELECT 1', { maxRows: 10 });
    expect(result.error?.code).toBe('REFUSED');
    expect(fake.realQueries).toHaveLength(0);
    await session.close();
  });

  it('reads pages up to the cap and says it was cut; "Buscar até 50.000" reads the same job, with no new dry run or job', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => [String(i), `s${i}`]);
    fake.resultFor = () => ({ schema: [{ name: 'n', type: 'INTEGER' }, { name: 's', type: 'STRING' }], rows });
    await manager.open('t1', current.id);
    const first = (await run('SELECT n, s FROM big')).results[0]!;
    expect(first.rows).toHaveLength(1000);
    expect(first.truncated).toBe(true);
    expect(first.rows![999]).toEqual(['999', 's999']);
    expect(fake.realQueries).toHaveLength(1);
    expect(fake.dryRuns).toHaveLength(1);

    const again = (await run('SELECT n, s FROM big', { maxRows: 50_000, refetch: true })).results[0]!;
    expect(again.rows).toHaveLength(2500);
    expect(again.truncated).toBeUndefined();
    expect(again.rows![2499]).toEqual(['2499', 's2499']);
    expect(again.stats?.jobId).toBe(first.stats?.jobId);
    expect(fake.realQueries).toHaveLength(1);
    expect(fake.dryRuns).toHaveLength(1);
    expect(fake.jobs.size).toBe(1);
  });

  it('reads a result with more than one page of the server (10.000 rows a page) up to the cap', async () => {
    const rows = Array.from({ length: 25_000 }, (_, i) => [String(i), 'x']);
    fake.resultFor = () => ({ schema: [{ name: 'n', type: 'INTEGER' }, { name: 's', type: 'STRING' }], rows });
    await manager.open('t1', current.id);
    const r = (await run('SELECT n, s FROM big', { maxRows: 12_000 })).results[0]!;
    expect(r.rows).toHaveLength(12_000);
    expect(r.truncated).toBe(true);
    expect(fake.requestsTo('/queries/job_1', 'GET').length).toBeGreaterThanOrEqual(1);
  });

  it('an exact fit is not truncated', async () => {
    fake.resultFor = () => ({ schema: [{ name: 'n', type: 'INTEGER' }], rows: Array.from({ length: 5 }, (_, i) => [String(i)]) });
    await manager.open('t1', current.id);
    const r = (await run('SELECT n FROM t', { maxRows: 5 })).results[0]!;
    expect(r.rows).toHaveLength(5);
    expect(r.truncated).toBeUndefined();
  });

  it('a refetch of a different statement runs it normally', async () => {
    await manager.open('t1', current.id);
    await run('SELECT 1');
    await run('SELECT 2', { refetch: true });
    expect(fake.realQueries).toHaveLength(2);
  });

  it('when the result of the job expired the refetch runs the statement again', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => [String(i)]);
    fake.resultFor = () => ({ schema: [{ name: 'n', type: 'INTEGER' }], rows });
    await manager.open('t1', current.id);
    await run('SELECT n FROM big');
    fake.expireJobs = true;
    const again = (await run('SELECT n FROM big', { maxRows: 50_000, refetch: true })).results[0]!;
    expect(again.error).toBeUndefined();
    expect(again.rows).toHaveLength(1500);
    expect(fake.realQueries).toHaveLength(2);
    expect(fake.dryRuns).toHaveLength(2);
  });

  it('Cancelar stops the job with jobs.cancel, with no gcloud round before it', async () => {
    await manager.open('t1', current.id);
    const running = run('SELECT SLOW');
    for (let i = 0; i < 100 && fake.jobs.size === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(fake.jobs.size).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    await manager.cancel('t1');
    const { results } = await running;
    expect(results[0]!.error).toMatchObject({ code: 'CANCELLED' });
    const cancel = fake.requestsTo('/cancel', 'POST');
    expect(cancel).toHaveLength(1);
    expect(cancel[0]!.path).toBe('/projects/my-project-1/jobs/job_1/cancel');
    expect(cancel[0]!.query.location).toBe('US');
    expect(cancel[0]!.authorization).toBe('Bearer test-token');
    expect(refreshes).toBe(0);
    expect(fake.jobs.get('job_1')!.state).toBe('cancelled');
    expect(manager.state('t1').status).toBe('idle');
    // the tab keeps working
    expect((await run('SELECT 1')).results[0]!.error).toBeUndefined();
  });

  it('closing the tab stops the job that is running', async () => {
    await manager.open('t1', current.id);
    void run('SELECT SLOW').catch(() => undefined);
    for (let i = 0; i < 100 && fake.jobs.size === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    await manager.closeAll();
    expect(fake.jobs.get('job_1')!.state).toBe('cancelled');
  });

  it('closing the tab while jobs.query is still answering still stops the job that the server created', async () => {
    fake.queryDelayMs = 300;
    await manager.open('t1', current.id);
    void run('SELECT SLOW').catch(() => undefined);
    for (let i = 0; i < 100 && fake.jobs.size === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(fake.jobs.size).toBe(1);
    expect(fake.requestsTo('/cancel', 'POST')).toHaveLength(0); // no id on our side yet
    await manager.closeAll();
    for (let i = 0; i < 200 && fake.jobs.get('job_1')!.state === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(fake.jobs.get('job_1')!.state).toBe('cancelled');
    expect(fake.requestsTo('/cancel', 'POST')).toHaveLength(1);
  });

  it('TIMESTAMP reads the same on every page and on a refetch (getQueryResults asks for int64 timestamps)', async () => {
    const stamp = (i: number) => String(1_759_309_964_000_000 + i);
    const rows = Array.from({ length: 15_000 }, (_, i) => [stamp(i)]);
    fake.resultFor = () => ({ schema: [{ name: 'ts', type: 'TIMESTAMP' }], rows });
    await manager.open('t1', current.id);
    const r = (await run('SELECT ts FROM t', { maxRows: 12_000 })).results[0]!;
    expect(r.rows).toHaveLength(12_000);
    const flat = r.rows!.map((x) => String(x[0]));
    expect(flat.every((v) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)? UTC$/.test(v))).toBe(true);
    for (const get of fake.requestsTo('/queries/job_1', 'GET')) expect(get.query['formatOptions.useInt64Timestamp']).toBe('true');
    expect(fake.requestsTo('/queries/job_1', 'GET').length).toBeGreaterThanOrEqual(1);

    fake.resultFor = () => ({ schema: [{ name: 'ts', type: 'TIMESTAMP' }], rows: rows.slice(0, 2500) });
    await manager.close('t1');
    await manager.open('t1', current.id);
    const first = (await run('SELECT ts FROM u')).results[0]!;
    expect(first.truncated).toBe(true);
    const again = (await run('SELECT ts FROM u', { maxRows: 50_000, refetch: true })).results[0]!;
    expect(again.rows).toHaveLength(2500);
    expect(again.rows!.every((x) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)? UTC$/.test(String(x[0])))).toBe(true);
  });

  it('a job that finished by polling still reports the billed bytes (read from jobs.get)', async () => {
    fake.incompleteFirst = () => true;
    await manager.open('t1', current.id);
    const r = (await run('SELECT n FROM t')).results[0]!;
    expect(r.error).toBeUndefined();
    expect(r.stats).toMatchObject({ bytesProcessed: 2048, bytesBilled: 10_485_760, jobId: 'job_1' });
    expect(fake.requestsTo('/jobs/job_1', 'GET')).toHaveLength(1);
  });

  it('a burst of 401s opens one token exchange, not one per call', async () => {
    token = 'old-token';
    fake.datasets.clear();
    for (let i = 0; i < 6; i++) fake.addDataset(`d${i}`, { a: {}, b: {} });
    let exchanges = 0;
    const tree = await createBigqueryDriver({ baseUrl: fake.url }).introspect({
      engine: 'bigquery',
      project: 'my-project-1',
      accessToken: 'old-token',
      origin: 'person',
      refresh: async () => {
        exchanges++;
        await new Promise((r) => setTimeout(r, 30));
        return 'fresh-token';
      },
    });
    expect(tree.databases).toHaveLength(6);
    expect(exchanges).toBe(1);
  });

  it('useDatabase checks the dataset, makes it the default and leaves a readable line on the trail', async () => {
    await manager.open('t1', current.id);
    const state = await manager.useDatabase('t1', 'sales');
    expect(state.database).toBe('sales');
    expect(fake.requestsTo('/datasets/sales', 'GET')).toHaveLength(1);
    const line = trail.find((l) => l.verb === 'DATASET')!;
    expect(line).toMatchObject({ event: 'statement', state: 'ok', kind: 'session' });
    expect(line.sql).toContain('sales');
    await run('SELECT 1');
    expect(fake.realQueries[0]!.body.defaultDataset).toEqual({ projectId: 'my-project-1', datasetId: 'sales' });
  });

  it('a dataset that does not exist is an error and the current one stays', async () => {
    await manager.open('t1', current.id);
    await manager.useDatabase('t1', 'sales');
    await expect(manager.useDatabase('t1', 'nope')).rejects.toThrow(/dataset nope/);
    expect(manager.state('t1').database).toBe('sales');
    await expect(manager.useDatabase('t1', 'bad name; DROP')).rejects.toThrow(/inválido/);
    expect(fake.requestsTo('DROP')).toHaveLength(0);
    expect(trail.filter((l) => l.verb === 'DATASET').map((l) => l.state)).toEqual(['ok', 'error', 'error']);
  });

  it('opens with the environment default dataset as the current database', async () => {
    current = env({ defaultDatabase: 'sales' });
    const state = await manager.open('t1', current.id);
    expect(state.database).toBe('sales');
  });

  it('turns BigQuery errors into messages with the hint and keeps the original text', async () => {
    await manager.open('t1', current.id);
    fake.runError = () => ({ status: 403, reason: 'accessDenied', message: 'Access Denied: Table my-project-1:sales.orders: User does not have permission' });
    const r = (await run('SELECT 1')).results[0]!;
    expect(r.error).toMatchObject({ code: 'accessDenied' });
    expect(r.error!.message).toContain('roles/bigquery.jobUser');
    expect(r.error!.detail).toContain('User does not have permission');
    expect(r.error!.hint).toContain('roles/bigquery.dataViewer');

    fake.runError = () => undefined;
    const realBefore = fake.realQueries.length;
    fake.dryRunError = () => ({ status: 400, reason: 'invalidQuery', message: 'Syntax error: Unexpected end of script at [1:8]' });
    const bad = (await run('SELECT')).results[0]!;
    expect(bad.error?.code).toBe('invalidQuery');
    expect(bad.error!.message).toContain('Syntax error');
    expect(fake.realQueries).toHaveLength(realBefore);

    fake.dryRunError = () => undefined;
    fake.failPath = { includes: '/queries', error: { status: 404, reason: 'notFound', message: 'Not found: Table my-project-1:sales.nope' } };
    expect((await run('SELECT * FROM sales.nope')).results[0]!.error?.code).toBe('notFound');
  });

  it('the server limit of bytes billed is an error with a message, and the job never ran', async () => {
    current = env({ maxBytesBilled: GIB });
    fake.bytesFor = () => 5 * GIB;
    await manager.open('t1', current.id);
    const r = (await run('SELECT * FROM big')).results[0]!;
    expect(r.error?.code).toBe('bytesBilledLimitExceeded');
    expect(r.error!.message).toContain('nada foi cobrado');
    expect(fake.jobs.size).toBe(0);
  });

  it('with no limit set a large estimate still runs', async () => {
    fake.bytesFor = () => 50 * GIB;
    await manager.open('t1', current.id);
    expect((await run('SELECT * FROM big')).results[0]!.error).toBeUndefined();
  });

  it('an expired token (401) asks for another once and repeats the call', async () => {
    token = 'old-token';
    await manager.open('t1', current.id);
    const r = (await run('SELECT 1')).results[0]!;
    expect(r.error).toBeUndefined();
    expect(refreshes).toBe(1);
    const auth = fake.requests.map((x) => x.authorization);
    expect(auth[0]).toBe('Bearer old-token');
    expect(auth.slice(1).every((a) => a === 'Bearer fresh-token')).toBe(true);
    // the new token stays: the next statement needs no new refresh
    await run('SELECT 2');
    expect(refreshes).toBe(1);
  });

  it('a token refused again after the refresh is an error, not a loop', async () => {
    fake.validTokens = new Set(['something-else']);
    await manager.open('t1', current.id);
    const r = (await run('SELECT 1')).results[0]!;
    expect(r.error?.message).toContain('não aceitou o token');
    expect(refreshes).toBe(1);
    expect(fake.requests).toHaveLength(2);
  });

  it('no network: says there was no response from bigquery.googleapis.com, with the VPN and proxy hint', async () => {
    const dead = new FakeBigquery();
    await dead.start();
    const url = dead.url;
    await dead.stop();
    manager = makeManager(url);
    await manager.open('t1', current.id);
    const r = (await run('SELECT 1')).results[0]!;
    expect(r.error!.message).toContain('Sem resposta de bigquery.googleapis.com');
    expect(r.error!.message).toMatch(/VPN/);
    expect(r.error!.message).toMatch(/proxy/);
  });

  it('a BigQuery tab never has a transaction: no probe, no Commit', async () => {
    await manager.open('t1', current.id);
    await run('SELECT 1');
    expect(manager.state('t1').transaction.open).toBe(false);
    expect(manager.pendingTransactions()).toEqual([]);
  });
});

describe('BigQuery driver: schema and test', () => {
  const driver = () => createBigqueryDriver({ baseUrl: fake.url });
  const params = (over: Partial<BigqueryConnectParams> = {}): BigqueryConnectParams => ({ engine: 'bigquery', project: 'my-project-1', accessToken: 'test-token', origin: 'person', ...over });

  it('lists datasets and tables with their kind, and no columns without a scope', async () => {
    fake.datasets.clear();
    fake.addDataset('zeta', { t: {} });
    fake.addDataset('alpha', {
      plain: { schema: [{ name: 'a', type: 'STRING' }] },
      v: { type: 'VIEW' },
      mv: { type: 'MATERIALIZED_VIEW' },
      ext: { type: 'EXTERNAL' },
      snap: { type: 'SNAPSHOT' },
    });
    const tree = await driver().introspect(params());
    expect(tree.databases.map((d) => d.name)).toEqual(['alpha', 'zeta']);
    expect(tree.databases[0]!.tables).toEqual([
      { name: 'ext', type: 'table', subtype: 'external', columns: [] },
      { name: 'mv', type: 'view', subtype: 'materialized-view', columns: [] },
      { name: 'plain', type: 'table', columns: [] },
      { name: 'snap', type: 'table', subtype: 'snapshot', columns: [] },
      { name: 'v', type: 'view', columns: [] },
    ]);
    expect(fake.requestsTo('/tables/')).toHaveLength(0);
  });

  it('reads every page of datasets and tables', async () => {
    fake.datasets.clear();
    for (let i = 0; i < 5; i++) fake.addDataset(`d${i}`, { a: {}, b: {}, c: {} });
    fake.listPageSize = 2;
    const tree = await driver().introspect(params());
    expect(tree.databases.map((d) => d.name)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4']);
    expect(tree.databases.every((d) => d.tables.length === 3)).toBe(true);
  });

  it('with a dataset in scope it reads the columns of that dataset only, in full type text', async () => {
    fake.datasets.clear();
    fake.addDataset('sales', {
      orders: {
        schema: [
          { name: 'id', type: 'INTEGER', mode: 'REQUIRED' },
          { name: 'tags', type: 'STRING', mode: 'REPEATED' },
          { name: 'addr', type: 'RECORD', fields: [{ name: 'zip', type: 'STRING' }, { name: 'lines', type: 'STRING', mode: 'REPEATED' }] },
        ],
      },
    });
    fake.addDataset('other', { t: { schema: [{ name: 'x', type: 'STRING' }] } });
    const tree = await driver().introspect(params(), { database: 'sales' });
    expect(tree.databases.find((d) => d.name === 'sales')!.tables[0]!.columns).toEqual([
      { name: 'id', type: 'INT64', nullable: false },
      { name: 'tags', type: 'ARRAY<STRING>', nullable: true },
      { name: 'addr', type: 'STRUCT<zip STRING, lines ARRAY<STRING>>', nullable: true },
    ]);
    expect(tree.databases.find((d) => d.name === 'other')!.tables[0]!.columns).toEqual([]);
    expect(fake.requestsTo('/datasets/other/tables/')).toHaveLength(0);
  });

  it('a dataset it cannot list comes back empty and partial; none at all is an error', async () => {
    fake.datasets.clear();
    fake.addDataset('ok', { t: {} });
    fake.addDataset('secret', { t: {} });
    fake.failPath = { includes: '/datasets/secret/tables', error: { status: 403, reason: 'accessDenied', message: 'denied' } };
    const tree = await driver().introspect(params());
    expect(tree.databases.find((d) => d.name === 'secret')).toMatchObject({ tables: [], partial: true });
    fake.failPath = { includes: '/tables', error: { status: 403, reason: 'accessDenied', message: 'denied' } };
    await expect(driver().introspect(params())).rejects.toBeInstanceOf(DriverError);
  });

  it('test(): token, datasets.list with maxResults 1 and a dry run of SELECT 1', async () => {
    const result = await driver().test(params());
    expect(result.serverVersion).toBe('BigQuery');
    expect(fake.requestsTo('/datasets', 'GET')[0]!.query.maxResults).toBe('1');
    expect(fake.dryRuns[0]!.body).toMatchObject({ query: 'SELECT 1', dryRun: true });
    expect(fake.realQueries).toHaveLength(0);
  });

  it('test(): a missing permission to create jobs is an error with the role hint', async () => {
    fake.dryRunError = () => ({ status: 403, reason: 'accessDenied', message: 'User does not have bigquery.jobs.create permission' });
    await expect(driver().test(params())).rejects.toThrow(/roles\/bigquery\.jobUser/);
  });

  it('refuses a project that is not a project id before it reaches a URL', async () => {
    await expect(driver().test(params({ project: '../../x' }))).rejects.toThrow(/id válido/);
    expect(fake.requests).toHaveLength(0);
  });

  it('applyMode takes only read-only', async () => {
    const session = await driver().open(params());
    await session.applyMode('read-only');
    await expect(session.applyMode('transaction')).rejects.toBeInstanceOf(DriverError);
    await expect(session.applyMode('autocommit')).rejects.toBeInstanceOf(DriverError);
    await session.close();
  });

  it('applyLimits sets jobTimeoutMs on the job', async () => {
    const session = await driver().open(params({ origin: 'agent' }));
    await session.applyLimits?.({ maxExecutionMs: 30_000 });
    await session.execute('SELECT 1', { maxRows: 10 });
    expect(fake.realQueries[0]!.body).toMatchObject({ jobTimeoutMs: '30000', labels: { cais: 'agent' } });
    await session.close();
  });

  it('the tokens never reach an error message', async () => {
    fake.validTokens = new Set(['x']);
    const session = await driver().open(params({ accessToken: 'ya29.SECRETSECRETSECRET' }));
    const r = await session.execute('SELECT 1', { maxRows: 10 });
    expect(JSON.stringify(r)).not.toContain('ya29.SECRETSECRETSECRET');
    await session.close();
  });
});

describe('a saved and signed BigQuery environment runs a SELECT through the SessionManager', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cais-bq-e2e-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('catalog → seal → credential → token → driver → fake server', async () => {
    const vault = new FakeVault();
    const seal = new Seal(dir, vault);
    await seal.load();
    const store = new CatalogStore(dir, vault, seal);
    await store.load();
    const project = await store.saveProject({ name: 'data' });
    const cred = await store.saveCredential({ name: 'maria', kind: 'gcloud-iam', account: 'maria@empresa.com', dbUsername: 'maria' });
    const saved = (await store.saveEnvironment({
      projectId: project.id, name: 'dev', engine: 'bigquery', gcpProject: 'my-project-1', maxBytesBilled: 5 * GIB, credentialId: cred.id, production: false,
    })) as BigqueryEnvironment;
    expect(seal.envMac(saved.id)).toBeDefined();
    const sources: CredentialSources = {
      getPassword: () => undefined,
      getToken: async () => {
        throw new Error('the login token is for Cloud SQL, never for BigQuery');
      },
      getAccessToken: async () => 'test-token',
    };
    const driver = createBigqueryDriver({ baseUrl: fake.url });
    const m = new SessionManager({
      getEnvironment: (id) => store.getEnvironment(id) as Environment,
      resolveConnectParams: async (e) => {
        store.requireTrusted(e.id);
        return connectParamsFor(e, e.defaultDatabase, { getCredential: (id) => store.getCredential(id), sources, origin: 'person' });
      },
      getDriver: () => driver,
      getDialect,
      emit: () => undefined,
      now: () => Date.now(),
    });
    await m.open('t', saved.id);
    const { results } = await m.run('t', { sql: 'SELECT 1', scope: 'current', cursor: 0, maxRows: 10 } as never);
    expect(results[0]!.error).toBeUndefined();
    expect(results[0]!.rows).toEqual([['1', 'a'], ['2', null]]);
    expect(fake.realQueries[0]!.body.maximumBytesBilled).toBe(String(5 * GIB));
    await m.closeAll();
  });
});
