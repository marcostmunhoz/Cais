// Agents on BigQuery against the fake server: the dry run before every decision, what waits for the person, what is
// refused, the ceiling that reaches the server, redaction and the output. Needs no Docker.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import { GIB } from '@shared/engines';
import type { BigqueryEnvironment } from '@shared/model';
import { AgentBroker } from '@main/agents/broker';
import type { AuditEntry } from '@main/agents/audit';
import { AgentSessions } from '@main/agents/sessions';
import { createBigqueryDriver } from '@main/drivers/bigquery';
import type { BigqueryConnectParams } from '@main/drivers/types';
import { FakeBigquery } from '../support/bigquery-fake';
import { FakeClock, projects } from '../support/agent-fakes';

const fake = new FakeBigquery();
let clock: FakeClock;
let sessions: AgentSessions;
let broker: AgentBroker;
let audit: AuditEntry[];
let envs: BigqueryEnvironment[];

const base: BigqueryEnvironment = {
  id: 'e-bq', projectId: 'p-api', name: 'bq', engine: 'bigquery', gcpProject: 'my-secret-project-1', defaultDatabase: 'sales',
  credentialId: 'cred-secret-id', production: false, maxBytesBilled: 100 * GIB,
};
const q = (p: Parameters<AgentBroker['query']>[0]) => broker.query(p) as Promise<any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  fake.addDataset('sales', { orders: { schema: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] } });
  fake.routinesFor = () => [];
  fake.resultFor = () => ({ schema: [{ name: 'id', type: 'INTEGER' }], rows: [['1'], ['2']] });
  fake.dryRunError = () => undefined;
  fake.runError = () => undefined;
  fake.bytesFor = () => 1024;
  fake.validTokens = new Set(['test-token']);
  fake.statementType = (sql) => (/^\s*\(*\s*(SELECT|WITH|FROM)\b/i.test(sql) ? 'SELECT' : sql.trim().split(/\s+/)[0]!.toUpperCase());
  clock = new FakeClock();
  audit = [];
  envs = [
    { ...base },
    { ...base, id: 'e-nolimit', name: 'nolimit' },
    { ...base, id: 'e-low', name: 'low', maxBytesBilled: 2 * GIB },
    { ...base, id: 'e-pro', name: 'pro', production: true },
  ];
  delete (envs[1] as { maxBytesBilled?: number }).maxBytesBilled;
  sessions = new AgentSessions({
    getDriver: () => createBigqueryDriver({ baseUrl: fake.url }) as never,
    resolveConnectParams: async (e): Promise<BigqueryConnectParams> => ({
      engine: 'bigquery',
      project: (e as BigqueryEnvironment).gcpProject,
      accessToken: 'test-token',
      refresh: async () => 'test-token',
      ...((e as BigqueryEnvironment).maxBytesBilled !== undefined ? { maxBytesBilled: (e as BigqueryEnvironment).maxBytesBilled! } : {}),
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
    catalog: { projects: () => projects, environments: () => envs.map((e) => ({ ...e })) },
    scripts: { list: () => [], get: () => undefined, save: async () => { throw new Error('unused'); } },
    executor: sessions,
    audit: { append: (e) => void audit.push(e as AuditEntry) },
    getDialect,
    onChange: () => undefined,
    onNewPending: () => undefined,
    onScriptsChanged: () => undefined,
  });
  broker.setEnabled(true);
});

const approveAndWait = async (id: string, shareResult = true) => {
  broker.approve(id, { shareResult });
  return (await broker.status({ id, wait: true, timeoutS: 10 })) as any;
};

describe('the dry run decides first', () => {
  it('a server that reads another type than the classifier is refused before anything runs, and the trail says so', async () => {
    fake.statementType = () => 'SCRIPT';
    await expect(q({ env: 'api/bq', sql: 'SELECT 1' })).rejects.toMatchObject({ name: 'AgentError', code: 'writes_in_read' });
    expect(fake.realQueries).toHaveLength(0);
    expect(fake.dryRuns).toHaveLength(1);
    expect(audit.some((a) => a.state === 'refused' && a.errorCode === 'writes_in_read')).toBe(true);
    // a server that gives no type is no answer either
    fake.statementType = () => '';
    await expect(q({ env: 'api/bq', sql: 'SELECT 2' })).rejects.toMatchObject({ code: 'writes_in_read' });
    expect(fake.realQueries).toHaveLength(0);
  });

  it('one dry run per command, each with its own estimate; none for a refused text', async () => {
    await q({ env: 'api/bq', sql: 'SELECT 1; SELECT 2' });
    // the broker's own dry runs come first, one per command; the driver repeats each one right before its job
    const texts = fake.dryRuns.map((d) => d.body.configuration.query.query);
    expect(texts.slice(0, 2)).toEqual(['SELECT 1', 'SELECT 2']);
    expect(new Set(texts)).toEqual(new Set(['SELECT 1', 'SELECT 2']));
    const before = fake.requests.length;
    await expect(q({ env: 'api/bq', sql: 'DELETE FROM orders WHERE true' })).rejects.toMatchObject({ code: 'writes_in_read' });
    await expect(q({ env: 'api/bq', sql: '#legacySQL\nSELECT 1' })).rejects.toBeTruthy();
    expect(fake.requests.length).toBe(before);
  });

  it('a dry run that fails (a table that is not there) lets the run report the error', async () => {
    fake.dryRunError = () => ({ status: 404, reason: 'notFound', message: 'Not found: Table my-secret-project-1:sales.nope' });
    const res = await q({ env: 'api/bq', sql: 'SELECT * FROM nope' });
    expect(res.status).toBe('failed');
    expect(JSON.stringify(res)).not.toContain('my-secret-project-1');
    expect(fake.realQueries).toHaveLength(0);
  });
});

describe('refusals for agents', () => {
  it('text hidden from the person: invisible characters and triple-quoted strings', async () => {
    await expect(q({ env: 'api/bq', sql: 'SELECT 1​' })).rejects.toMatchObject({ code: 'hidden_text' });
    await expect(q({ env: 'api/bq', sql: "SELECT '''a''' AS x" })).rejects.toMatchObject({ code: 'ambiguous_text' });
    await expect(q({ env: 'api/bq', sql: 'SELECT """a""" AS x' })).rejects.toMatchObject({ code: 'ambiguous_text' });
    expect(fake.requests).toHaveLength(0);
  });

  it('#legacySQL and #standardSQL are refused: the person would review one language and the server run another', async () => {
    for (const sql of ['#legacySQL\nSELECT 1', '-- x\n#standardSQL\nSELECT 1', 'SELECT 1 # legacySQL']) {
      const e = await q({ env: 'api/bq', sql }).catch((x: any) => x);
      // the dialect's text check meets it first (ambiguous_text); the policy has executable_comment behind it
      expect(['ambiguous_text', 'executable_comment'], sql).toContain(e.code);
      expect(e.message).toMatch(/legacySQL/i);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('EXTERNAL_QUERY is function_not_allowed, whatever the spelling', async () => {
    for (const sql of [
      "SELECT * FROM EXTERNAL_QUERY('c', 'select 1')",
      "SELECT * FROM `external_query`('c', 'select 1')",
      "SELECT * FROM external_query ('c', 'select 1')",
    ]) {
      await expect(q({ env: 'api/bq', sql }), sql).rejects.toMatchObject({ code: 'function_not_allowed' });
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('INFORMATION_SCHEMA.JOBS* and SESSIONS* are system_schema, in any spelling; the other views are not', async () => {
    for (const sql of [
      'SELECT query FROM region-us.INFORMATION_SCHEMA.JOBS',
      'SELECT query FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT',
      'SELECT query FROM `proj.region-eu.INFORMATION_SCHEMA.JOBS_BY_USER`',
      'SELECT * FROM region-us.INFORMATION_SCHEMA.SESSIONS_BY_PROJECT',
    ]) {
      const e = await q({ env: 'api/bq', sql }).catch((x: any) => x);
      expect(e.code, sql).toBe('system_schema');
      expect(e.message).toContain('JOBS');
    }
    expect(fake.requests).toHaveLength(0);
    const ok = await q({ env: 'api/bq', sql: 'SELECT table_name FROM sales.INFORMATION_SCHEMA.TABLES' });
    expect(ok.status).toBe('succeeded');
  });

  it('--write is engine_read_only and the connection never opens', async () => {
    await expect(q({ env: 'api/bq', sql: 'SELECT 1', write: true, reason: 'x' })).rejects.toMatchObject({ code: 'engine_read_only' });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('what waits for the person whatever the level says', () => {
  it('a function defined in the project (it may be remote) waits, with the reason, and needs --reason', async () => {
    await expect(q({ env: 'api/bq', sql: 'SELECT sales.my_remote_fn(id) FROM orders' })).rejects.toMatchObject({ code: 'reason_required' });
    const res = await q({ env: 'api/bq', sql: 'SELECT sales.my_remote_fn(id) FROM orders', reason: 'conferir' });
    expect(res.status).toBe('pending_approval');
    expect(res.approval_reason).toContain('SALES.MY_REMOTE_FN');
    expect(res.approval_reason).toContain('função remota');
    expect(fake.realQueries).toHaveLength(0);
    const done = await approveAndWait(res.request_id);
    expect(done.status).toBe('succeeded');
    expect(done.decided_by).toBe('person');
  });

  it('ML.GENERATE_TEXT and AI.* wait, saying the cost is outside the bytes read', async () => {
    for (const sql of [
      'SELECT * FROM ML.GENERATE_TEXT(MODEL `sales.m`, TABLE orders)',
      "SELECT AI.GENERATE('oi') AS t",
      'SELECT SAFE.ML.PREDICT(1)',
    ]) {
      const res = await q({ env: 'api/bq', sql, reason: 'testar' });
      expect(res.status, sql).toBe('pending_approval');
      expect(res.approval_reason, sql).toContain('IA generativa');
    }
    expect(fake.realQueries).toHaveLength(0);
  });

  it('an unqualified function that is not native waits; a native one does not', async () => {
    const udf = await q({ env: 'api/bq', sql: 'SELECT my_udf(id) FROM orders', reason: 'testar' });
    expect(udf.status).toBe('pending_approval');
    expect(udf.approval_reason).toContain('MY_UDF');
    for (const sql of ['SELECT COUNT(*), SUM(id), IFNULL(id, 0), SAFE_DIVIDE(1, 2) FROM orders', 'SELECT ARRAY_LENGTH([1,2]), ST_X(ST_GEOGPOINT(1, 2))', 'SELECT NET.HOST("a.com")']) {
      const ok = await q({ env: 'api/bq', sql });
      expect(ok.status, sql).toBe('succeeded');
    }
  });

  it('a 15-minute grant does not cover a function that runs outside the engine', async () => {
    const first = await q({ env: 'api/pro', sql: 'SELECT 1', reason: 'abrir' });
    broker.approve(first.request_id, { shareResult: true, grantReads: true });
    await broker.status({ id: first.request_id, wait: true, timeoutS: 10 });
    const covered = await q({ env: 'api/pro', sql: 'SELECT 2' });
    expect(covered.status).toBe('succeeded');
    const remote = await q({ env: 'api/pro', sql: 'SELECT sales.f(1)', reason: 'chamar' });
    expect(remote.status).toBe('pending_approval');
  });
});

describe('routines found by the dry run', () => {
  const viaView = (sql: string) => (sql.includes('ds.v') ? [{ datasetId: 'ds', routineId: 'remote_fn' }] : []);

  it('a plain SELECT whose dry run reports a routine waits even with a grant, names it, and leaks no project', async () => {
    fake.routinesFor = viaView;
    const first = await q({ env: 'api/pro', sql: 'SELECT 1', reason: 'abrir' });
    broker.approve(first.request_id, { shareResult: true, grantReads: true });
    await broker.status({ id: first.request_id, wait: true, timeoutS: 10 });
    expect((await q({ env: 'api/pro', sql: 'SELECT 2' })).status).toBe('succeeded');
    const realBefore = fake.realQueries.length;
    const res = await q({ env: 'api/pro', sql: 'SELECT * FROM ds.v', reason: 'ver a view' });
    expect(res.status).toBe('pending_approval');
    expect(res.approval_reason).toContain('ds.remote_fn');
    expect(fake.realQueries).toHaveLength(realBefore);
    const done = await approveAndWait(res.request_id);
    expect(done.status).toBe('succeeded');
    for (const text of [JSON.stringify(res), JSON.stringify(done), JSON.stringify(audit), JSON.stringify(broker.snapshot())]) {
      expect(text).not.toContain('my-secret-project-1');
    }
  });

  it('waits at the free-reads level too, and the same SELECT with no routines runs freely', async () => {
    fake.routinesFor = viaView;
    const waits = await q({ env: 'api/bq', sql: 'SELECT * FROM ds.v', reason: 'ver a view' });
    expect(waits.status).toBe('pending_approval');
    expect(waits.approval_reason).toContain('ds.remote_fn');
    fake.routinesFor = () => [];
    const free = await q({ env: 'api/bq', sql: 'SELECT * FROM ds.v' });
    expect(free.status).toBe('succeeded');
  });
});

describe('routines found only by the run itself', () => {
  it('a first dry run that failed does not let a routine through: the run refuses it and nothing is billed', async () => {
    let calls = 0;
    fake.dryRunError = () => (++calls === 1 ? { status: 403, reason: 'accessDenied', message: 'denied' } : undefined);
    fake.routinesFor = () => [{ datasetId: 'ds', routineId: 'remote_fn' }];
    const res = await q({ env: 'api/bq', sql: 'SELECT * FROM ds.v', reason: 'ver a view' });
    expect(res.status).not.toBe('succeeded');
    expect(fake.realQueries).toHaveLength(0);
    expect(JSON.stringify(res)).toContain('routine_not_approved');
  });
});

describe('big reads', () => {
  const MAX = String(10 * GIB);

  it('below 10 GiB it runs at once, with maximumBytesBilled of 10 GiB', async () => {
    fake.bytesFor = () => 9 * GIB;
    const res = await q({ env: 'api/bq', sql: 'SELECT id FROM orders' });
    expect(res.status).toBe('succeeded');
    expect(fake.realQueries[0]!.body.maximumBytesBilled).toBe(MAX);
  });

  it('above 10 GiB it waits, even in Leitura liberada, and the reason has the estimate', async () => {
    fake.bytesFor = () => 12 * GIB + 1;
    await expect(q({ env: 'api/bq', sql: 'SELECT id FROM orders' })).rejects.toMatchObject({ code: 'reason_required' });
    const res = await q({ env: 'api/bq', sql: 'SELECT id FROM orders', reason: 'preciso do total' });
    expect(res.status).toBe('pending_approval');
    expect(res.approval_reason).toContain('12 GiB');
    expect(fake.realQueries).toHaveLength(0);
    const view = broker.snapshot().pending[0]!;
    expect(view.statements[0]!.bytesEstimated).toBe(12 * GIB + 1);
    expect(view.approvalReason).toContain('GiB');
  });

  it('the approved job runs with the estimate rounded up to the GiB as its ceiling (never less than 10 GiB)', async () => {
    fake.bytesFor = () => 12 * GIB + 1;
    const res = await q({ env: 'api/bq', sql: 'SELECT id FROM orders', reason: 'total' });
    const done = await approveAndWait(res.request_id);
    expect(done.status).toBe('succeeded');
    expect(fake.realQueries[0]!.body.maximumBytesBilled).toBe(String(13 * GIB));
    expect(done.results[0].bytes_estimated).toBe(12 * GIB + 1);
  });

  it('in an environment with no limit it still waits above 10 GiB', async () => {
    fake.bytesFor = () => 20 * GIB;
    const res = await q({ env: 'api/nolimit', sql: 'SELECT id FROM orders', reason: 'total' });
    expect(res.status).toBe('pending_approval');
    const done = await approveAndWait(res.request_id);
    expect(done.status).toBe('succeeded');
    expect(fake.realQueries[0]!.body.maximumBytesBilled).toBe(String(20 * GIB));
  });

  it('above the environment limit (lower than 10 GiB) it waits, saying so; below it runs', async () => {
    fake.bytesFor = () => GIB;
    expect((await q({ env: 'api/low', sql: 'SELECT id FROM orders' })).status).toBe('succeeded');
    fake.bytesFor = () => 3 * GIB;
    const res = await q({ env: 'api/low', sql: 'SELECT id FROM orders', reason: 'total' });
    expect(res.status).toBe('pending_approval');
    expect(res.approval_reason).toContain('limite');
    const done = await approveAndWait(res.request_id);
    expect(done.status).toBe('succeeded');
    // approved over the limit: the ceiling is the approved estimate, rounded up to the GiB
    expect(fake.realQueries.at(-1)!.body.maximumBytesBilled).toBe(String(3 * GIB));
  });

  it('above a limit that is higher than 10 GiB the reason is the environment limit', async () => {
    fake.bytesFor = () => 150 * GIB;
    const res = await q({ env: 'api/bq', sql: 'SELECT id FROM orders', reason: 'total' });
    expect(res.approval_reason).toContain('limite');
  });

  it('a 15-minute grant does not cover a big read, and covers the small ones', async () => {
    const first = await q({ env: 'api/pro', sql: 'SELECT 1', reason: 'abrir' });
    broker.approve(first.request_id, { shareResult: true, grantReads: true });
    await broker.status({ id: first.request_id, wait: true, timeoutS: 10 });
    expect((await q({ env: 'api/pro', sql: 'SELECT 2' })).status).toBe('succeeded');
    fake.bytesFor = () => 11 * GIB;
    const big = await q({ env: 'api/pro', sql: 'SELECT 3', reason: 'grande' });
    expect(big.status).toBe('pending_approval');
    expect(big.approval_reason).toContain('GiB');
  });

  it('one big command among several: the request waits and each command has its ceiling', async () => {
    fake.bytesFor = (sql) => (sql.includes('big') ? 15 * GIB : 1024);
    const res = await q({ env: 'api/bq', sql: 'SELECT 1; SELECT 2 AS big', reason: 'dois' });
    expect(res.status).toBe('pending_approval');
    const view = broker.snapshot().pending[0]!;
    expect(view.statements.map((s) => s.bytesEstimated)).toEqual([1024, 15 * GIB]);
    await approveAndWait(res.request_id);
    expect(fake.realQueries.map((r) => r.body.maximumBytesBilled)).toEqual([MAX, String(15 * GIB)]);
  });

  it('an estimate that grew after the approval does not run: bytes_over_approved, no job', async () => {
    fake.bytesFor = () => 12 * GIB;
    const res = await q({ env: 'api/bq', sql: 'SELECT id FROM orders', reason: 'total' });
    fake.bytesFor = () => 40 * GIB;
    const done = await approveAndWait(res.request_id);
    expect(done.status).toBe('failed');
    expect(done.error.code).toBe('bytes_over_approved');
    expect(done.error.message).toContain('Peça de novo');
    expect(fake.realQueries).toHaveLength(0);
    expect(done.results[0].error.code).toBe('bytes_over_approved');
  });

  it('a free read that grows past the environment limit (but under 10 GiB) between the dry runs does not run', async () => {
    let calls = 0;
    fake.bytesFor = () => (++calls === 1 ? GIB : 8 * GIB);
    const res = await q({ env: 'api/low', sql: 'SELECT id FROM orders' });
    expect(res.status).toBe('failed');
    expect(res.error.code).toBe('bytes_over_approved');
    expect(fake.realQueries).toHaveLength(0);
  });

  it('a free read whose estimate crosses 10 GiB between the dry run and the run does not run either', async () => {
    let calls = 0;
    fake.bytesFor = () => (++calls === 1 ? 5 * GIB : 30 * GIB);
    const res = await q({ env: 'api/bq', sql: 'SELECT id FROM orders' });
    expect(res.status).toBe('failed');
    expect(res.error.code).toBe('bytes_over_approved');
    expect(fake.realQueries).toHaveLength(0);
  });

  it('the server itself refuses a job that would bill more than the ceiling (nothing is billed)', async () => {
    // the dry runs say 5 GiB, the job would need more: bytesBilledLimitExceeded reaches the agent without the project
    fake.bytesFor = (sql) => (sql.includes('/*run*/') ? 50 * GIB : 5 * GIB);
    fake.runError = () => ({ status: 400, reason: 'bytesBilledLimitExceeded', message: 'Query exceeded limit for bytes billed: 10737418240 in my-secret-project-1' });
    const res = await q({ env: 'api/bq', sql: 'SELECT id FROM orders' });
    expect(res.status).toBe('failed');
    expect(res.error.code).toBe('bytesBilledLimitExceeded');
    expect(JSON.stringify(res)).not.toContain('my-secret-project-1');
  });
});

describe('limits', () => {
  it('the job runs with the 30 s job timeout and the agent label', async () => {
    await q({ env: 'api/bq', sql: 'SELECT 1' });
    const body = fake.realQueries[0]!.body;
    expect(body.jobTimeoutMs).toBe('30000');
    expect(body.labels).toEqual({ cais: 'agent' });
  });

  it('a job that does not end is cut at 35 s by jobs.cancel, and the agent sees agent_timeout', async () => {
    const pending = q({ env: 'api/bq', sql: 'SELECT SLOW' });
    for (let i = 0; i < 100 && fake.realQueries.length === 0; i++) await sleep(20);
    expect(fake.realQueries).toHaveLength(1);
    await clock.advance(35_000);
    const res = await pending;
    expect(res.status).toBe('failed');
    expect(res.error.code).toBe('agent_timeout');
    expect(fake.requestsTo('/cancel', 'POST').length).toBeGreaterThan(0);
  });
});

describe('what reaches the agent', () => {
  it('results carry the bytes processed and billed; with the result withheld, only counts', async () => {
    fake.bytesFor = () => 25 * 1024 * 1024;
    const res = await q({ env: 'api/bq', sql: 'SELECT id FROM orders' });
    expect(res.results[0]).toMatchObject({ bytes_estimated: 25 * 1024 * 1024, bytes_processed: 25 * 1024 * 1024, bytes_billed: 30 * 1024 * 1024 });
    expect(res.results[0].job_id).toBeUndefined();

    const held = await q({ env: 'api/pro', sql: 'SELECT id FROM orders', reason: 'ver' });
    const out = await approveAndWait(held.request_id, false);
    expect(out.result_withheld).toBe(true);
    expect(out.results[0].row_count).toBe(2);
    expect(JSON.stringify(out.results)).not.toContain('"rows"');
    expect(out.results[0].bytes_processed).toBeUndefined();
  });

  it('the trail lines carry the job id and the bytes, and never a row', async () => {
    fake.bytesFor = () => 3 * 1024 * 1024;
    await q({ env: 'api/bq', sql: 'SELECT id FROM orders' });
    const last = audit.filter((a) => a.state === 'succeeded').at(-1)!;
    expect(last.jobId).toMatch(/^job_/);
    expect(last.bytesEstimated).toBe(3 * 1024 * 1024);
    expect(last.bytesBilled).toBe(10 * 1024 * 1024);
    expect(last.statements![0]).toMatchObject({ jobId: last.jobId, bytesBilled: 10 * 1024 * 1024 });
    expect(JSON.stringify(last)).not.toMatch(/"rows":\[/);
  });

  it('the trail records why a big read waited, on the line written before it runs', async () => {
    fake.bytesFor = () => 14 * GIB;
    const res = await q({ env: 'api/bq', sql: 'SELECT id FROM orders', reason: 'total' });
    await approveAndWait(res.request_id);
    const running = audit.find((a) => a.state === 'running' && a.id === res.request_id)!;
    expect(running.bytesEstimated).toBe(14 * GIB);
    expect(running.detail).toContain('GiB');
  });

  it('errors reach the agent without the project and without any e-mail', async () => {
    fake.runError = () => ({
      status: 403,
      reason: 'accessDenied',
      message: 'Access Denied: Project my-secret-project-1: User maria@empresa.com and sa-1@my-secret-project-1.iam.gserviceaccount.com lack bigquery.jobs.create',
    });
    const res = await q({ env: 'api/bq', sql: 'SELECT 1' });
    const text = JSON.stringify(res);
    expect(text).not.toContain('my-secret-project-1');
    expect(text).not.toContain('maria@empresa.com');
    expect(text).not.toContain('iam.gserviceaccount.com');
    // and the same with the dry run failing
    fake.runError = () => undefined;
    fake.dryRunError = () => ({ status: 403, reason: 'accessDenied', message: 'User bob@empresa.com cannot use project my-secret-project-1' });
    const second = await q({ env: 'api/bq', sql: 'SELECT 2' });
    expect(JSON.stringify(second)).not.toMatch(/my-secret-project-1|bob@empresa\.com/);
  });

  it('envs and status never show the project or the credential', async () => {
    const res = await q({ env: 'api/bq', sql: 'SELECT 1' });
    const text = JSON.stringify([broker.envs(), await broker.status({ id: res.request_id }), broker.requests(10)]);
    expect(text).not.toContain('my-secret-project-1');
    expect(text).not.toContain('cred-secret-id');
  });
});
