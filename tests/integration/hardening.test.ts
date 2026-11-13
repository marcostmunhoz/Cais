import { execFileSync } from 'node:child_process';
import type mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import type { Environment } from '@shared/model';
import { mysqlDriver } from '@main/drivers/mysql';
import type { DbSession } from '@main/drivers/types';
import { SessionManager } from '@main/sessions';
import { fixture, observer, params, rootConnection } from '../support/fixture';

let admin: mysql.Connection;
let root: mysql.Connection;
const opened: DbSession[] = [];
const race = <T>(p: Promise<T>, ms: number): Promise<T | 'HANG'> =>
  Promise.race([p, new Promise<'HANG'>((r) => setTimeout(() => r('HANG'), ms))]);

async function open(mode?: 'read-only' | 'transaction' | 'autocommit'): Promise<DbSession> {
  const s = await mysqlDriver.open(params());
  opened.push(s);
  if (mode) await s.applyMode(mode);
  return s;
}
const scalar = async (sql: string): Promise<unknown> => {
  const [rows] = await admin.query(sql);
  return Object.values((rows as Record<string, unknown>[])[0]!)[0];
};
const fileExists = (path: string): boolean => {
  try {
    execFileSync('docker', ['exec', fixture().name, 'test', '-e', path]);
    return true;
  } catch {
    return false;
  }
};

let manager: SessionManager;
const run = (tab: string, sql: string, extra = {}) => manager.run(tab, { sql, scope: 'all', cursor: 0, maxRows: 1000, ...extra });

beforeAll(async () => {
  admin = await observer();
  root = await rootConnection();
  await root.query('SET GLOBAL log_bin_trust_function_creators = 1');
  await root.query('SET SESSION cte_max_recursion_depth = 200000');
  await admin.query('CREATE TABLE hv (id INT PRIMARY KEY, v INT)');
  await admin.query('INSERT INTO hv VALUES (1, 1), (2, 2)');
  await root.query('CREATE FUNCTION cais_test.fw() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN UPDATE hv SET v = 88; RETURN 1; END');
  await admin.query('CREATE TABLE tx_t (id INT PRIMARY KEY AUTO_INCREMENT, n INT)');
  await admin.query('CREATE TABLE big2 (n INT PRIMARY KEY)');
  await root.query('INSERT INTO cais_test.big2 WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 100000) SELECT n FROM s');
  const f = fixture();
  const base: Environment = { id: 'dev', projectId: 'p', name: 'dev', engine: 'mysql', host: f.host, port: f.port, credentialId: 'c', production: false };
  manager = new SessionManager({
    getEnvironment: (id) => (id === 'dev' ? base : id === 'pro' ? { ...base, id: 'pro', production: true } : undefined),
    resolveConnectParams: async () => params(),
    getDriver: () => mysqlDriver,
    getDialect,
    emit: () => undefined,
    now: () => Date.now(),
  });
});

afterAll(async () => {
  await manager?.closeAll();
  await Promise.all(opened.map((s) => s.close().catch(() => undefined)));
  await admin?.end();
  await root?.end();
});

describe('read-only cannot be switched off', () => {
  it('SET NAMES x, @@session.transaction_read_only = 0 is refused by the app and fw() then cannot write', async () => {
    await admin.query('UPDATE hv SET v = id');
    await manager.open('ro1', 'pro');
    const trick = await run('ro1', 'SET NAMES utf8mb4, @@session.transaction_read_only = 0');
    expect(trick.results[0]!.error?.code).toBe('REFUSED');
    const call = await run('ro1', 'SELECT fw()');
    expect(call.results[0]!.error?.errno).toBe(1792);
    expect(await scalar('SELECT GROUP_CONCAT(v ORDER BY id) FROM hv')).toBe('1,2');
    await manager.close('ro1');
  });

  it('the driver re-asserts read-only before every statement, even if the session was switched off', async () => {
    await admin.query('UPDATE hv SET v = id');
    const s = await open('read-only');
    // bypass the app on purpose: straight to the driver
    await s.execute('SET SESSION transaction_read_only = 0', { maxRows: 10 });
    const call = await s.execute('SELECT fw()', { maxRows: 10 });
    expect(call.error?.errno).toBe(1792);
    expect(await scalar('SELECT GROUP_CONCAT(v ORDER BY id) FROM hv')).toBe('1,2');
    const ro = await s.execute('SELECT @@session.transaction_read_only, @@session.autocommit', { maxRows: 10 });
    expect(ro.rows).toEqual([['1', '1']]);
  });

  it('a read-only tab keeps writing impossible after other statements', async () => {
    await manager.open('ro2', 'pro');
    for (const sql of ['SELECT 1', "SET @x = 1", 'SHOW TABLES', 'EXPLAIN SELECT 1']) {
      expect((await run('ro2', sql)).results[0]!.error, sql).toBeUndefined();
    }
    // MySQL refuses EXPLAIN of a write in a read-only session (1792), so the app refuses it up front
    const plan = (await run('ro2', 'EXPLAIN UPDATE hv SET v = 5')).results[0]!;
    expect(plan.error?.code).toBe('REFUSED');
    expect(plan.error?.message).toContain('EXPLAIN de comando de escrita');
    expect(await scalar('SELECT GROUP_CONCAT(v ORDER BY id) FROM hv')).toBe('1,2');
    await manager.close('ro2');
  });
});

describe('INTO DUMPFILE / OUTFILE and locking reads never leave the app in read-only', () => {
  const dir = '/var/lib/mysql-files';
  const refused = [
    `SELECT 1 INTO DUMPFILE '${dir}/h1.txt'`,
    `SELECT 1.INTO DUMPFILE '${dir}/h2.txt'`,
    `SELECT 1 FROM hv WHERE id=1.INTO DUMPFILE '${dir}/h3.txt'`,
    `SELECT 1 INTO/**/OUTFILE '${dir}/h4.txt'`,
    `SELECT 1 FROM hv WHERE 1 -- x INTO DUMPFILE '${dir}/h5.txt'`,
    `select * from hv where id=1 into outfile '${dir}/h6.txt'`,
    `SELECT 1 FROM hv WHERE id=1 /*!50000 INTO DUMPFILE '${dir}/h7.txt' */`,
  ];
  it('refuses every variant and no file is created', async () => {
    await manager.open('dump', 'pro');
    for (const sql of refused) {
      const r = await run('dump', sql);
      expect(r.results[0]!.error?.code, sql).toBe('REFUSED');
    }
    for (let i = 1; i <= 7; i++) expect(fileExists(`${dir}/h${i}.txt`)).toBe(false);
    await manager.close('dump');
  });

  it('refuses locking reads in every spelling', async () => {
    await manager.open('lock', 'pro');
    for (const sql of [
      'SELECT * FROM hv WHERE id=1 FOR UPDATE NOWAIT',
      'SELECT * FROM hv WHERE id=1 FOR\n\tUPDATE   nowait',
      'SELECT * FROM hv WHERE id=1 for share skip locked',
      'SELECT * FROM hv WHERE id=1 LOCK IN SHARE MODE',
      'SELECT * FROM hv WHERE id=1.FOR UPDATE',
      'SELECT * FROM hv WHERE id=.5FOR UPDATE',
      'SELECT * FROM hv WHERE id=1e0FOR UPDATE',
      'SET @x = (SELECT id FROM hv WHERE id=1 LOCK IN SHARE MODE)',
    ]) {
      expect((await run('lock', sql)).results[0]!.error?.code, sql).toBe('REFUSED');
    }
    await manager.close('lock');
  });

  it('what the app allows really is harmless on the server (no data change, still read-only)', async () => {
    await manager.open('ok', 'pro');
    // executable comments are refused in read-only: the server may skip their content, so they cannot be classified
    expect((await run('ok', '/*!50000 SELECT 1 */')).results[0]!.error?.code).toBe('REFUSED');
    for (const sql of [
      "/*+ SET_VAR(sql_mode='') */ SELECT 1",
      'SELECT 1 INTO @v',
      'WITH RECURSIVE c AS (SELECT 1 n UNION ALL SELECT n+1 FROM c WHERE n<3) SELECT * FROM c',
      'SET @x := (SELECT COUNT(*) FROM hv)',
      'SET NAMES utf8mb4',
      'SET CHARACTER SET utf8mb4',
      'SELECT @@session.transaction_read_only',
    ]) {
      expect((await run('ok', sql)).results[0]!.error, sql).toBeUndefined();
    }
    expect((await run('ok', 'SELECT @@session.transaction_read_only')).results[0]!.rows).toEqual([['1']]);
    await manager.close('ok');
  });
});

describe('transaction state comes from SERVER_STATUS_IN_TRANS', () => {
  const count = async (n: number) => Number(await scalar(`SELECT COUNT(*) FROM tx_t WHERE n = ${n}`));
  const exec = (s: DbSession, sql: string) => s.execute(sql, { maxRows: 100 });

  it('INSERT opens; typed COMMIT and ROLLBACK close', async () => {
    const s = await open('transaction');
    expect((await exec(s, 'INSERT INTO tx_t (n) VALUES (101)')).inTransaction).toBe(true);
    expect(await count(101)).toBe(0);
    expect((await exec(s, 'COMMIT')).inTransaction).toBe(false);
    expect(await count(101)).toBe(1);
    expect((await exec(s, 'INSERT INTO tx_t (n) VALUES (102)')).inTransaction).toBe(true);
    expect((await exec(s, 'ROLLBACK')).inTransaction).toBe(false);
    expect(await count(102)).toBe(0);
  });

  it('a SELECT of a table opens one, a SELECT without tables does not', async () => {
    const s = await open('transaction');
    expect((await exec(s, 'SELECT 1')).inTransaction).toBe(false);
    expect((await exec(s, 'SELECT COUNT(*) FROM tx_t')).inTransaction).toBe(true);
    await s.rollback();
    expect((await exec(s, 'SELECT 1')).inTransaction).toBe(false);
  });

  it('a failing DDL after an INSERT: the server committed, the flag is closed (errno 1050)', async () => {
    const s = await open('transaction');
    await exec(s, 'INSERT INTO tx_t (n) VALUES (103)');
    const r = await exec(s, 'CREATE TABLE tx_t (a INT)');
    expect(r.error?.errno).toBe(1050);
    expect(r.inTransaction).toBe(false);
    expect(await count(103)).toBe(1);
  });

  it('CREATE / DROP TEMPORARY TABLE do not commit: still open', async () => {
    const s = await open('transaction');
    await exec(s, 'INSERT INTO tx_t (n) VALUES (104)');
    expect((await exec(s, 'CREATE TEMPORARY TABLE tmp_h (a INT)')).inTransaction).toBe(true);
    expect((await exec(s, 'DROP TEMPORARY TABLE tmp_h')).inTransaction).toBe(true);
    expect(await count(104)).toBe(0);
    await s.rollback();
  });

  it('SET PASSWORD commits implicitly: closed', async () => {
    const s = await open('transaction');
    await exec(s, 'INSERT INTO tx_t (n) VALUES (105)');
    const r = await exec(s, `SET PASSWORD = '${fixture().password}'`);
    expect(r.error).toBeUndefined();
    expect(r.inTransaction).toBe(false);
    expect(await count(105)).toBe(1);
  });

  it('a cancelled long SELECT on an InnoDB table leaves the transaction open and holding its metadata lock', async () => {
    const s = await open('transaction');
    const pending = exec(s, 'SELECT SUM(a.n * b.n) FROM big2 a, big2 b');
    await new Promise((r) => setTimeout(r, 500));
    await s.cancel();
    const r = await pending;
    expect(r.error?.message).toBe('Query cancelada.');
    expect(r.inTransaction).toBe(true);
    await admin.query('SET SESSION lock_wait_timeout = 2');
    const alter = await admin.query('ALTER TABLE big2 ADD COLUMN zz INT').then(() => 'ok', (e: Error) => e.message);
    expect(alter).toContain('Lock wait timeout');
    await s.rollback();
    await admin.query('ALTER TABLE big2 ADD COLUMN zz INT');
    await admin.query('ALTER TABLE big2 DROP COLUMN zz');
  });

  it('autocommit and read-only sessions do not pay for the probe (flag not reported)', async () => {
    const s = await open('autocommit');
    expect((await exec(s, 'INSERT INTO tx_t (n) VALUES (106)')).inTransaction).toBeUndefined();
  });

  it('SessionManager: counter and state follow the server through the whole sequence', async () => {
    await manager.open('seq', 'dev');
    await manager.setMode('seq', 'transaction');
    const one = await run('seq', 'SELECT 1');
    expect(one.session.transaction.open).toBe(false);
    const ins = await run('seq', 'INSERT INTO tx_t (n) VALUES (107)');
    expect(ins.session.transaction).toMatchObject({ open: true, statements: 1 });
    const tmp = await run('seq', 'CREATE TEMPORARY TABLE tmp_seq (a INT)');
    expect(tmp.needsConfirmation).toBeUndefined(); // no implicit commit warning
    expect(tmp.session.transaction).toMatchObject({ open: true, statements: 2 });
    const bad = await run('seq', 'SELECT * FROM does_not_exist');
    expect(bad.results[0]!.error).toBeDefined();
    expect(bad.session.transaction).toMatchObject({ open: true, statements: 3 });
    const ddl = await run('seq', 'CREATE TABLE tx_t (a INT)', { confirmed: true });
    expect(ddl.results[0]!.error?.errno).toBe(1050);
    expect(ddl.session.transaction.open).toBe(false);
    expect(await count(107)).toBe(1);
    await manager.close('seq');
  });
});

describe('dropped connections never hang', () => {
  it('COMMIT RELEASE sent straight to the driver: the next statement rejects instead of hanging', async () => {
    const s = await open();
    let fatal = 0;
    s.onFatalError(() => fatal++);
    await s.execute('COMMIT RELEASE', { maxRows: 10 });
    const r = await race(s.execute('SELECT 1', { maxRows: 10 }), 8000);
    expect(r).not.toBe('HANG');
    expect((r as { error?: { fatal?: boolean } }).error?.fatal).toBe(true);
    expect(fatal).toBeGreaterThan(0);
  });

  it('a connection killed mid-query ends the statement with a fatal error', async () => {
    const s = await open();
    const id = (await s.execute('SELECT CONNECTION_ID()', { maxRows: 10 })).rows![0]![0];
    const pending = s.execute('SELECT SLEEP(20)', { maxRows: 10 });
    await new Promise((r) => setTimeout(r, 300));
    await admin.query(`KILL ${id}`);
    const r = await race(pending, 8000);
    expect(r).not.toBe('HANG');
    expect((r as { error?: { fatal?: boolean } }).error?.fatal).toBe(true);
  });

  it('the app refuses COMMIT RELEASE in every mode', async () => {
    await manager.open('rel', 'dev');
    const r = await run('rel', 'COMMIT RELEASE');
    expect(r.results[0]!.error?.code).toBe('REFUSED');
    expect(manager.state('rel').status).toBe('idle');
    await manager.close('rel');
  });
});

describe('cancel / row cap KILL never hits the next statement', () => {
  it('40 runs of a capped read followed by two statements see no stray "Query cancelada"', async () => {
    await manager.open('kill', 'dev');
    for (let i = 0; i < 40; i++) {
      const r = await run('kill', 'SELECT * FROM big2 LIMIT 1002; SELECT SLEEP(0.05); SELECT 3');
      const errors = r.results.filter((x) => x.error).map((x) => x.error!.message);
      expect(errors, `iteration ${i}`).toEqual([]);
      expect(r.results).toHaveLength(3);
    }
    await manager.close('kill');
  }, 120000);
});

describe('the mode survives a reconnect', () => {
  it('a Transação tab that lost its connection reconnects in Transação: nothing is autocommitted', async () => {
    await manager.open('mode', 'dev');
    await manager.setMode('mode', 'transaction');
    await run('mode', 'INSERT INTO tx_t (n) VALUES (201)');
    const id = (await run('mode', 'SELECT CONNECTION_ID()')).results[0]!.rows![0]![0];
    await admin.query(`KILL ${id}`);
    await new Promise((r) => setTimeout(r, 500));
    const lost = manager.state('mode');
    expect(lost.status).toBe('error');
    expect(lost.notice).toBe('A conexão caiu e o servidor desfez a transação aberta (2 comandos).');
    const again = await manager.open('mode', 'dev');
    expect(again.mode).toBe('transaction');
    await run('mode', 'INSERT INTO tx_t (n) VALUES (202)');
    expect(Number(await scalar('SELECT COUNT(*) FROM tx_t WHERE n IN (201, 202)'))).toBe(0);
    await manager.rollback('mode');
    await manager.close('mode');
  });

  it('a production tab stays read-only after reconnecting', async () => {
    await manager.open('pmode', 'pro');
    const id = (await run('pmode', 'SELECT CONNECTION_ID()')).results[0]!.rows![0]![0];
    await admin.query(`KILL ${id}`);
    await new Promise((r) => setTimeout(r, 500));
    const again = await manager.open('pmode', 'pro');
    expect(again.mode).toBe('read-only');
    const w = await run('pmode', "INSERT INTO tx_t (n) VALUES (203)");
    expect(w.results[0]!.error?.code).toBe('REFUSED');
    await manager.close('pmode');
  });
});
