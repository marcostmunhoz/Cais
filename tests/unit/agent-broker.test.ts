import { describe, expect, it } from 'vitest';
import { PENDING_TTL_MS, READ_GRANT_MS, ROLLBACK_AFTER_MS } from '@shared/agents';
import { decisionFields } from '@main/agents/broker';
import { changedForAgents } from '@main/store/catalog';
import { AgentError } from '@main/agents/errors';
import { dev, flush, makeBroker, pro, result } from '../support/agent-fakes';

const refused = async (p: Promise<unknown>): Promise<AgentError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AgentError);
    return e as AgentError;
  }
  throw new Error('expected a refusal');
};

describe('reads outside production', () => {
  it('run at once, return the rows, and are recorded in the trail without data', async () => {
    const { broker, executor, audit } = makeBroker();
    const res = (await broker.query({ env: 'api/dev', sql: 'SELECT id, email FROM people', client: 'Claude Code' })) as any;
    expect(res.status).toBe('succeeded');
    expect(res.results[0].rows).toEqual([[1, 'ana@x.com'], [2, 'bia@x.com']]);
    expect(res.results[0].columns.map((c: any) => c.name)).toEqual(['id', 'email']);
    expect(res.decided_by).toBe('policy');
    expect(res).not.toHaveProperty('auto_commit');
    expect(executor.reads).toHaveLength(1);
    // a line before running and the final one, same id
    expect(audit.map((a) => a.state)).toEqual(['running', 'succeeded']);
    expect(audit[1]).toMatchObject({ id: audit[0]!.id, client: 'Claude Code', environment: 'api/dev', environmentId: 'e-dev', production: false, mode: 'read', state: 'succeeded', decidedBy: 'policy' });
    expect(JSON.stringify(audit)).not.toContain('ana@x.com');
  });

  it('accept the env id or the slug in any case, and reject unknown environments', async () => {
    const { broker } = makeBroker();
    for (const env of ['e-dev', 'API/DEV', 'api/dev']) expect(((await broker.query({ env, sql: 'SELECT 1' })) as any).status).toBe('succeeded');
    expect((await refused(broker.query({ env: 'api/nada', sql: 'SELECT 1' }))).code).toBe('env_not_found');
  });

  it('use the default of 200 rows and clamp --max-rows to 1000', async () => {
    const { broker, executor } = makeBroker();
    await broker.query({ env: 'api/dev', sql: 'SELECT 1' });
    await broker.query({ env: 'api/dev', sql: 'SELECT 1', maxRows: 5000 });
    expect(executor.reads.map((r) => r.maxRows)).toEqual([200, 1000]);
  });

  it('a failing read ends as failed with a code and nothing else', async () => {
    const { broker, executor } = makeBroker();
    executor.readOutcome = { results: [result({ error: { message: 'x' } })], error: { message: 'Table x doesn\'t exist', code: 'ER_NO_SUCH_TABLE' } };
    const res = (await broker.query({ env: 'api/dev', sql: 'SELECT * FROM x' })) as any;
    expect(res.status).toBe('failed');
    expect(res.error).toEqual({ message: "Table x doesn't exist", code: 'ER_NO_SUCH_TABLE' });
  });
});

describe('refusals', () => {
  it('refuse writes in read mode and DDL, always with a code, and never reach the executor', async () => {
    const { broker, executor, audit } = makeBroker();
    const w = await refused(broker.query({ env: 'api/dev', sql: 'UPDATE t SET a = 1 WHERE id = 1' }));
    expect([w.code, w.message]).toEqual(['writes_in_read', 'This SQL writes. Ask with --write.']);
    const ddl = await refused(broker.query({ env: 'api/dev', sql: 'DROP TABLE t', write: true, reason: 'x' }));
    expect(ddl.code).toBe('ddl_or_transaction');
    expect(executor.reads.length + executor.writes.length).toBe(0);
    expect(audit.map((a) => a.state)).toEqual(['refused', 'refused']);
  });

  it('refuse a request that needs approval and has no reason', async () => {
    const { broker } = makeBroker();
    expect((await refused(broker.query({ env: 'api/pro', sql: 'SELECT 1' }))).code).toBe('reason_required');
    expect((await refused(broker.query({ env: 'api/dev', sql: 'UPDATE t SET a = 1 WHERE id = 1', write: true }))).code).toBe('reason_required');
  });

  it('refuse everything while access is off', async () => {
    const { broker } = makeBroker();
    await broker.disable();
    expect((await refused(broker.query({ env: 'api/dev', sql: 'SELECT 1' }))).code).toBe('agent_access_off');
    expect(() => broker.envs()).toThrow('desligado');
    expect(() => broker.requests(5)).toThrow('desligado');
    expect(() => broker.scripts()).toThrow('desligado');
  });

  it('the 21st pending request is refused; a direct read still runs', async () => {
    const { broker } = makeBroker();
    for (let i = 0; i < 20; i++) await broker.query({ env: 'api/pro', sql: `SELECT ${i}`, reason: 'r' });
    expect((await refused(broker.query({ env: 'api/pro', sql: 'SELECT 21', reason: 'r' }))).code).toBe('queue_full');
    expect(((await broker.query({ env: 'api/dev', sql: 'SELECT 1' })) as any).status).toBe('succeeded');
  });

  it('refuse SQL over 100 KB', async () => {
    const { broker } = makeBroker();
    expect((await refused(broker.query({ env: 'api/dev', sql: `SELECT '${'x'.repeat(102_400)}'` }))).code).toBe('sql_too_large');
  });
});

describe('approval of reads in production', () => {
  it('nothing runs until the person approves: not after 10 minutes either', async () => {
    const { broker, executor, clock } = makeBroker();
    const res = (await broker.query({ env: 'api/pro', sql: 'SELECT id FROM people', reason: 'incidente', client: 'Claude Code' })) as any;
    expect(res).toMatchObject({ status: 'pending_approval', environment: 'api/pro', production: true });
    expect(res).not.toHaveProperty('decided_by');
    expect(executor.reads).toHaveLength(0);
    await clock.advance(PENDING_TTL_MS - 1);
    expect(executor.reads).toHaveLength(0);
    expect(broker.snapshot().pending).toHaveLength(1);
    await clock.advance(1);
    expect(executor.reads).toHaveLength(0);
    const status = (await broker.status({ id: res.request_id })) as any;
    expect(status.status).toBe('expired');
    // the status already says it: nobody decided
    expect(status).not.toHaveProperty('decided_by');
    expect(status).not.toHaveProperty('auto_commit');
    expect(() => broker.approve(res.request_id, { shareResult: true })).toThrow('não está mais nesse estado');
    expect(executor.reads).toHaveLength(0);
  });

  it('approve runs it and `status` returns the rows', async () => {
    const { broker, executor, events } = makeBroker();
    const { request_id } = (await broker.query({ env: 'api/pro', sql: 'SELECT id FROM people', reason: 'incidente' })) as any;
    expect(events.newPending).toEqual([request_id]);
    broker.approve(request_id, { shareResult: true });
    await flush();
    const res = (await broker.status({ id: request_id })) as any;
    expect(res.status).toBe('succeeded');
    expect(res.results[0].row_count).toBe(2);
    expect(res.decided_by).toBe('person');
    expect(res).not.toHaveProperty('auto_commit'); // a read never carries it
    expect(executor.reads).toHaveLength(1);
  });

  it('shows the reason, client, SQL and alerts to the person (and the pending view carries no rows)', async () => {
    const { broker } = makeBroker();
    await broker.query({ env: 'api/dev', sql: 'UPDATE cards SET status = 1', write: true, reason: 'bloquear', client: 'Claude Code' });
    const [v] = broker.snapshot().pending;
    expect(v).toMatchObject({ client: 'Claude Code', reason: 'bloquear', mode: 'write', environmentLabel: 'api · dev', warnings: ['UPDATE sem WHERE'] });
    expect(JSON.stringify(v)).not.toContain('ana@x.com');
  });

  it('reject records the reason and the agent sees status rejected with it', async () => {
    const { broker, executor } = makeBroker();
    const { request_id } = (await broker.query({ env: 'api/pro', sql: 'SELECT 1', reason: 'r' })) as any;
    broker.reject(request_id, 'Ask only for the columns you need');
    const res = (await broker.status({ id: request_id })) as any;
    expect(res).toMatchObject({ status: 'rejected', rejection_reason: 'Ask only for the columns you need', decided_by: 'person' });
    expect(executor.reads).toHaveLength(0);
  });

  it('"15 minutes" grants reads in that environment only, expires, and can be revoked', async () => {
    const { broker, executor, clock } = makeBroker();
    const first = (await broker.query({ env: 'api/pro', sql: 'SELECT 1', reason: 'r' })) as any;
    broker.approve(first.request_id, { shareResult: true, grantReads: true });
    await flush();
    expect(broker.snapshot().grants).toMatchObject([{ environmentId: 'e-pro', environmentLabel: 'api · pro' }]);
    // the next read in pro needs no click
    const direct = (await broker.query({ env: 'api/pro', sql: 'SELECT 2' })) as any;
    expect(direct.status).toBe('succeeded');
    // the person did not see this request: the grant counts as the policy
    expect(direct.decided_by).toBe('policy');
    expect(broker.snapshot().recent[0]).toMatchObject({ decidedBy: 'grant' });
    expect(executor.reads).toHaveLength(2);
    // a write still asks
    expect(((await broker.query({ env: 'api/pro', sql: 'UPDATE t SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any).status).toBe('pending_approval');
    // revoke: asks again
    broker.revokeGrant('e-pro');
    expect(((await broker.query({ env: 'api/pro', sql: 'SELECT 3', reason: 'r' })) as any).status).toBe('pending_approval');
    // grant again, then let it expire (an expired grant never counts, even before its timer runs)
    const again = (await broker.query({ env: 'api/pro', sql: 'SELECT 4', reason: 'r' })) as any;
    broker.approve(again.request_id, { shareResult: true, grantReads: true });
    await flush();
    await clock.advance(READ_GRANT_MS - 1);
    expect(((await broker.query({ env: 'api/pro', sql: 'SELECT 5' })) as any).status).toBe('succeeded');
    await clock.advance(1);
    expect(broker.snapshot().grants).toEqual([]);
    expect((await refused(broker.query({ env: 'api/pro', sql: 'SELECT 6' }))).code).toBe('reason_required');
  });

  it('the grant box only works for a read', async () => {
    const { broker } = makeBroker();
    const w = (await broker.query({ env: 'api/pro', sql: 'UPDATE t SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    expect(() => broker.approve(w.request_id, { shareResult: true, grantReads: true })).toThrow('só vale para leitura.');
    const d = (await broker.query({ env: 'api/dev', sql: 'UPDATE t SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    expect(() => broker.approve(d.request_id, { shareResult: true, grantReads: true })).toThrow(AgentError);
    expect(broker.snapshot().grants).toEqual([]);
    expect(broker.snapshot().pending).toHaveLength(2); // nothing was approved by the failed attempts
  });

  it('result withheld: counts only, no columns, no values, no value-bearing server errors', async () => {
    const { broker, executor } = makeBroker();
    const { request_id } = (await broker.query({ env: 'api/pro', sql: 'SELECT email FROM people', reason: 'r' })) as any;
    broker.approve(request_id, { shareResult: false });
    await flush();
    const res = (await broker.status({ id: request_id })) as any;
    expect(res.result_withheld).toBe(true);
    expect(res.results[0]).toMatchObject({ row_count: 2, verb: 'SELECT' });
    expect(res.results[0].rows).toBeUndefined();
    expect(res.results[0].columns).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('ana@x.com');

    executor.readOutcome = {
      results: [result({ error: { message: "Duplicate entry 'ana@x.com' for key 'email'", code: 'ER_DUP_ENTRY' } })],
      error: { message: "Duplicate entry 'ana@x.com' for key 'email'", code: 'ER_DUP_ENTRY' },
    };
    const b = (await broker.query({ env: 'api/pro', sql: 'SELECT 1', reason: 'r' })) as any;
    broker.approve(b.request_id, { shareResult: false });
    await flush();
    const failed = (await broker.status({ id: b.request_id })) as any;
    expect(failed.status).toBe('failed');
    expect(JSON.stringify(failed)).not.toContain('ana@x.com');
    expect(failed.error.code).toBe('ER_DUP_ENTRY');
  });
});

describe('writes', () => {
  async function pendingWrite(h = makeBroker(), env = 'api/dev') {
    const res = (await h.broker.query({ env, sql: "UPDATE cards SET status = 'blocked' WHERE id IN (1, 2)", write: true, reason: 'duplicados' })) as any;
    return { ...h, id: res.request_id as string };
  }

  it('always need approval, then run in a transaction and wait for the second decision', async () => {
    const { broker, executor, id } = await pendingWrite();
    expect(executor.writes).toHaveLength(0);
    broker.approve(id, { shareResult: true });
    await flush();
    expect(executor.writes).toHaveLength(1);
    const res = (await broker.status({ id })) as any;
    expect(res.status).toBe('awaiting_commit');
    expect(res.results).toBeUndefined(); // nothing about the outcome until the person decides
    expect(broker.snapshot().awaitingCommit[0]!.statements[0]).toMatchObject({ verb: 'UPDATE', affectedRows: 2 });
  });

  it('Commit ends as committed with the affected rows', async () => {
    const { broker, executor, id } = await pendingWrite();
    broker.approve(id, { shareResult: true });
    await flush();
    await broker.commit(id);
    const res = (await broker.status({ id })) as any;
    expect(res.status).toBe('committed');
    expect(res.results[0].affected_rows).toBe(2);
    expect(res).toMatchObject({ decided_by: 'person', auto_commit: false });
    expect(executor.commits).toBe(1);
    expect(executor.rollbacks).toBe(0);
  });

  it('Rollback ends as rolled_back, with no results', async () => {
    const { broker, executor, id, audit } = await pendingWrite();
    broker.approve(id, { shareResult: true });
    await flush();
    await broker.rollback(id);
    const res = (await broker.status({ id })) as any;
    expect(res).toMatchObject({ status: 'rolled_back', rollback_reason: 'user', decided_by: 'person' });
    expect(res).not.toHaveProperty('auto_commit');
    expect(res.results).toBeUndefined();
    expect(executor.rollbacks).toBe(1);
    expect(audit.at(-1)).toMatchObject({ state: 'rolled_back', rollbackReason: 'user' });
  });

  it('rolls back by itself after 120 s (fake clock), and a late Commit is refused', async () => {
    const { broker, executor, clock, id } = await pendingWrite();
    broker.approve(id, { shareResult: true });
    await flush();
    expect(broker.snapshot().awaitingCommit[0]!.rollbackAt).toBe(clock.now + ROLLBACK_AFTER_MS);
    await clock.advance(ROLLBACK_AFTER_MS - 1);
    expect(executor.rollbacks).toBe(0);
    await clock.advance(1);
    const res = (await broker.status({ id })) as any;
    expect(res).toMatchObject({ status: 'rolled_back', rollback_reason: 'timeout', decided_by: 'person' });
    expect(executor.rollbacks).toBe(1);
    await expect(broker.commit(id)).rejects.toThrow('não está mais nesse estado');
    expect(executor.commits).toBe(0);
  });

  it('a Commit clears the automatic rollback: the clock cannot roll back a committed write', async () => {
    const { broker, executor, clock, id } = await pendingWrite();
    broker.approve(id, { shareResult: true });
    await flush();
    await broker.commit(id);
    await clock.advance(ROLLBACK_AFTER_MS * 2);
    expect(executor.rollbacks).toBe(0);
    expect(((await broker.status({ id })) as any).status).toBe('committed');
  });

  it('an error in a command ends as failed (already rolled back by the session)', async () => {
    const h = makeBroker();
    h.executor.writeOutcome = { results: [result({ error: { message: 'boom' }, kind: 'write', verb: 'UPDATE' })], open: false, error: { message: 'boom', code: 'ER_BAD' } };
    const { broker, id } = await pendingWrite(h);
    broker.approve(id, { shareResult: true });
    await flush();
    const res = (await broker.status({ id })) as any;
    expect(res).toMatchObject({ status: 'failed', error: { code: 'ER_BAD' } });
    expect(h.executor.commits).toBe(0);
  });

  it('succeeded when the server says no transaction stayed open', async () => {
    const h = makeBroker();
    h.executor.writeOutcome = { results: [result({ kind: 'session', verb: 'SET' })], open: false };
    const { broker, id } = await pendingWrite(h);
    broker.approve(id, { shareResult: true });
    await flush();
    expect(((await broker.status({ id })) as any).status).toBe('succeeded');
  });

  it('affected rows survive when the person withholds the result', async () => {
    const { broker, id } = await pendingWrite();
    broker.approve(id, { shareResult: false });
    await flush();
    await broker.commit(id);
    const res = (await broker.status({ id })) as any;
    expect(res).toMatchObject({ status: 'committed', result_withheld: true });
    expect(res.results[0].affected_rows).toBe(2);
  });

  it('a connection failure ends as failed without leaking anything', async () => {
    const h = makeBroker();
    h.executor.runWrite = async () => {
      throw new AgentError('Could not connect to the environment. No response from <server>.', 'connection_failed');
    };
    const { broker, id } = await pendingWrite(h);
    broker.approve(id, { shareResult: true });
    await flush();
    const res = (await broker.status({ id })) as any;
    expect(res.status).toBe('failed');
    expect(JSON.stringify(res)).not.toContain(dev.host);
  });

  it('Commit and an automatic rollback at the same instant resolve once', async () => {
    const { broker, executor, clock, id } = await pendingWrite();
    broker.approve(id, { shareResult: true });
    await flush();
    await clock.advance(ROLLBACK_AFTER_MS - 1);
    const committing = broker.commit(id);
    await clock.advance(1);
    await committing;
    expect(executor.commits + executor.rollbacks).toBe(1);
  });
});

describe('waiting', () => {
  it('--wait resolves when the person approves and the read finishes', async () => {
    const { broker } = makeBroker();
    const waiting = broker.query({ env: 'api/pro', sql: 'SELECT 1', reason: 'r', wait: true, timeoutS: 600 }) as Promise<any>;
    await flush();
    const [pending] = broker.snapshot().pending;
    broker.approve(pending!.id, { shareResult: true });
    const res = await waiting;
    expect(res.status).toBe('succeeded');
    expect(res.timed_out).toBeUndefined();
  });

  it('--wait times out with timed_out while the request stays valid', async () => {
    const { broker, clock } = makeBroker();
    const waiting = broker.query({ env: 'api/pro', sql: 'SELECT 1', reason: 'r', wait: true, timeoutS: 30 }) as Promise<any>;
    await flush();
    await clock.advance(30_000);
    const res = await waiting;
    expect(res).toMatchObject({ status: 'pending_approval', timed_out: true });
    expect(broker.snapshot().pending).toHaveLength(1);
    // and the agent can wait again
    const again = broker.status({ id: res.request_id, wait: true, timeoutS: 600 }) as Promise<any>;
    await flush();
    broker.reject(res.request_id);
    expect((await again).status).toBe('rejected');
  });

  it('awaiting_commit is not final: status --wait keeps waiting for committed', async () => {
    const { broker } = makeBroker();
    const { request_id } = (await broker.query({ env: 'api/dev', sql: 'UPDATE t SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    const waiting = broker.status({ id: request_id, wait: true, timeoutS: 600 }) as Promise<any>;
    broker.approve(request_id, { shareResult: true });
    await flush();
    expect(broker.snapshot().awaitingCommit).toHaveLength(1);
    await broker.commit(request_id);
    expect((await waiting).status).toBe('committed');
  });

  it('an aborted wait (client gone) stops waiting and leaves the request alone', async () => {
    const { broker } = makeBroker();
    const abort = new AbortController();
    const waiting = broker.query({ env: 'api/pro', sql: 'SELECT 1', reason: 'r', wait: true, signal: abort.signal }) as Promise<any>;
    await flush();
    abort.abort();
    expect((await waiting).timed_out).toBe(true);
    expect(broker.snapshot().pending).toHaveLength(1);
  });
});

describe('turning access off and quitting', () => {
  it('disable expires pending requests, rolls back open transactions, drops grants and closes the agents connections', async () => {
    const { broker, executor } = makeBroker();
    const read = (await broker.query({ env: 'api/pro', sql: 'SELECT 1', reason: 'r' })) as any;
    const w = (await broker.query({ env: 'api/dev', sql: 'UPDATE t SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    const g = (await broker.query({ env: 'api/pro', sql: 'SELECT 2', reason: 'r' })) as any;
    broker.approve(w.request_id, { shareResult: true });
    broker.approve(g.request_id, { shareResult: true, grantReads: true });
    await flush();
    await broker.disable();
    const snap = broker.snapshot();
    expect(snap).toMatchObject({ enabled: false, pending: [], awaitingCommit: [], grants: [] });
    expect(snap.recent.find((r) => r.id === read.request_id)!.status).toBe('expired');
    expect(snap.recent.find((r) => r.id === w.request_id)).toMatchObject({ status: 'rolled_back', rollbackReason: 'access_off' });
    expect(executor.rollbacks).toBe(1);
    expect(executor.closeAllCalls).toBe(1);
  });

  it('shutdown does the same with reason "shutdown"', async () => {
    const { broker, executor } = makeBroker();
    const w = (await broker.query({ env: 'api/dev', sql: 'UPDATE t SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    broker.approve(w.request_id, { shareResult: true });
    await flush();
    await broker.shutdown();
    expect(broker.snapshot().recent[0]).toMatchObject({ status: 'rolled_back', rollbackReason: 'shutdown' });
    expect(executor.rollbacks).toBe(1);
  });

  it('approving after access went off is refused', async () => {
    const { broker } = makeBroker();
    const r = (await broker.query({ env: 'api/pro', sql: 'SELECT 1', reason: 'r' })) as any;
    await broker.disable();
    expect(() => broker.approve(r.request_id, { shareResult: true })).toThrow(AgentError);
  });
});

describe('what agents can see', () => {
  it('envs carries no host, user, credential id or secret', async () => {
    const { broker } = makeBroker();
    const out = broker.envs();
    expect(out.environments).toEqual([
      { id: 'e-dev', slug: 'api/dev', project: 'api', name: 'dev', production: false, engine: 'mysql', agent_access: 'free-reads', default_database: 'app' },
      { id: 'e-pro', slug: 'api/pro', project: 'api', name: 'pro', production: true, engine: 'mysql', agent_access: 'approve-all', default_database: 'app' },
    ]);
    const text = JSON.stringify(out);
    for (const secret of [dev.host, 'cred-secret-id', String(dev.port)]) expect(text).not.toContain(secret);
  });

  it('schema runs straight away even in production and needs no approval', async () => {
    const { broker, executor, audit } = makeBroker();
    const all = (await broker.schema({ env: 'api/pro' })) as any;
    expect(all.databases[0].tables[0]).toEqual({ name: 'cards', type: 'table' }); // names only without --database
    const db = (await broker.schema({ env: 'api/pro', database: 'APP' })) as any;
    expect(db.databases[0].tables[0].columns[0]).toEqual({ name: 'id', type: 'int', nullable: false, key: 'PRI' });
    const one = (await broker.schema({ env: 'api/pro', table: 'cards' })) as any;
    expect(one.databases).toHaveLength(1);
    expect((await refused(broker.schema({ env: 'api/pro', database: 'nope' }))).code).toBe('not_found');
    expect((await refused(broker.schema({ env: 'api/pro', table: 'nope' }))).code).toBe('not_found');
    expect(executor.reads).toHaveLength(0);
    expect(audit.every((a) => a.mode === 'schema')).toBe(true);
    expect(broker.snapshot().pending).toHaveLength(0);
    void pro;
  });

  it('agents list, read and create scripts, but there is no way to edit or delete', async () => {
    const { broker, scripts, events } = makeBroker();
    const created = (await broker.scriptSave({ project: 'API', name: 'Duplicados por documento', sql: 'SELECT 1', database: 'app' })) as any;
    expect(created).toMatchObject({ project: 'api', name: 'Duplicados por documento', created_by: 'agent' });
    expect(scripts[0]!.createdBy).toBe('agent');
    expect(events.scriptsChanged).toBe(1);
    expect((await refused(broker.scriptSave({ project: 'api', name: 'duplicados por documento', sql: 'SELECT 2' }))).code).toBe('duplicate_name');
    expect((broker.scripts('api').scripts as any[]).map((s) => s.name)).toEqual(['Duplicados por documento']);
    expect(broker.script(created.id)).toMatchObject({ sql: 'SELECT 1' });
    expect((broker as unknown as Record<string, unknown>).scriptDelete).toBeUndefined();
    expect((broker as unknown as Record<string, unknown>).scriptUpdate).toBeUndefined();
  });

  it('requests lists the most recent ones with the first line of the SQL only', async () => {
    const { broker } = makeBroker();
    await broker.query({ env: 'api/dev', sql: 'SELECT 1\nFROM dual' });
    const out = broker.requests(20) as any;
    expect(out.requests[0]).toMatchObject({ status: 'succeeded', sql: 'SELECT 1', mode: 'read', decided_by: 'policy' });
  });

  it('requests carries who decided, the same as status', async () => {
    const { broker, clock } = makeBroker();
    const ask = (sql: string, write = false) => broker.query({ env: write ? 'api/dev' : 'api/pro', sql, reason: 'r', ...(write ? { write: true } : {}) }) as Promise<any>;
    const committed = await ask('UPDATE t SET a = 1 WHERE id = 1', true);
    broker.approve(committed.request_id, { shareResult: true });
    await flush();
    await broker.commit(committed.request_id);
    const rejected = await ask('SELECT 1');
    broker.reject(rejected.request_id, '');
    const expired = await ask('SELECT 2');
    await clock.advance(PENDING_TTL_MS);
    const pending = await ask('SELECT 3');
    const items = new Map(((broker.requests(20) as any).requests as any[]).map((r) => [r.request_id, r]));
    expect(items.get(committed.request_id)).toMatchObject({ status: 'committed', decided_by: 'person', auto_commit: false });
    expect(items.get(rejected.request_id)).toMatchObject({ status: 'rejected', decided_by: 'person' });
    expect(items.get(expired.request_id).status).toBe('expired');
    expect(items.get(pending.request_id).status).toBe('pending_approval');
    for (const id of [expired.request_id, pending.request_id]) {
      expect(items.get(id)).not.toHaveProperty('decided_by');
      expect(items.get(id)).not.toHaveProperty('auto_commit');
    }
    expect(items.get(rejected.request_id)).not.toHaveProperty('auto_commit');
    // the same fields as status, and nothing else changed in the list item
    for (const item of items.values()) {
      const full = (await broker.status({ id: item.request_id })) as any;
      expect(item.decided_by).toBe(full.decided_by);
      expect(item.auto_commit).toBe(full.auto_commit);
      expect(Object.keys(item).slice(0, 7)).toEqual(['request_id', 'status', 'environment', 'production', 'mode', 'created_at', 'sql']);
    }
  });

  it('keeps the 100 most recent requests in memory', async () => {
    const { broker } = makeBroker();
    for (let i = 0; i < 120; i++) await broker.query({ env: 'api/dev', sql: `SELECT ${i}` });
    expect(broker.snapshot().recent).toHaveLength(100);
    expect(((await broker.status({ id: 'req_1' }).catch((e) => e)) as AgentError).code).toBe('not_found');
  });
});

describe('the environment changes under a request or a grant', () => {
  const setup = async () => {
    const h = makeBroker();
    const first = (await h.broker.query({ env: 'api/pro', sql: 'SELECT 1', reason: 'r' })) as any;
    h.broker.approve(first.request_id, { shareResult: true, grantReads: true });
    await flush();
    return h;
  };
  const edit = (h: ReturnType<typeof makeBroker>, over: Partial<typeof pro>) => {
    const i = h.envs.findIndex((e) => e.id === 'e-pro');
    h.envs[i] = { ...h.envs[i]!, ...over };
  };

  it.each([
    ['host', { host: 'other-server.example' }],
    ['credential', { credentialId: 'other-cred' }],
    ['default database', { defaultDatabase: 'other' }],
    ['production flag', { production: false }],
  ])('editing the %s revokes the grant, expires pending requests with "The environment changed." and closes the agent connections', async (_name, over) => {
    const h = await setup();
    const pending = (await h.broker.query({ env: 'api/pro', sql: 'UPDATE t SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    edit(h, over);
    await h.broker.environmentChanged('e-pro');
    expect(h.broker.snapshot().grants).toEqual([]);
    const st = (await h.broker.status({ id: pending.request_id })) as any;
    expect(st).toMatchObject({ status: 'expired', rejection_reason: 'The environment changed.' });
    expect(h.executor.changed).toEqual(['e-pro']);
    // the next read asks again
    if (!('production' in over)) {
      const reads = h.executor.reads.length;
      await expect(h.broker.query({ env: 'api/pro', sql: 'SELECT 2' })).rejects.toMatchObject({ code: 'reason_required' });
      expect(h.executor.reads.length).toBe(reads);
    }
  });

  it('a pending request never runs against an environment that changed or vanished, even if the hook was missed', async () => {
    const h = makeBroker();
    const w = (await h.broker.query({ env: 'api/dev', sql: 'DELETE FROM t WHERE id = 1', write: true, reason: 'r' })) as any;
    h.envs[0] = { ...h.envs[0]!, production: true, host: 'new-host.example' };
    expect(() => h.broker.approve(w.request_id, { shareResult: true })).toThrow('O ambiente mudou.');
    expect(h.executor.writes).toHaveLength(0);
    expect(((await h.broker.status({ id: w.request_id })) as any).status).toBe('expired');
    const v = (await h.broker.query({ env: 'api/pro', sql: 'DELETE FROM t WHERE id = 1', write: true, reason: 'r' })) as any;
    h.envs.splice(1, 1);
    expect(() => h.broker.approve(v.request_id, { shareResult: true })).toThrow('O ambiente mudou.');
    expect(h.executor.writes).toHaveLength(0);
  });

  it('deleting the environment ends its grant and pending requests; an open write keeps its own connection until decided', async () => {
    const h = makeBroker();
    const open = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE t SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    h.broker.approve(open.request_id, { shareResult: true });
    await flush();
    const waiting = (await h.broker.query({ env: 'api/dev', sql: 'DELETE FROM t WHERE id = 2', write: true, reason: 'r' })) as any;
    h.envs.splice(0, 1);
    await h.broker.environmentChanged('e-dev');
    expect(((await h.broker.status({ id: waiting.request_id })) as any).status).toBe('expired');
    expect(h.broker.snapshot().awaitingCommit).toHaveLength(1);
    expect(h.executor.rollbacks).toBe(0);
    await h.broker.commit(open.request_id);
    expect(((await h.broker.status({ id: open.request_id })) as any).status).toBe('committed');
  });
});

describe('renaming a project or an environment changes the slug', () => {
  const setup = async () => {
    const h = makeBroker();
    const first = (await h.broker.query({ env: 'api/pro', sql: 'SELECT 1', reason: 'r' })) as any;
    h.broker.approve(first.request_id, { shareResult: true, grantReads: true });
    await flush();
    const pending = (await h.broker.query({ env: 'api/pro', sql: 'UPDATE t SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    return { ...h, pending };
  };

  it('a project rename revokes the grants and expires the pending requests of every environment of the project', async () => {
    const h = await setup();
    const devPending = (await h.broker.query({ env: 'api/dev', sql: 'DELETE FROM t WHERE id = 1', write: true, reason: 'r' })) as any;
    h.projects[0]!.name = 'core';
    // what ipc.ts does after CatalogStore.renameProject: every environment of the project changed
    for (const env of h.envs.filter((e) => e.projectId === 'p-api')) await h.broker.environmentChanged(env.id);
    expect(h.broker.snapshot().grants).toEqual([]);
    expect(await h.broker.status({ id: h.pending.request_id })).toMatchObject({ status: 'expired', rejection_reason: 'The environment changed.' });
    expect(await h.broker.status({ id: devPending.request_id })).toMatchObject({ status: 'expired' });
    expect(h.executor.changed).toEqual(['e-dev', 'e-pro']);
    // the old slug no longer reaches anything; the new one asks again
    expect((await refused(h.broker.query({ env: 'api/pro', sql: 'SELECT 2', reason: 'r' }))).code).toBe('env_not_found');
    const again = (await h.broker.query({ env: 'core/pro', sql: 'SELECT 2', reason: 'r' })) as any;
    expect(again.status).toBe('pending_approval');
    expect(again.environment).toBe('core/pro');
  });

  it.each([
    ['name', { name: 'prod' }],
    ['project', { projectId: 'p-web' }],
  ])('saving an environment with another %s counts as a change for agents', async (_what, over) => {
    expect(changedForAgents(pro, { ...pro, ...over })).toBe(true);
    const h = await setup();
    const i = h.envs.findIndex((e) => e.id === 'e-pro');
    h.envs[i] = { ...h.envs[i]!, ...over };
    if (changedForAgents(pro, h.envs[i]!)) await h.broker.environmentChanged('e-pro');
    expect(h.broker.snapshot().grants).toEqual([]);
    expect(((await h.broker.status({ id: h.pending.request_id })) as any).status).toBe('expired');
  });

  it.each([
    ['the project renamed', (h: ReturnType<typeof makeBroker>) => void (h.projects[0]!.name = 'core')],
    ['the environment renamed', (h: ReturnType<typeof makeBroker>) => void (h.envs[1] = { ...h.envs[1]!, name: 'prod' })],
    ['only the case changed', (h: ReturnType<typeof makeBroker>) => void (h.envs[1] = { ...h.envs[1]!, name: 'PRO' })],
    ['the environment moved', (h: ReturnType<typeof makeBroker>) => void (h.projects.push({ id: 'p-web', name: 'web', order: 1 }), (h.envs[1] = { ...h.envs[1]!, projectId: 'p-web' }))],
  ])('approving during the rename window (%s, before the hook runs) is refused: the person saw the old name', async (_what, rename) => {
    const h = makeBroker();
    const w = (await h.broker.query({ env: 'api/pro', sql: 'DELETE FROM t WHERE id = 1', write: true, reason: 'r' })) as any;
    rename(h);
    expect(() => h.broker.approve(w.request_id, { shareResult: true })).toThrow('O ambiente mudou.');
    expect(h.executor.writes).toHaveLength(0);
    expect(((await h.broker.status({ id: w.request_id })) as any).status).toBe('expired');
  });

  it('saving an environment with nothing an agent sees changed keeps the grant', async () => {
    expect(changedForAgents(pro, { ...pro })).toBe(false);
    expect(changedForAgents(pro, { ...pro, agentLevel: 'free-reads' })).toBe(false);
    expect(changedForAgents(dev, { ...dev, host: 'other' })).toBe(true);
  });
});

describe('the "agent can see the result" choice follows the grant', () => {
  it('a 15-minute grant requires sharing the result: with the box unticked it is refused and no grant exists', async () => {
    const h = makeBroker();
    const a = (await h.broker.query({ env: 'api/pro', sql: 'SELECT 1', reason: 'r' })) as any;
    expect(() => h.broker.approve(a.request_id, { shareResult: false, grantReads: true })).toThrow(/exige que o agente possa ver/);
    expect(h.broker.snapshot().grants).toEqual([]);
    expect(h.broker.snapshot().pending).toHaveLength(1); // still waiting for a valid decision
    h.broker.approve(a.request_id, { shareResult: true, grantReads: true });
    await flush();
    const b = (await h.broker.query({ env: 'api/pro', sql: 'SELECT email FROM users' })) as any;
    expect(b.status).toBe('succeeded');
    expect(b.results[0].rows).toBeDefined();
    // outside production nothing is withheld
    expect(((await h.broker.query({ env: 'api/dev', sql: 'SELECT email FROM users' })) as any).results[0].rows).toBeDefined();
  });
});

describe('a failed write returns only the error', () => {
  it('no rows from earlier SELECTs, only the error, its code and the index of the failed command', async () => {
    const h = makeBroker();
    h.executor.writeOutcome = {
      open: false,
      results: [
        result({ columns: [{ name: 'email', type: 'varchar' }], rows: [['ana@x.com']] }),
        result({ kind: 'write', verb: 'INSERT', index: 1, error: { message: 'x', code: 'ER_NO_SUCH_TABLE' } }),
      ],
      error: { message: 'x', code: 'ER_NO_SUCH_TABLE' },
    };
    const w = (await h.broker.query({ env: 'api/dev', sql: 'SELECT email FROM u; INSERT INTO nope VALUES (1)', write: true, reason: 'r' })) as any;
    h.broker.approve(w.request_id, { shareResult: true });
    await flush();
    const st = (await h.broker.status({ id: w.request_id })) as any;
    expect(st.status).toBe('failed');
    expect(st.results).toBeUndefined();
    expect(st.error).toEqual({ message: 'x', code: 'ER_NO_SUCH_TABLE', statement_index: 1 });
    expect(JSON.stringify(st)).not.toContain('ana@x.com');
  });

  it('a failed read keeps its partial results', async () => {
    const h = makeBroker();
    h.executor.readOutcome = { results: [result({ columns: [{ name: 'a', type: 'int' }], rows: [[1]] })], error: { message: 'x', code: 'ER_X' } };
    expect(((await h.broker.query({ env: 'api/dev', sql: 'SELECT 1; SELECT 2' })) as any).results).toHaveLength(1);
  });
});

describe('non-transactional tables', () => {
  it('the write request warns for a table that is not InnoDB, with or without a qualifier or quotes; reads and InnoDB do not', async () => {
    const h = makeBroker();
    h.executor.tree = {
      databases: [{ name: 'app', tables: [
        { name: 'legacy_log', type: 'table', engine: 'MyISAM', columns: [] },
        { name: 'cards', type: 'table', engine: 'InnoDB', columns: [] },
        { name: 'v_cards', type: 'view', columns: [] },
      ] }],
    };
    const warn = 'A tabela legacy_log não é transacional (MyISAM): o Rollback não desfaz o que for gravado nela.';
    for (const sql of ["INSERT INTO legacy_log VALUES (1)", 'UPDATE app.LEGACY_LOG SET a = 1 WHERE id = 1', 'DELETE FROM `app`.`legacy_log` WHERE id = 1']) {
      const r = (await h.broker.query({ env: 'api/dev', sql, write: true, reason: 'r' })) as any;
      expect(h.broker.snapshot().pending.find((p) => p.id === r.request_id)!.warnings).toContain(warn);
    }
    const ok = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    expect(h.broker.snapshot().pending.find((p) => p.id === ok.request_id)!.warnings).toEqual([]);
  });

  it('a schema failure does not block the request (no warning, request still pending)', async () => {
    const h = makeBroker();
    h.executor.schema = async () => {
      throw new AgentError('x', 'connection_failed');
    };
    const r = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE t SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    expect(r.status).toBe('pending_approval');
  });

  it('Rollback reports incomplete (manual and by timer) to the agent and to the person; a complete one stays quiet', async () => {
    const h = makeBroker();
    h.executor.rollbackIncomplete = true;
    const a = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE t SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    h.broker.approve(a.request_id, { shareResult: true });
    await flush();
    const view = await h.broker.rollback(a.request_id);
    expect(view.rollbackIncomplete).toBe(true);
    expect(((await h.broker.status({ id: a.request_id })) as any)).toMatchObject({ status: 'rolled_back', rollback_incomplete: true });
    const b = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE t SET a = 2 WHERE id = 1', write: true, reason: 'r' })) as any;
    h.broker.approve(b.request_id, { shareResult: true });
    await flush();
    await h.clock.advance(ROLLBACK_AFTER_MS);
    expect(((await h.broker.status({ id: b.request_id })) as any).rollback_incomplete).toBe(true);
    h.executor.rollbackIncomplete = false;
    const c = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE t SET a = 3 WHERE id = 1', write: true, reason: 'r' })) as any;
    h.broker.approve(c.request_id, { shareResult: true });
    await flush();
    await h.broker.rollback(c.request_id);
    expect(((await h.broker.status({ id: c.request_id })) as any).rollback_incomplete).toBeUndefined();
  });
});

describe('text the person reads and the trail', () => {
  it('bidi and invisible controls are stripped from reason and client; SQL carrying them is refused', async () => {
    const h = makeBroker();
    const sql = "SELECT 'x'";
    await h.broker.query({ env: 'api/pro', sql, reason: 'safe \u202e daerylno\u2066', client: 'Cais\u202e\ufeff\n' });
    const v = h.broker.snapshot().pending[0]!;
    expect(v.reason).toBe('safe  daerylno');
    expect(v.client).toBe('Cais');
    expect(v.sql).toBe(sql);
    await expect(h.broker.query({ env: 'api/pro', sql: "SELECT '\u202ex'", reason: 'r' })).rejects.toMatchObject({ code: 'hidden_text' });
  });

  it('a request refused by policy is audited with only the first 500 characters of the SQL and its length', async () => {
    const h = makeBroker();
    const sql = `DROP TABLE t; -- ${'x'.repeat(5000)}`;
    await expect(h.broker.query({ env: 'api/dev', sql })).rejects.toBeInstanceOf(AgentError);
    expect(h.audit[0]).toMatchObject({ state: 'refused', sqlLength: sql.length });
    expect(h.audit[0]!.sql).toHaveLength(500);
    // an executed request keeps its SQL whole
    await h.broker.query({ env: 'api/dev', sql: `SELECT '${'y'.repeat(900)}'` });
    expect(h.audit[1]!.sql.length).toBeGreaterThan(900);
    expect(h.audit[1]!.sqlLength).toBeUndefined();
  });

  it('environment names compare NFC-normalized with ASCII-only case folding: no Unicode lookalike resolves', async () => {
    const h = makeBroker();
    h.envs.push({ ...dev, id: 'e-k', name: 'K8s' }, { ...dev, id: 'e-acc', name: 'Café' });
    for (const ref of ['API/DEV', 'api/k8S', 'e-dev', 'api/Café', 'api/Café'.normalize('NFD')]) {
      expect(((await h.broker.query({ env: ref, sql: 'SELECT 1' })) as any).status, ref).toBe('succeeded');
    }
    for (const ref of ['\u0430pi/dev', 'api/CAFÉ', 'api/dev \u202e']) {
      await expect(h.broker.query({ env: ref, sql: 'SELECT 1' }), ref).rejects.toMatchObject({ code: 'env_not_found' });
    }
  });
});

describe('decisionFields', () => {
  const read = { mode: 'read' as const };
  const write = { mode: 'write' as const };

  it('maps who decided: the person is person; the policy and a grant are policy; nobody is omitted', () => {
    expect(decisionFields({ ...read, status: 'succeeded', decidedBy: 'user' })).toEqual({ decided_by: 'person' });
    expect(decisionFields({ ...read, status: 'rejected', decidedBy: 'user' })).toEqual({ decided_by: 'person' });
    expect(decisionFields({ ...read, status: 'succeeded', decidedBy: 'policy' })).toEqual({ decided_by: 'policy' });
    expect(decisionFields({ ...read, status: 'succeeded', decidedBy: 'grant' })).toEqual({ decided_by: 'policy' });
    for (const decidedBy of ['timeout', 'shutdown', 'environment', undefined] as const) {
      expect(decisionFields({ ...read, status: decidedBy ? 'expired' : 'pending_approval', ...(decidedBy ? { decidedBy } : {}) })).toEqual({});
    }
  });

  it('a committed write always says whether the Commit was automatic, from the second decision', () => {
    expect(decisionFields({ ...write, status: 'committed', decidedBy: 'policy', secondDecision: { by: 'policy' } })).toEqual({ decided_by: 'policy', auto_commit: true });
    // stopped by the limits, then committed by the person: still the policy that let it run, not automatic
    expect(decisionFields({ ...write, status: 'committed', decidedBy: 'policy', secondDecision: { by: 'user' } })).toEqual({ decided_by: 'policy', auto_commit: false });
    expect(decisionFields({ ...write, status: 'committed', decidedBy: 'user', secondDecision: { by: 'user' } })).toEqual({ decided_by: 'person', auto_commit: false });
  });

  it('no auto_commit outside committed: commit_unknown (failed), rollback, awaiting the Commit', () => {
    expect(decisionFields({ ...write, status: 'failed', decidedBy: 'policy', secondDecision: { by: 'policy' } })).toEqual({ decided_by: 'policy' });
    expect(decisionFields({ ...write, status: 'rolled_back', decidedBy: 'user', secondDecision: { by: 'timeout' } })).toEqual({ decided_by: 'person' });
    expect(decisionFields({ ...write, status: 'awaiting_commit', decidedBy: 'policy' })).toEqual({ decided_by: 'policy' });
    expect(decisionFields({ ...write, status: 'running', decidedBy: 'user' })).toEqual({ decided_by: 'person' });
  });
});

describe('grid metadata stays out of the agent contract', () => {
  it('result columns go to agents as name and type only, and schema columns keep their shape', async () => {
    const h = makeBroker();
    h.executor.readOutcome = {
      results: [
        result({
          columns: [
            { name: 'id', type: 'int', source: { database: 'app', table: 'people', column: 'id', alias: 'p' }, primaryKeyPart: true, nullable: false, autoIncrement: true },
            { name: 'n', type: 'varchar', source: { database: 'app', table: 'people', column: 'name' }, primaryKeyPart: false, nullable: true },
          ],
          rows: [[1, 'Ana']],
        }),
      ],
    };
    const res = (await h.broker.query({ env: 'api/dev', sql: 'SELECT id, name AS n FROM people p' })) as any;
    expect(res.results[0].columns).toEqual([{ name: 'id', type: 'int' }, { name: 'n', type: 'varchar' }]);
    expect(JSON.stringify(res)).not.toMatch(/source|primaryKeyPart|autoIncrement|nullable/);

    h.executor.tree = {
      databases: [
        {
          name: 'app',
          tables: [{ name: 'people', type: 'table', columns: [{ name: 'up', type: 'varchar(9)', nullable: true, generated: 'virtual', onUpdate: true }] }],
        },
      ],
    };
    const schema = (await h.broker.schema({ env: 'api/dev', table: 'people' })) as any;
    expect(schema.databases[0].tables[0].columns).toEqual([{ name: 'up', type: 'varchar(9)', nullable: true }]);
  });
});
