import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import type { BigqueryEnvironment } from '@shared/model';
import { AgentBroker } from '@main/agents/broker';
import { AgentSessions } from '@main/agents/sessions';
import { createBigqueryDriver } from '@main/drivers/bigquery';
import type { BigqueryConnectParams } from '@main/drivers/types';
import { FakeBigquery } from '../support/bigquery-fake';
import { FakeClock, projects } from '../support/agent-fakes';

const fake = new FakeBigquery();
let clock: FakeClock;
let sessions: AgentSessions;
let broker: AgentBroker;
let audit: any[];
let writesReachedDriver: string[];

const dev: BigqueryEnvironment = {
  id: 'e-bq', projectId: 'p-api', name: 'bq', engine: 'bigquery', gcpProject: 'my-secret-project-1', defaultDatabase: 'sales', credentialId: 'cred-secret-id', production: false,
};
const pro: BigqueryEnvironment = { ...dev, id: 'e-bq-pro', name: 'bqpro', production: true };
const q = (p: Parameters<AgentBroker['query']>[0]) => broker.query(p) as Promise<any>;

beforeAll(async () => {
  await fake.start();
});
afterAll(async () => {
  await sessions.closeAll();
  await fake.stop();
});

beforeEach(() => {
  fake.reset();
  fake.datasets.clear();
  fake.addDataset('sales', { orders: { schema: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }, { name: 'email', type: 'STRING' }] } });
  fake.addDataset('other', { t: {} });
  fake.resultFor = () => ({ schema: [{ name: 'id', type: 'INTEGER' }], rows: [['1'], ['2']] });
  fake.dryRunError = () => undefined;
  fake.runError = () => undefined;
  fake.validTokens = new Set(['test-token']);
  fake.statementType = (sql) => (/^\s*\(*\s*(SELECT|WITH|FROM)\b/i.test(sql) ? 'SELECT' : sql.trim().split(/\s+/)[0]!.toUpperCase());
  clock = new FakeClock();
  audit = [];
  writesReachedDriver = [];
  const real = createBigqueryDriver({ baseUrl: fake.url });
  // a driver that notes whatever is not read-only, to prove no write path of an agent gets to it
  const driver = {
    ...real,
    open: async (params: BigqueryConnectParams) => {
      const session = await real.open(params);
      const applyMode = session.applyMode.bind(session);
      session.applyMode = async (mode, opts) => {
        if (mode !== 'read-only') writesReachedDriver.push(mode);
        return applyMode(mode, opts);
      };
      return session;
    },
  };
  sessions = new AgentSessions({
    getDriver: () => driver as never,
    resolveConnectParams: async (e): Promise<BigqueryConnectParams> => ({
      engine: 'bigquery',
      project: (e as BigqueryEnvironment).gcpProject,
      accessToken: 'test-token',
      refresh: async () => 'test-token',
      ...(e.defaultDatabase ? { defaultDataset: e.defaultDatabase } : {}),
      origin: 'agent',
    }),
    scheduler: clock,
  });
  let seq = 0;
  broker = new AgentBroker({
    now: () => clock.now,
    scheduler: clock,
    newId: () => `req_${++seq}`,
    catalog: { projects: () => projects, environments: () => [dev, pro] },
    scripts: { list: () => [], get: () => undefined, save: async () => { throw new Error('unused'); } },
    executor: sessions,
    audit: { append: (e) => void audit.push(e) },
    getDialect,
    onChange: () => undefined,
    onNewPending: () => undefined,
    onScriptsChanged: () => undefined,
  });
  broker.setEnabled(true);
});

describe('agents on BigQuery (read only)', () => {
  it('envs says the engine and the default dataset, and never the project', () => {
    const out = broker.envs();
    const env = out.environments.find((e) => e.name === 'bq')!;
    expect(env).toMatchObject({ engine: 'bigquery', default_database: 'sales' });
    expect(JSON.stringify(out)).not.toContain('my-secret-project-1');
    expect(JSON.stringify(out)).not.toContain('cred-secret-id');
  });

  it('a read query runs, with the agent label and the 30 s job limit', async () => {
    const res = await q({ env: 'api/bq', sql: 'SELECT id FROM orders' });
    expect(res.status).toBe('succeeded');
    expect(res.results[0].rows).toEqual([['1'], ['2']]);
    const body = fake.realQueries[0]!.body;
    expect(body.labels).toEqual({ cais: 'agent' });
    expect(body.jobTimeoutMs).toBe('30000');
    expect(body.defaultDataset).toEqual({ projectId: 'my-secret-project-1', datasetId: 'sales' });
  });

  it('--database is a dataset: it is checked and becomes the default of that request', async () => {
    const res = await q({ env: 'api/bq', sql: 'SELECT id FROM t', database: 'other' });
    expect(res.status).toBe('succeeded');
    expect(fake.requestsTo('/datasets/other', 'GET')).toHaveLength(1);
    expect(fake.realQueries.at(-1)!.body.defaultDataset.datasetId).toBe('other');
  });

  it('a dataset that is not there fails the request, without the project in the message', async () => {
    const res = await q({ env: 'api/bq', sql: 'SELECT 1', database: 'nope' });
    expect(res.status).toBe('failed');
    expect(JSON.stringify(res)).not.toContain('my-secret-project-1');
    expect(fake.realQueries).toHaveLength(0);
  });

  it('--write is refused with engine_read_only, exit 2, and nothing reaches the driver', async () => {
    for (const sql of ['DELETE FROM orders WHERE id = 1', 'SELECT 1', 'UPDATE orders SET email = NULL WHERE true']) {
      await expect(q({ env: 'api/bq', sql, write: true, reason: 'teste' })).rejects.toMatchObject({ name: 'AgentError', code: 'engine_read_only' });
    }
    await expect(q({ env: 'api/bqpro', sql: 'DELETE FROM orders WHERE true', write: true, reason: 'teste' })).rejects.toMatchObject({ code: 'engine_read_only' });
    expect(fake.requests).toHaveLength(0);
    expect(writesReachedDriver).toEqual([]);
    expect(audit.filter((a) => a.state === 'refused' && a.errorCode === 'engine_read_only')).toHaveLength(4);
  });

  it('the executor itself refuses a write session on BigQuery', async () => {
    await expect(sessions.runWrite(dev, { statements: [{ text: 'DELETE FROM orders WHERE true' }], maxRows: 10 })).rejects.toMatchObject({ code: 'engine_read_only' });
    expect(fake.requests).toHaveLength(0);
  });

  it('DML as a read is refused by the policy, and a server that reads another type stops it too', async () => {
    await expect(q({ env: 'api/bq', sql: 'DELETE FROM orders WHERE id = 1', reason: 'x' })).rejects.toMatchObject({ name: 'AgentError' });
    expect(fake.requests).toHaveLength(0);
    fake.statementType = () => 'DELETE';
    const res = await q({ env: 'api/bq', sql: 'SELECT 1' });
    expect(res.status).toBe('failed');
    expect(fake.realQueries).toHaveLength(0);
  });

  it('errors that reach the agent carry neither the project nor an account e-mail', async () => {
    fake.runError = () => ({
      status: 403,
      reason: 'accessDenied',
      message: 'Access Denied: Project my-secret-project-1: User maria@empresa.com does not have bigquery.jobs.create permission in project my-secret-project-1.',
    });
    const res = await q({ env: 'api/bq', sql: 'SELECT 1' });
    expect(res.status).toBe('failed');
    const text = JSON.stringify(res);
    expect(text).not.toContain('my-secret-project-1');
    expect(text).not.toContain('maria@empresa.com');
    expect(text).toContain('roles/bigquery.jobUser');
  });

  it('schema: datasets and tables, and with --database the columns', async () => {
    const list = (await broker.schema({ env: 'api/bq' })) as any;
    expect(list.databases.map((d: { name: string }) => d.name)).toEqual(['other', 'sales']);
    expect(list.databases.find((d: any) => d.name === 'sales').tables).toEqual([{ name: 'orders', type: 'table' }]);
    const cols = (await broker.schema({ env: 'api/bq', database: 'sales' })) as any;
    expect(cols.databases[0].tables[0].columns).toEqual([
      { name: 'id', type: 'INT64', nullable: false },
      { name: 'email', type: 'STRING', nullable: true },
    ]);
    expect(fake.requestsTo('/datasets/other/tables/')).toHaveLength(0);
    expect(JSON.stringify(cols)).not.toContain('my-secret-project-1');
  });

  it('the server text of an error (it can quote row values) does not reach the agent unless the result is shared', async () => {
    fake.runError = () => ({ status: 400, reason: 'invalidQuery', message: 'Bad int64 value: segredo-da-linha' });
    const res = await q({ env: 'api/bqpro', sql: 'SELECT CAST(email AS INT64) FROM orders', reason: 'conferir' });
    broker.approve(res.request_id, { shareResult: false });
    const out = (await broker.status({ id: res.request_id, wait: true, timeoutS: 10 })) as any;
    expect(out.status).toBe('failed');
    expect(out.error.code).toBe('invalidQuery');
    expect(JSON.stringify(out)).not.toContain('segredo-da-linha');

    const shared = await q({ env: 'api/bqpro', sql: 'SELECT CAST(email AS INT64) FROM orders', reason: 'conferir' });
    broker.approve(shared.request_id, { shareResult: true });
    const full = (await broker.status({ id: shared.request_id, wait: true, timeoutS: 10 })) as any;
    expect(JSON.stringify(full)).toContain('segredo-da-linha');
  });

  it('schema --table without --database brings the columns of the datasets that have the table', async () => {
    const out = (await broker.schema({ env: 'api/bq', table: 'orders' })) as any;
    expect(out.databases).toEqual([
      { name: 'sales', tables: [{ name: 'orders', type: 'table', columns: [
        { name: 'id', type: 'INT64', nullable: false },
        { name: 'email', type: 'STRING', nullable: true },
      ] }] },
    ]);
    // only the dataset that has the table was read for columns
    expect(fake.requestsTo('/datasets/other/tables/')).toHaveLength(0);
  });

  it('schema --database takes only a valid name, and an unknown dataset opens no read of its own', async () => {
    await expect(broker.schema({ env: 'api/bq', database: 'a;b' })).rejects.toMatchObject({ code: 'invalid_database' });
    await expect(broker.schema({ env: 'api/bq', database: 'x'.repeat(2000) })).rejects.toMatchObject({ code: 'invalid_database' });
    await broker.schema({ env: 'api/bq' });
    const lists = fake.requestsTo('/datasets', 'GET').filter((r) => r.path.endsWith('/datasets')).length;
    for (let i = 0; i < 5; i++) {
      await expect(broker.schema({ env: 'api/bq', database: `nope_${i}` })).rejects.toMatchObject({ code: 'not_found' });
    }
    // the listing was read once and shared (cached): no new dataset listing per invented name
    expect(fake.requestsTo('/datasets', 'GET').filter((r) => r.path.endsWith('/datasets')).length).toBe(lists);
  });

  it('a read in production waits for the click, then runs', async () => {
    const res = await q({ env: 'api/bqpro', sql: 'SELECT 1', reason: 'conferir' });
    expect(res.status).toBe('pending_approval');
    expect(fake.requests).toHaveLength(0);
    broker.approve(res.request_id, { shareResult: true });
    await broker.waitForStatus(res.request_id, (s) => s === 'succeeded', 10_000);
    expect(fake.realQueries).toHaveLength(1);
  });
});
