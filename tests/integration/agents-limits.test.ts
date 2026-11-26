import type mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import { READ_HARD_CUT_MS } from '@shared/agents';
import type { MysqlEnvironment as Environment } from '@shared/model';
import { AgentBroker } from '@main/agents/broker';
import { AgentSessions } from '@main/agents/sessions';
import { mysqlDriver } from '@main/drivers/mysql';
import { FakeClock, flush, projects } from '../support/agent-fakes';
import { fixture, observer, params, rootConnection } from '../support/fixture';

// Agent limits, non-transactional tables and "each request runs in its own database", against a real MySQL.

let root: mysql.Connection;
let admin: mysql.Connection;
let clock: FakeClock;
let sessions: AgentSessions;
let broker: AgentBroker;
let envs: Environment[];
const q = (p: Parameters<AgentBroker['query']>[0]) => broker.query(p) as Promise<any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  root = await rootConnection();
  admin = await observer();
  await root.query('CREATE DATABASE IF NOT EXISTS other_db');
  await root.query('GRANT ALL ON other_db.* TO cais@"%"');
  for (const db of ['other_db', 'cais_test']) {
    await root.query(`DROP TABLE IF EXISTS ${db}.whoami`);
    await root.query(`CREATE TABLE ${db}.whoami (db VARCHAR(20))`);
    await root.query(`INSERT INTO ${db}.whoami VALUES ('${db}')`);
  }
  await root.query('DROP TABLE IF EXISTS cais_test.lim_legacy');
  await root.query('DROP TABLE IF EXISTS cais_test.lim_inno');
  await root.query('CREATE TABLE cais_test.lim_legacy (id INT PRIMARY KEY AUTO_INCREMENT, v VARCHAR(20)) ENGINE=MyISAM');
  await root.query('CREATE TABLE cais_test.lim_inno (id INT PRIMARY KEY AUTO_INCREMENT, v VARCHAR(20)) ENGINE=InnoDB');
  const f = fixture();
  const base: Environment = { id: 'e-dev', projectId: 'p-api', name: 'dev', engine: 'mysql', host: f.host, port: f.port, defaultDatabase: f.database, credentialId: 'c', production: false };
  envs = [base, { ...base, id: 'e-nodb', name: 'nodb', defaultDatabase: undefined }];
  clock = new FakeClock();
  sessions = new AgentSessions({
    getDriver: () => mysqlDriver, scheduler: clock, now: () => clock.now,
    resolveConnectParams: async (e) => params({ host: (e as Environment).host, port: (e as Environment).port, database: e.defaultDatabase }),
  });
  let n = 0;
  broker = new AgentBroker({
    now: () => clock.now, scheduler: clock, newId: () => `req_${++n}`,
    catalog: { projects: () => projects, environments: () => envs },
    scripts: { list: () => [], get: () => undefined, save: async () => { throw new Error('unused'); } },
    executor: sessions, audit: { append: () => undefined }, getDialect,
    onChange: () => undefined, onNewPending: () => undefined, onScriptsChanged: () => undefined,
  });
  broker.setEnabled(true);
});
afterAll(async () => {
  await broker.shutdown();
  await sessions.closeAll();
  await root.query('DROP DATABASE IF EXISTS other_db'); // keep the shared container as the other suites expect it
  await root.end();
  await admin.end();
});

describe('each request runs in exactly the database it asked for', () => {
  it('an environment with no default database never reuses the previous request\'s database', async () => {
    const a = await q({ env: 'api/nodb', sql: 'SELECT db FROM whoami', database: 'other_db' });
    expect(a.results[0].rows).toEqual([['other_db']]);
    const b = await q({ env: 'api/nodb', sql: 'SELECT DATABASE()' });
    expect(b.results[0].rows).toEqual([[null]]);
    const c = await q({ env: 'api/nodb', sql: 'SELECT db FROM whoami' });
    expect(c.status).toBe('failed'); // no database selected: the table is not found, not "found in other_db"
    const d = await q({ env: 'api/nodb', sql: 'SELECT db FROM whoami', database: 'cais_test' });
    expect(d.results[0].rows).toEqual([['cais_test']]);
  });

  it('with a default database a request without --database goes back to it', async () => {
    await q({ env: 'api/dev', sql: 'SELECT 1', database: 'other_db' });
    const r = await q({ env: 'api/dev', sql: 'SELECT db FROM whoami' });
    expect(r.results[0].rows).toEqual([['cais_test']]);
  });
});

describe('limits for agents', () => {
  it('reads carry max_execution_time 30 s; writes carry innodb_lock_wait_timeout 10 s', async () => {
    const r = await q({ env: 'api/dev', sql: 'SELECT @@max_execution_time' });
    expect(Number(r.results[0].rows[0][0])).toBe(30_000);
    const w = await q({ env: 'api/dev', sql: 'SELECT @@innodb_lock_wait_timeout', write: true, reason: 'x' });
    broker.approve(w.request_id, { shareResult: true });
    await broker.waitForStatus(w.request_id, (s) => s === 'awaiting_commit' || s === 'succeeded', 10_000);
    const st = ((await broker.status({ id: w.request_id })) as any);
    if (st.status === 'awaiting_commit') await broker.commit(w.request_id);
    expect(Number(((await broker.status({ id: w.request_id })) as any).results[0].rows[0][0])).toBe(10);
  });

  it('a stuck read is killed by the client-side cut, does not block the next reads, and the server query is gone', async () => {
    // SLEEP is refused for agents, so a heavy cross join stands in for a slow statement
    const slow = q({ env: 'api/dev', sql: 'SELECT COUNT(*) FROM information_schema.COLLATIONS a, information_schema.COLLATIONS b, information_schema.COLLATIONS c, information_schema.COLLATIONS d' });
    await sleep(300);
    const t0 = Date.now();
    const quick = await q({ env: 'api/dev', sql: 'SELECT 1' });
    expect(quick.status).toBe('succeeded');
    expect(Date.now() - t0).toBeLessThan(5000);
    await clock.advance(READ_HARD_CUT_MS);
    const out = await slow;
    expect(out).toMatchObject({ status: 'failed', error: { code: 'agent_timeout', message: 'Time limit for agents reached.' } });
    await sleep(300);
    const [rows] = await root.query("SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT COUNT(*) FROM information_schema.COLLATIONS a,%'");
    expect(Number((rows as any)[0].n)).toBe(0);
    expect((await q({ env: 'api/dev', sql: 'SELECT 2' })).status).toBe('succeeded');
  });

  it('a lock wait ends after 10 s of server time, not the default 50 s', async () => {
    await root.query("INSERT INTO cais_test.lim_inno (v) VALUES ('held')");
    await admin.query('START TRANSACTION');
    await admin.query("UPDATE cais_test.lim_inno SET v = 'held2' WHERE v = 'held'");
    const w = await q({ env: 'api/dev', sql: "UPDATE lim_inno SET v = 'x' WHERE v = 'held'", write: true, reason: 'x' });
    broker.approve(w.request_id, { shareResult: true });
    const t0 = Date.now();
    await broker.waitForStatus(w.request_id, (s) => s === 'failed', 30_000);
    const waited = Date.now() - t0;
    await admin.query('ROLLBACK');
    expect(waited).toBeGreaterThan(8000);
    expect(waited).toBeLessThan(20_000);
    expect(((await broker.status({ id: w.request_id })) as any).error.code).toBe('ER_LOCK_WAIT_TIMEOUT');
  }, 40_000);

  it('40 parallel schema calls open one connection and then come from the cache', async () => {
    let peak = 0;
    const poll = setInterval(async () => {
      const [r] = await root.query("SHOW STATUS LIKE 'Threads_connected'");
      peak = Math.max(peak, Number((r as any)[0].Value));
    }, 20);
    const [base] = await root.query("SHOW STATUS LIKE 'Threads_connected'");
    await Promise.all(Array.from({ length: 40 }, () => broker.schema({ env: 'api/dev' })));
    clearInterval(poll);
    expect(peak - Number((base as any)[0].Value)).toBeLessThanOrEqual(2);
    const [conns1] = await root.query("SHOW STATUS LIKE 'Connections'");
    await broker.schema({ env: 'api/dev' });
    const [conns2] = await root.query("SHOW STATUS LIKE 'Connections'");
    expect(Number((conns2 as any)[0].Value) - Number((conns1 as any)[0].Value)).toBeLessThanOrEqual(1); // only our probe
  });
});

describe('non-transactional tables', () => {
  it('the modal warns, and a Rollback that cannot undo the MyISAM write says so to the person and the agent', async () => {
    await sessions.environmentChanged('e-dev'); // fresh metadata
    const w = await q({ env: 'api/dev', sql: "INSERT INTO lim_legacy (v) VALUES ('stuck'); INSERT INTO lim_inno (v) VALUES ('undone')", write: true, reason: 'x' });
    const view = broker.snapshot().pending.find((p) => p.id === w.request_id)!;
    expect(view.warnings).toContain('A tabela lim_legacy não é transacional (MyISAM): o Rollback não desfaz o que for gravado nela.');
    // lim_inno itself is not flagged, and the test user (ALL on `cais\_test`.*, TRIGGER included) sees the triggers
    expect(view.warnings.join()).not.toContain('lim_inno');
    expect(view.warnings.some((w) => w.includes('privilégio TRIGGER'))).toBe(false);
    broker.approve(w.request_id, { shareResult: true });
    await broker.waitForStatus(w.request_id, (s) => s === 'awaiting_commit', 10_000);
    const done = await broker.rollback(w.request_id);
    expect(done.rollbackIncomplete).toBe(true);
    expect(((await broker.status({ id: w.request_id })) as any)).toMatchObject({ status: 'rolled_back', rollback_incomplete: true });
    const [legacy] = await root.query("SELECT COUNT(*) n FROM cais_test.lim_legacy WHERE v = 'stuck'");
    const [inno] = await root.query("SELECT COUNT(*) n FROM cais_test.lim_inno WHERE v = 'undone'");
    expect(Number((legacy as any)[0].n)).toBe(1); // MyISAM kept it
    expect(Number((inno as any)[0].n)).toBe(0); // InnoDB undid it
  });

  it('an InnoDB-only rollback is complete and raises no alert (the account sees the triggers)', async () => {
    const w = await q({ env: 'api/dev', sql: "INSERT INTO lim_inno (v) VALUES ('x')", write: true, reason: 'x' });
    const warnings = broker.snapshot().pending.find((p) => p.id === w.request_id)!.warnings;
    expect(warnings).toEqual([]);
    broker.approve(w.request_id, { shareResult: true });
    await broker.waitForStatus(w.request_id, (s) => s === 'awaiting_commit', 10_000);
    await broker.rollback(w.request_id);
    expect(((await broker.status({ id: w.request_id })) as any).rollback_incomplete).toBeUndefined();
    await flush();
  });
});
