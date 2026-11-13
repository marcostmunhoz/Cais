import type mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import { ROLLBACK_AFTER_MS } from '@shared/agents';
import type { Environment } from '@shared/model';
import { AgentBroker } from '@main/agents/broker';
import { AgentSessions } from '@main/agents/sessions';
import { mysqlDriver } from '@main/drivers/mysql';
import { FakeClock, projects } from '../support/agent-fakes';
import { fixture, observer, params } from '../support/fixture';

let admin: mysql.Connection;
let clock: FakeClock;
let sessions: AgentSessions;
let broker: AgentBroker;
let dev: Environment;
let pro: Environment;
let deadPort: Environment;
const audit: unknown[] = [];

const count = async (where = '1=1'): Promise<number> => {
  const [rows] = await admin.query(`SELECT COUNT(*) AS n FROM ag_items WHERE ${where}`);
  return Number((rows as { n: number }[])[0]!.n);
};
const q = (p: Parameters<AgentBroker['query']>[0]) => broker.query(p) as Promise<any>;
const approveWrite = async (sql: string, share = true) => {
  const res = await q({ env: 'api/dev', sql, write: true, reason: 'teste' });
  expect(res.status).toBe('pending_approval');
  broker.approve(res.request_id, { shareResult: share });
  await broker.waitForStatus(res.request_id, (s) => s !== 'pending_approval' && s !== 'running', 15_000);
  return res.request_id as string;
};

beforeAll(async () => {
  admin = await observer();
  await admin.query('CREATE TABLE ag_items (id INT PRIMARY KEY AUTO_INCREMENT, label VARCHAR(40) UNIQUE, n INT DEFAULT 0)');
  await admin.query("INSERT INTO ag_items (label, n) VALUES ('base-1', 1), ('base-2', 2)");
  const f = fixture();
  const base: Environment = { id: 'e-dev', projectId: 'p-api', name: 'dev', engine: 'mysql', host: f.host, port: f.port, defaultDatabase: f.database, credentialId: 'c', production: false };
  dev = base;
  pro = { ...base, id: 'e-pro', name: 'pro', production: true };
  deadPort = { ...base, id: 'e-dead', name: 'hml', port: 1 }; // nothing listens there
  clock = new FakeClock();
  sessions = new AgentSessions({ getDriver: () => mysqlDriver, getDialect, resolveConnectParams: async (e) => params({ host: e.host, port: e.port }), scheduler: clock });
  let seq = 0;
  broker = new AgentBroker({
    now: () => clock.now,
    scheduler: clock,
    newId: () => `req_${++seq}`,
    catalog: { projects: () => projects, environments: () => [dev, pro, deadPort] },
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

afterAll(async () => {
  await broker.shutdown();
  await sessions.closeAll();
  await admin.end();
});

describe('agent reads against MySQL', () => {
  it('outside production they run at once and return the rows', async () => {
    const res = await q({ env: 'api/dev', sql: 'SELECT label, n FROM ag_items ORDER BY id' });
    expect(res.status).toBe('succeeded');
    expect(res.results[0].columns.map((c: { name: string }) => c.name)).toEqual(['label', 'n']);
    expect(res.results[0].rows).toEqual([['base-1', 1], ['base-2', 2]]);
  });

  it('in production they wait for the click, then run in a read-only session', async () => {
    const res = await q({ env: 'api/pro', sql: 'SELECT COUNT(*) AS n FROM ag_items', reason: 'conferir' });
    expect(res.status).toBe('pending_approval');
    broker.approve(res.request_id, { shareResult: true });
    await broker.waitForStatus(res.request_id, (s) => s === 'succeeded', 10_000);
    const done = (await broker.status({ id: res.request_id })) as any;
    expect(Number(done.results[0].rows[0][0])).toBe(2);
  });

  it('the agents read session is read-only at the server even if the policy were bypassed', async () => {
    const out = await sessions.runRead(dev, { statements: [{ text: "INSERT INTO ag_items (label) VALUES ('bypass')" }], maxRows: 10 });
    expect(out.error?.code).toBe('ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION');
    expect(await count("label = 'bypass'")).toBe(0);
    // and a statement that tries to switch the protection off is refused by the classifier before it leaves
    await expect(q({ env: 'api/dev', sql: 'SET SESSION transaction_read_only = 0' })).rejects.toMatchObject({ code: 'ddl_or_transaction' });
  });

  it('refuses INTO OUTFILE, lock reads, writes and DDL before anything is sent', async () => {
    for (const sql of ["SELECT 1 INTO OUTFILE '/tmp/cais-agent'", 'SELECT * FROM ag_items FOR UPDATE', "UPDATE ag_items SET n = 9 WHERE id = 1", 'CREATE TABLE ag_x (a INT)']) {
      await expect(q({ env: 'api/dev', sql, reason: 'x' })).rejects.toMatchObject({ name: 'AgentError' });
    }
    const [tables] = await admin.query("SHOW TABLES LIKE 'ag_x'");
    expect((tables as unknown[]).length).toBe(0);
  });

  it('an SQL error comes back as failed with the server code', async () => {
    const res = await q({ env: 'api/dev', sql: 'SELECT * FROM table_that_is_not_there' });
    expect(res).toMatchObject({ status: 'failed', error: { code: 'ER_NO_SUCH_TABLE' } });
  });

  it('a connection failure reaches the agent without the address', async () => {
    const res = await q({ env: 'api/hml', sql: 'SELECT 1' });
    expect(res.status).toBe('failed');
    expect(res.error.code).toBe('connection_failed');
    expect(JSON.stringify(res)).not.toMatch(/127\.0\.0\.1/);
  });

  it('schema returns metadata straight away', async () => {
    const out = (await broker.schema({ env: 'api/pro', table: 'ag_items' })) as any;
    expect(out.databases[0].tables[0].columns.map((c: { name: string }) => c.name)).toEqual(['id', 'label', 'n']);
  });
});

describe('agent writes against MySQL', () => {
  it('approved: runs in a transaction, a second connection does not see it until Commit', async () => {
    const id = await approveWrite("INSERT INTO ag_items (label, n) VALUES ('w-commit', 7)");
    expect(((await broker.status({ id })) as any).status).toBe('awaiting_commit');
    expect(await count("label = 'w-commit'")).toBe(0); // other connection: not committed yet
    expect(broker.snapshot().awaitingCommit[0]!.statements[0]).toMatchObject({ verb: 'INSERT', affectedRows: 1 });
    await broker.commit(id);
    const res = (await broker.status({ id })) as any;
    expect(res).toMatchObject({ status: 'committed', decided_by: 'person', auto_commit: false });
    expect(res.results[0].affected_rows).toBe(1);
    expect(await count("label = 'w-commit'")).toBe(1);
  });

  it('Rollback leaves no trace', async () => {
    const id = await approveWrite("UPDATE ag_items SET n = 99 WHERE label = 'base-1'");
    await broker.rollback(id);
    expect((await broker.status({ id })) as any).toMatchObject({ status: 'rolled_back', decided_by: 'person' });
    expect(await count('n = 99')).toBe(0);
  });

  it('rolls back by time (120 s on the fake clock) and the row never appears', async () => {
    const id = await approveWrite("INSERT INTO ag_items (label) VALUES ('w-timeout')");
    expect(((await broker.status({ id })) as any).status).toBe('awaiting_commit');
    await clock.advance(ROLLBACK_AFTER_MS);
    await broker.waitForStatus(id, (s) => s === 'rolled_back', 10_000);
    const res = (await broker.status({ id })) as any;
    expect(res).toMatchObject({ status: 'rolled_back', rollback_reason: 'timeout' });
    expect(await count("label = 'w-timeout'")).toBe(0);
    await expect(broker.commit(id)).rejects.toThrow('não está mais nesse estado');
  });

  it('an error in the middle undoes everything the request did', async () => {
    const id = await approveWrite("INSERT INTO ag_items (label) VALUES ('w-mid-ok'); INSERT INTO ag_items (label) VALUES ('base-1')");
    const res = (await broker.status({ id })) as any;
    expect(res.status).toBe('failed');
    expect(res.error.code).toBe('ER_DUP_ENTRY');
    expect(await count("label = 'w-mid-ok'")).toBe(0);
    expect(broker.snapshot().awaitingCommit).toHaveLength(0);
  });

  it('a write holds its locks only until the decision: after Rollback another connection can update the same row', async () => {
    const id = await approveWrite("UPDATE ag_items SET n = 55 WHERE label = 'base-2'");
    await broker.rollback(id);
    await admin.query("UPDATE ag_items SET n = 2 WHERE label = 'base-2'"); // would time out if the lock were still held
    expect(await count('n = 55')).toBe(0);
  });

  it('DDL and transaction control never run, in write mode either', async () => {
    for (const sql of ['DROP TABLE ag_items', 'COMMIT', 'BEGIN', 'SET autocommit = 1', 'TRUNCATE ag_items']) {
      await expect(q({ env: 'api/dev', sql, write: true, reason: 'x' })).rejects.toMatchObject({ code: 'ddl_or_transaction' });
    }
    expect(await count()).toBeGreaterThan(0);
  });

  it('withheld result: the write still reports affected rows, nothing else', async () => {
    const id = await approveWrite("UPDATE ag_items SET n = n WHERE label = 'base-1'", false);
    await broker.commit(id);
    const res = (await broker.status({ id })) as any;
    expect(res.result_withheld).toBe(true);
    expect(res.results[0]).toMatchObject({ verb: 'UPDATE' });
    expect(res.results[0].rows).toBeUndefined();
  });

  it('app shutdown rolls back an open agent transaction', async () => {
    const res = await q({ env: 'api/dev', sql: "INSERT INTO ag_items (label) VALUES ('w-quit')", write: true, reason: 'x' });
    broker.approve(res.request_id, { shareResult: true });
    await broker.waitForStatus(res.request_id, (s) => s === 'awaiting_commit', 10_000);
    await broker.shutdown();
    expect(await count("label = 'w-quit'")).toBe(0);
    expect(audit.at(-1)).toMatchObject({ state: 'rolled_back', rollbackReason: 'shutdown' });
  });
});
