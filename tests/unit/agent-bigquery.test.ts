// Agents on BigQuery, without a server: the policy on GoogleSQL, the function list, redaction, and the broker's use of the
// dry run (approvals, ceilings, output) with a fake executor. MySQL's output must not change by a byte.
import { describe, expect, it } from 'vitest';
import { AGENT_BYTES_APPROVAL } from '@shared/agents';
import { getDialect } from '@shared/dialects/registry';
import { isUnknownUnqualifiedFunction } from '@shared/dialects/bigquery/functions';
import { GIB } from '@shared/engines';
import type { BigqueryEnvironment } from '@shared/model';
import { decide, MESSAGES, type DecideInput } from '@main/agents/policy';
import { redactForAgent } from '@main/agents/redact';
import { AgentSessions } from '@main/agents/sessions';
import { FakeExecutor, makeBroker, result } from '../support/agent-fakes';

const bq = getDialect('bigquery');
const analyze = (sql: string) => bq.splitStatements(sql).map((s) => ({ text: s.text, c: bq.classify(s.text), ids: bq.identifiers(s.text) }));
const d = (sql: string, over: Partial<DecideInput> = {}) =>
  decide({ mode: 'read', production: false, statements: analyze(sql), rules: bq.agentRules, pendingCount: 0, grantActive: false, ...over });

describe('policy on GoogleSQL', () => {
  it('plain reads run, and INFORMATION_SCHEMA other than jobs is readable', () => {
    expect(d('SELECT 1')).toEqual({ action: 'run' });
    expect(d('SELECT * FROM ds.INFORMATION_SCHEMA.COLUMNS')).toEqual({ action: 'run' });
  });

  it('jobs and sessions metadata is system_schema with the dialect message', () => {
    for (const sql of ['SELECT * FROM region-us.INFORMATION_SCHEMA.JOBS', 'SELECT * FROM `proj.region-us.INFORMATION_SCHEMA.JOBS_BY_USER`', 'SELECT * FROM x.INFORMATION_SCHEMA.SESSIONS']) {
      expect(d(sql, { reason: 'x' })).toEqual({ action: 'refuse', code: 'system_schema', message: bq.agentRules.messages.jobsMetadata });
    }
    expect(bq.agentRules.messages.jobsMetadata).toMatch(/JOBS/);
  });

  it('a #legacySQL directive is executable_comment, EXTERNAL_QUERY is function_not_allowed', () => {
    // the splitter drops leading comments, so the broker's text check (ambiguous_text) meets the directive first;
    // the policy still refuses a classification that carries it
    const whole = [{ text: '#legacySQL\nSELECT 1', c: bq.classify('#legacySQL\nSELECT 1') }];
    expect(decide({ mode: 'read', production: false, statements: whole, rules: bq.agentRules, pendingCount: 0, grantActive: false })).toMatchObject({ action: 'refuse', code: 'executable_comment', message: MESSAGES.legacyDirective });
    expect(d('SELECT * FROM EXTERNAL_QUERY("c", "select 1")')).toMatchObject({ action: 'refuse', code: 'function_not_allowed' });
    expect(d('SELECT * FROM `ds`.EXTERNAL_QUERY("c", "select 1")')).toMatchObject({ action: 'refuse', code: 'function_not_allowed' });
  });

  it('DML, scripts and DDL are still refused', () => {
    expect(d('DELETE FROM t WHERE true')).toMatchObject({ code: 'writes_in_read' });
    expect(d('CREATE TEMP TABLE x AS SELECT 1')).toMatchObject({ code: 'ddl_or_transaction' });
  });

  it('forceApproval sends the read to the person at any level and under any grant, and still asks for the reason', () => {
    expect(d('SELECT 1', { forceApproval: true, grantActive: true, reason: 'x' })).toEqual({ action: 'approve' });
    expect(d('SELECT 1', { forceApproval: true, level: 'free-reads', reason: 'x' })).toEqual({ action: 'approve' });
    expect(d('SELECT 1', { forceApproval: true })).toMatchObject({ action: 'refuse', code: 'reason_required' });
    expect(d('SELECT 1', { forceApproval: true, reason: 'x', pendingCount: 20 })).toMatchObject({ action: 'refuse', code: 'queue_full' });
    // without it nothing changes
    expect(d('SELECT 1', { grantActive: true, production: true })).toEqual({ action: 'run' });
  });

  it('every refusal text is Portuguese, fixed, and has no exclamation mark', () => {
    for (const text of [MESSAGES.legacyDirective, MESSAGES.externalQuery, MESSAGES.serverNotQuery('DELETE'), MESSAGES.serverNotQuery(), bq.agentRules.messages.jobsMetadata!]) {
      expect(text).not.toContain('!');
    }
    // a type word from the server that is not a plain word is not echoed
    expect(MESSAGES.serverNotQuery('x"; DROP')).not.toContain('DROP');
  });
});

describe('what counts as a native function', () => {
  it('knows the common built-ins, in any case and under SAFE.', () => {
    for (const name of ['COUNT', 'sum', 'IFNULL', 'SAFE_DIVIDE', 'ARRAY_AGG', 'DATE_TRUNC', 'JSON_VALUE', 'ST_GEOGPOINT', 'SAFE.PARSE_DATE', 'UNNEST', 'CAST', 'EXTRACT', 'GENERATE_ARRAY']) {
      expect(isUnknownUnqualifiedFunction(name), name).toBe(false);
    }
  });
  it('knows built-ins the real server accepts without a qualifier (each checked by a dry run)', () => {
    for (const name of [
      'BIT_COUNT', 'PARSE_BIGNUMERIC', 'PARSE_NUMERIC', 'REGEXP_EXTRACT_GROUPS', 'SAFE_CONVERT_BYTES_TO_STRING', 'ST_EQUALS',
      'ST_LINEINTERPOLATEPOINT', 'TYPEOF', 'ZSTD_COMPRESS', 'ZSTD_DECOMPRESS_TO_BYTES', 'ZSTD_DECOMPRESS_TO_STRING', 'JSON_FLATTEN',
      'TEXT_ANALYZE', 'BAG_OF_WORDS', 'TF_IDF',
    ]) {
      expect(isUnknownUnqualifiedFunction(name), name).toBe(false);
    }
  });
  it('does not list names the server does not know (the real server says "Function not found")', () => {
    for (const name of ['ARRAY_FILTER', 'ST_GEOGFROMKML']) expect(isUnknownUnqualifiedFunction(name), name).toBe(true);
  });
  it('flags a name that is not a reviewed built-in', () => {
    for (const name of ['MY_UDF', 'fn', 'SAFE.MY_UDF', 'ST_MYTHING', 'DLP_DETERMINISTIC_ENCRYPT']) expect(isUnknownUnqualifiedFunction(name), name).toBe(true);
  });
  it('does not judge a qualified name (the classifier does)', () => {
    expect(isUnknownUnqualifiedFunction('NET.HOST')).toBe(false);
    expect(isUnknownUnqualifiedFunction('DS.FN')).toBe(false);
  });
  it('MySQL has no such rule', () => {
    expect(getDialect('mysql').agentRules.isUnknownFunction).toBeUndefined();
  });
});

describe('redactForAgent on BigQuery', () => {
  const t = { gcpProject: 'my-secret-project-1' };
  it('removes the project id and every e-mail, in English for agents and in the person locale with its own placeholders', () => {
    const text = 'Access Denied: Project my-secret-project-1: User maria@empresa.com cannot run in projects/my-secret-project-1/jobs';
    expect(redactForAgent(text, t)).toBe('Access Denied: Project <project>: User <account> cannot run in projects/<project>/jobs');
    expect(redactForAgent(text, t, 'pt-BR')).toBe('Access Denied: Project <projeto>: User <conta> cannot run in projects/<projeto>/jobs');
  });
  it('a service account carries the project in its domain: the whole address goes', () => {
    expect(redactForAgent('as sa-1@my-secret-project-1.iam.gserviceaccount.com failed', t)).toBe('as <account> failed');
  });
  it('a domain-scoped project goes whole and by its short name', () => {
    expect(redactForAgent('Not found: acme.com:my-proj-123 and my-proj-123', { gcpProject: 'acme.com:my-proj-123' })).toBe('Not found: <project> and <project>');
  });
  it('leaves other text alone', () => {
    expect(redactForAgent('Table sales.orders not found', t)).toBe('Table sales.orders not found');
  });
});

const bqEnv: BigqueryEnvironment = {
  id: 'e-bq', projectId: 'p-api', name: 'bq', engine: 'bigquery', gcpProject: 'my-secret-project-1', defaultDatabase: 'sales',
  credentialId: 'cred-secret-id', production: false, maxBytesBilled: 100 * GIB,
};

function bqBroker(env: Partial<BigqueryEnvironment> = {}) {
  const rig = makeBroker();
  rig.envs.push({ ...bqEnv, ...env } as never);
  const q = (p: Parameters<typeof rig.broker.query>[0]) => rig.broker.query(p) as Promise<any>;
  return { ...rig, q };
}
const select = (extra: object = {}) => ({ serverKind: 'SELECT', ...extra });
const big = (bytes: number) => result({ columns: [{ name: 'id', type: 'INT64' }], rows: [[1]], stats: { bytesEstimated: bytes, bytesProcessed: bytes, bytesBilled: bytes, jobId: 'job_1' } });

describe('the broker with a dry run', () => {
  it('asks for the dry run of every command, with the database, before deciding', async () => {
    const { q, executor } = bqBroker();
    executor.prepared = [select({ bytesEstimated: 10 }), select({ bytesEstimated: 20 })];
    await q({ env: 'api/bq', sql: 'SELECT 1; SELECT 2', database: 'other' });
    expect(executor.prepareCalls).toHaveLength(1);
    expect(executor.prepareCalls[0]!.map((s) => s.text)).toEqual(['SELECT 1', 'SELECT 2']);
    expect(executor.reads).toHaveLength(1);
  });

  it('never asks on MySQL, and the MySQL response has no byte field', async () => {
    const { broker, executor } = makeBroker();
    executor.prepared = [select()];
    const out = (await broker.query({ env: 'api/dev', sql: 'SELECT 1' })) as any;
    expect(executor.prepareCalls).toHaveLength(0);
    expect(Object.keys(out.results[0])).not.toContain('bytes_billed');
    expect(Object.keys(out).sort()).toEqual(['decided_by', 'environment', 'mode', 'production', 'request_id', 'results', 'status'].sort());
    expect(executor.reads[0]!.statements[0]).not.toHaveProperty('maxBytesBilled');
    // the item keeps its keys, and their order, byte for byte
    expect(Object.keys(out.results[0])).toEqual(['index', 'sql', 'verb', 'kind', 'duration_ms', 'columns', 'rows', 'row_count']);
    expect(executor.reads[0]!.statements[0]).toEqual({ text: 'SELECT 1', verb: 'SELECT', kind: 'read' });
  });

  it('a server that reads something other than SELECT refuses the request (writes_in_read), audited', async () => {
    const { q, executor, audit } = bqBroker();
    for (const kind of ['SCRIPT', 'DELETE', 'CREATE_TABLE', undefined]) {
      executor.prepared = [{ ...(kind ? { serverKind: kind } : {}) }];
      await expect(q({ env: 'api/bq', sql: 'SELECT 1' })).rejects.toMatchObject({ code: 'writes_in_read' });
    }
    expect(executor.reads).toHaveLength(0);
    expect(audit.filter((a) => a.state === 'refused' && a.errorCode === 'writes_in_read')).toHaveLength(4);
  });

  it('a dry run that failed does not decide: the run reports the error', async () => {
    const { q, executor } = bqBroker();
    executor.prepared = [{ failed: true }];
    const out = await q({ env: 'api/bq', sql: 'SELECT 1' });
    expect(out.status).toBe('succeeded');
    expect(executor.reads[0]!.statements[0]!.maxBytesBilled).toBe(AGENT_BYTES_APPROVAL);
  });

  it('exactly 10 GiB runs, one byte more waits; the ceiling is 10 GiB or the estimate rounded up to the GiB', async () => {
    const { q, executor, broker } = bqBroker();
    executor.prepared = [select({ bytesEstimated: AGENT_BYTES_APPROVAL })];
    expect((await q({ env: 'api/bq', sql: 'SELECT 1' })).status).toBe('succeeded');
    expect(executor.reads[0]!.statements[0]!.maxBytesBilled).toBe(10 * GIB);

    executor.prepared = [select({ bytesEstimated: AGENT_BYTES_APPROVAL + 1 })];
    const waiting = await q({ env: 'api/bq', sql: 'SELECT 1', reason: 'total' });
    expect(waiting.status).toBe('pending_approval');
    expect(waiting.approval_reason).toContain('GiB');
    expect(executor.reads).toHaveLength(1);
    broker.approve(waiting.request_id, { shareResult: true });
    await broker.waitForStatus(waiting.request_id, (s) => s === 'succeeded', 5000);
    expect(executor.reads[1]!.statements[0]!.maxBytesBilled).toBe(11 * GIB);
  });

  it('a routine the dry run reports waits, named without a project; a failed dry run reports none', async () => {
    const { q, executor } = bqBroker();
    executor.prepared = [select({ routines: ['ds.remote_fn'] })];
    const out = await q({ env: 'api/bq', sql: 'SELECT * FROM ds.v', reason: 'x' });
    expect(out.status).toBe('pending_approval');
    expect(out.approval_reason).toContain('ds.remote_fn');
    expect(executor.reads).toHaveLength(0);
    executor.prepared = [{ failed: true }];
    expect((await q({ env: 'api/bq', sql: 'SELECT * FROM ds.v' })).status).toBe('succeeded');
    // nothing was shown to the person, so the driver must refuse a routine only its own dry run finds
    expect(executor.reads.at(-1)!.statements[0]!.refuseRoutines).toBe(true);
    executor.prepared = [select()];
    expect((await q({ env: 'api/bq', sql: 'SELECT * FROM ds.v' })).status).toBe('succeeded');
  });

  it('the approval reason is a reference: English for the agent, the app locale for the person', async () => {
    const { q, executor, broker } = bqBroker();
    executor.prepared = [select({ bytesEstimated: 30 * GIB })];
    const out = await q({ env: 'api/bq', sql: 'SELECT 1', reason: 'x' });
    expect(out.approval_reason).toBe("This read should scan 30 GiB, above 10 GiB: it waits for your approval, whatever the environment's level.");
    expect(broker.snapshot().pending[0]!.statements[0]).toMatchObject({ bytesEstimated: 30 * GIB });
  });

  it('a limit under 10 GiB is the threshold, and the message names the limit', async () => {
    const { q, executor } = bqBroker({ maxBytesBilled: 2 * GIB });
    executor.prepared = [select({ bytesEstimated: 2 * GIB })];
    expect((await q({ env: 'api/bq', sql: 'SELECT 1' })).status).toBe('succeeded');
    executor.prepared = [select({ bytesEstimated: 3 * GIB })];
    const out = await q({ env: 'api/bq', sql: 'SELECT 1', reason: 'x' });
    expect(out.status).toBe('pending_approval');
    expect(out.approval_reason).toContain('limit of 2 GiB');
  });

  it('no limit on the environment: 10 GiB still holds', async () => {
    const rig = bqBroker();
    delete (rig.envs[2] as { maxBytesBilled?: number }).maxBytesBilled;
    rig.executor.prepared = [select({ bytesEstimated: 11 * GIB })];
    expect((await rig.q({ env: 'api/bq', sql: 'SELECT 1', reason: 'x' })).status).toBe('pending_approval');
    rig.executor.prepared = [select({ bytesEstimated: 9 * GIB })];
    expect((await rig.q({ env: 'api/bq', sql: 'SELECT 2' })).status).toBe('succeeded');
  });

  it('a 15-minute grant covers small reads and not the big one', async () => {
    const { q, executor, broker } = bqBroker({ production: true });
    executor.prepared = [select({ bytesEstimated: 1 })];
    const first = await q({ env: 'api/bq', sql: 'SELECT 1', reason: 'abrir' });
    broker.approve(first.request_id, { shareResult: true, grantReads: true });
    await broker.waitForStatus(first.request_id, (s) => s === 'succeeded', 5000);
    expect((await q({ env: 'api/bq', sql: 'SELECT 2' })).decided_by).toBe('policy');
    executor.prepared = [select({ bytesEstimated: 11 * GIB })];
    expect((await q({ env: 'api/bq', sql: 'SELECT 3', reason: 'grande' })).status).toBe('pending_approval');
  });

  it('a call that runs outside the engine waits, with the reason, even with the level free', async () => {
    const { q, executor } = bqBroker();
    executor.prepared = [select({ bytesEstimated: 1 })];
    for (const [sql, text] of [
      ['SELECT proj.ds.fn(1)', 'PROJ.DS.FN'],
      ['SELECT ML.GENERATE_TEXT(1)', 'ML.GENERATE_TEXT'],
      ['SELECT my_udf(1)', 'MY_UDF'],
    ] as const) {
      await expect(q({ env: 'api/bq', sql })).rejects.toMatchObject({ code: 'reason_required' });
      const out = await q({ env: 'api/bq', sql, reason: 'x' });
      expect(out.status, sql).toBe('pending_approval');
      expect(out.approval_reason, sql).toContain(text);
    }
    expect(executor.reads).toHaveLength(0);
    // native functions do not
    expect((await q({ env: 'api/bq', sql: 'SELECT COUNT(*), NET.HOST("a")' })).status).toBe('succeeded');
  });

  it('results carry the bytes, and the trail has the job and the bytes of the run, no rows', async () => {
    const { q, executor, audit } = bqBroker();
    executor.prepared = [select({ bytesEstimated: 5 })];
    executor.readOutcome = { results: [big(5)] };
    const out = await q({ env: 'api/bq', sql: 'SELECT 1' });
    expect(out.results[0]).toMatchObject({ bytes_estimated: 5, bytes_processed: 5, bytes_billed: 5 });
    const last = audit.at(-1)!;
    expect(last).toMatchObject({ state: 'succeeded', jobId: 'job_1', bytesEstimated: 5, bytesBilled: 5 });
    expect(last.statements![0]).toMatchObject({ verb: 'SELECT', jobId: 'job_1', bytesBilled: 5 });
    expect(JSON.stringify(audit)).not.toContain('"rows":[');
  });

  it('a re-read result does not count its bytes twice', async () => {
    const { q, executor, audit } = bqBroker();
    executor.prepared = [select({ bytesEstimated: 5 })];
    executor.readOutcome = { results: [result({ stats: { bytesEstimated: 5, bytesBilled: 5, reread: true, jobId: 'job_1' } })] };
    await q({ env: 'api/bq', sql: 'SELECT 1' });
    expect(audit.at(-1)).not.toHaveProperty('bytesBilled');
  });

  it('with the result withheld the agent gets counts only, no bytes', async () => {
    const { q, executor, broker } = bqBroker({ production: true });
    executor.prepared = [select({ bytesEstimated: 5 })];
    executor.readOutcome = { results: [big(5)] };
    const pending = await q({ env: 'api/bq', sql: 'SELECT 1', reason: 'x' });
    broker.approve(pending.request_id, { shareResult: false });
    await broker.waitForStatus(pending.request_id, (s) => s === 'succeeded', 5000);
    const out = (await broker.status({ id: pending.request_id })) as any;
    expect(out.result_withheld).toBe(true);
    expect(out.results[0]).not.toHaveProperty('bytes_billed');
    expect(out.results[0]).not.toHaveProperty('rows');
  });

  it('--write is engine_read_only and nothing is asked of the executor', async () => {
    const { q, executor } = bqBroker();
    await expect(q({ env: 'api/bq', sql: 'UPDATE t SET a = 1 WHERE true', write: true, reason: 'x' })).rejects.toMatchObject({ code: 'engine_read_only' });
    expect(executor.prepareCalls).toHaveLength(0);
    expect(executor.writes).toHaveLength(0);
  });
});

describe('AgentSessions.prepare', () => {
  it('opens nothing for an engine without a dry run', async () => {
    let opened = 0;
    const sessions = new AgentSessions({
      getDriver: () => ({ open: async () => void opened++ }) as never,
      resolveConnectParams: async () => {
        opened++;
        throw new Error('no');
      },
    });
    const env = makeBroker().envs[0]!;
    expect(await sessions.prepare(env, { statements: [{ text: 'SELECT 1' }] })).toBeUndefined();
    expect(opened).toBe(0);
  });
});

describe('FakeExecutor sanity', () => {
  it('is a plain executor without a dry run unless a test sets one', async () => {
    expect(await new FakeExecutor().prepare({} as never, { statements: [] })).toBeUndefined();
  });
});

describe('chained calls and OBJ.* (the review must see which function runs)', () => {
  it('a chained call is ambiguous text for agents, in every written form', () => {
    for (const sql of [
      "SELECT ('hi').(AI.GENERATE)(connection_id => 'us.c', endpoint => 'gemini')",
      'SELECT (x).(ds.remote_fn)() FROM ds.t',
      'SELECT (x).my_udf() FROM t',
      'SELECT (x).a.my_udf() FROM t',
      'SELECT a[0].my_udf() FROM t',
    ]) {
      expect(bq.agentCodeProblem!(sql), sql).toMatch(/Chained call/);
    }
  });

  it('ordinary paths, field access and calls are not chained calls', () => {
    for (const sql of ['SELECT t.a.b FROM ds.t', 'SELECT ds.fn(1)', 'SELECT (SELECT AS STRUCT 1 a).a', 'SELECT (a + b) * (c)', 'SELECT COUNT(*) FROM `p.ds.t`', 'SELECT x.y FROM t WHERE (a) AND (b)']) {
      expect(bq.agentCodeProblem!(sql), sql).toBeNull();
    }
  });

  it('the broker refuses a chained call before anything runs', async () => {
    const { q, executor } = bqBroker();
    executor.prepared = [select()];
    await expect(q({ env: 'api/bq', sql: 'SELECT (x).my_udf() FROM t' })).rejects.toMatchObject({ code: 'ambiguous_text' });
    expect(executor.prepareCalls).toHaveLength(0);
  });

  it('OBJ.* is function_not_allowed, with or without SAFE., and in a quoted name', () => {
    for (const sql of [
      "SELECT OBJ.GET_ACCESS_URL(OBJ.MAKE_REF('gs://b/o', 'us.conn'), 'rw')",
      "SELECT SAFE.OBJ.GET_ACCESS_URL(r, 'rw')",
      'SELECT obj.fetch_metadata(r)',
      'SELECT `obj`.`make_ref`(a, b)',
    ]) {
      expect(d(sql), sql).toMatchObject({ action: 'refuse', code: 'function_not_allowed' });
    }
  });
});

describe('the job ceiling follows the environment limit', () => {
  it('a limit under 10 GiB is the job ceiling of a free read, and a failed dry run keeps it', async () => {
    const { q, executor } = bqBroker({ maxBytesBilled: 1 * GIB });
    executor.prepared = [select({ bytesEstimated: 1 })];
    expect((await q({ env: 'api/bq', sql: 'SELECT 1' })).status).toBe('succeeded');
    expect(executor.reads[0]!.statements[0]!.maxBytesBilled).toBe(1 * GIB);
    executor.prepared = [{ failed: true }];
    await q({ env: 'api/bq', sql: 'SELECT 2' });
    expect(executor.reads[1]!.statements[0]!.maxBytesBilled).toBe(1 * GIB);
  });

  it('a request approved over the limit lifts the ceiling to the rounded estimate only', async () => {
    const { q, executor, broker } = bqBroker({ maxBytesBilled: 1 * GIB });
    executor.prepared = [select({ bytesEstimated: 3 * GIB + 1 })];
    const waiting = await q({ env: 'api/bq', sql: 'SELECT 1', reason: 'x' });
    expect(waiting.status).toBe('pending_approval');
    broker.approve(waiting.request_id, { shareResult: true });
    await broker.waitForStatus(waiting.request_id, (s) => s === 'succeeded', 5000);
    expect(executor.reads[0]!.statements[0]!.maxBytesBilled).toBe(4 * GIB);
  });

  it('the estimates of the commands add up against the threshold', async () => {
    const { q, executor } = bqBroker();
    executor.prepared = [select({ bytesEstimated: 6 * GIB }), select({ bytesEstimated: 6 * GIB })];
    const out = await q({ env: 'api/bq', sql: 'SELECT 1; SELECT 2', reason: 'x' });
    expect(out.status).toBe('pending_approval');
    expect(out.approval_reason).toContain('12 GiB');
    expect(executor.reads).toHaveLength(0);
    executor.prepared = [select({ bytesEstimated: 5 * GIB }), select({ bytesEstimated: 5 * GIB })];
    expect((await q({ env: 'api/bq', sql: 'SELECT 3; SELECT 4' })).status).toBe('succeeded');
  });

  it('the function reason is kept when the bytes also ask for approval', async () => {
    const { q, executor } = bqBroker();
    executor.prepared = [select({ bytesEstimated: 20 * GIB })];
    const out = await q({ env: 'api/bq', sql: "SELECT AI.GENERATE('x') FROM ds.t", reason: 'x' });
    expect(out.status).toBe('pending_approval');
    expect(out.approval_reason).toContain('AI.GENERATE');
  });
});

describe('schema --table and script-save with several engines', () => {
  it('MySQL keeps a table or view with no visible columns when asked by --table', async () => {
    const { broker, executor } = makeBroker();
    executor.tree = {
      foreignKeysComplete: true,
      databases: [
        { name: 'app', tables: [{ name: 'broken', type: 'view', columns: [] }] },
        { name: 'other', tables: [{ name: 'broken', type: 'table', columns: [{ name: 'id', type: 'int', nullable: false }] }] },
      ],
    };
    const out = (await broker.schema({ env: 'api/dev', table: 'broken' })) as any;
    expect(out.databases.map((x: any) => [x.name, x.tables[0].columns.length])).toEqual([['app', 0], ['other', 1]]);
  });

  it('a MySQL script is saved in a project whose first environment is BigQuery, in both orders', async () => {
    for (const first of [true, false]) {
      const { broker, envs } = makeBroker();
      const env = { ...bqEnv } as never;
      if (first) envs.unshift(env);
      else envs.push(env);
      const out = (await broker.scriptSave({ project: 'api', name: `fix-${first}`, sql: 'UPDATE cards SET a = 1 WHERE id = 2' })) as any;
      expect(out).toBeTruthy();
    }
  });

  it('a script no engine of the project accepts is refused, and a chained call is refused for all', async () => {
    const { broker, envs } = makeBroker();
    envs.unshift({ ...bqEnv } as never);
    await expect(broker.scriptSave({ project: 'api', name: 'x', sql: 'DROP TABLE t' })).rejects.toMatchObject({ code: 'invalid_script' });
    await expect(broker.scriptSave({ project: 'api', name: 'y', sql: 'SELECT (x).f() FROM t' })).rejects.toMatchObject({ code: 'invalid_script' });
  });
});
