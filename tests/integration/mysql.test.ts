import { createServer } from 'node:net';
import type mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import type { Environment } from '@shared/model';
import type { SessionState } from '@shared/results';
import { mysqlDriver } from '@main/drivers/mysql';
import type { DbSession } from '@main/drivers/types';
import { SessionManager } from '@main/sessions';
import { fixture, observer, params } from '../support/fixture';

let admin: mysql.Connection;
const opened: DbSession[] = [];

async function open(overrides = {}): Promise<DbSession> {
  const s = await mysqlDriver.open(params(overrides));
  opened.push(s);
  return s;
}

beforeAll(async () => {
  admin = await observer();
  await admin.query('SET SESSION cte_max_recursion_depth = 200000');
  await admin.query('CREATE TABLE people (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50) NOT NULL, email VARCHAR(80) UNIQUE, note TEXT)');
  await admin.query("INSERT INTO people (name, email) VALUES ('Ana', 'ana@x.com'), ('Bia', 'bia@x.com'), ('Caio', NULL)");
  await admin.query('CREATE TABLE big (n INT PRIMARY KEY)');
  await admin.query('INSERT INTO big WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 100000) SELECT n FROM s');
  await admin.query('CREATE VIEW people_names AS SELECT name FROM people');
  await admin.query(
    'CREATE TABLE kinds (id BIGINT UNSIGNED, price DECIMAL(10,2), at DATETIME, d DATE, doc JSON, bin VARBINARY(600), flag BIT(1), f DOUBLE, txt TEXT)',
  );
  await admin.query(
    `INSERT INTO kinds VALUES (18446744073709551615, 12345.60, '2026-11-11 10:20:30', '2026-11-11', '{"a": [1, 2]}', REPEAT(0x41, 600), b'1', 1.5, NULL)`,
  );
});

afterAll(async () => {
  await Promise.all(opened.map((s) => s.close().catch(() => undefined)));
  await admin?.end();
});

describe('connection', () => {
  it('logs in with caching_sha2_password, without and with TLS', async () => {
    const plain = await mysqlDriver.test(params());
    expect(plain.serverVersion).toMatch(/^8\.4/);
    const tls = await mysqlDriver.test(params({ tls: 'required' }));
    expect(tls.serverVersion).toMatch(/^8\.4/);
  });

  it('maps a refused connection to the VPN hint', async () => {
    const free = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => resolve(port));
      });
    });
    const error = await mysqlDriver.test(params({ port: free })).catch((e) => e);
    expect(error.message).toBe(`Sem resposta de 127.0.0.1:${free}. A VPN está ligada?`);
    expect(error.info.code).toBe('ECONNREFUSED');
  });

  it('maps wrong credentials', async () => {
    const error = await mysqlDriver.test(params({ password: 'wrong' })).catch((e) => e);
    expect(error.message).toBe('Usuário ou senha recusados.');
    expect(error.info.errno).toBe(1045);
    expect(error.info.detail).toContain('Access denied');
  });
});

describe('execution', () => {
  it('returns rows with typed columns', async () => {
    const s = await open();
    const r = await s.execute('SELECT id, name, email FROM people ORDER BY id', { maxRows: 1000 });
    expect(r.error).toBeUndefined();
    const db = fixture().database;
    expect(r.columns).toEqual([
      { name: 'id', type: 'int', source: { database: db, table: 'people', column: 'id', alias: 'people' }, primaryKeyPart: true, nullable: false, autoIncrement: true },
      { name: 'name', type: 'varchar', source: { database: db, table: 'people', column: 'name', alias: 'people' }, primaryKeyPart: false, nullable: false, autoIncrement: false },
      { name: 'email', type: 'varchar', source: { database: db, table: 'people', column: 'email', alias: 'people' }, primaryKeyPart: false, nullable: true, autoIncrement: false },
    ]);
    expect(r.rows).toEqual([
      [1, 'Ana', 'ana@x.com'],
      [2, 'Bia', 'bia@x.com'],
      [3, 'Caio', null],
    ]);
    expect(r.truncated).toBeUndefined();
  });

  it('maps value types: big numbers, decimals, dates, JSON as text, binary as hex, NULL', async () => {
    const s = await open();
    const r = await s.execute('SELECT * FROM kinds', { maxRows: 10 });
    expect(r.error).toBeUndefined();
    const row = r.rows![0]!;
    expect(row[0]).toBe('18446744073709551615');
    expect(row[1]).toBe('12345.60');
    expect(row[2]).toBe('2026-11-11 10:20:30');
    expect(row[3]).toBe('2026-11-11');
    expect(typeof row[4]).toBe('string');
    expect(JSON.parse(row[4] as string)).toEqual({ a: [1, 2] });
    const bin = row[5] as { kind: string; hex: string; length: number };
    expect(bin).toMatchObject({ kind: 'binary', length: 600 });
    expect(bin.hex).toHaveLength(512);
    expect(row[6]).toEqual({ kind: 'binary', hex: '01', length: 1 });
    expect(row[7]).toBe(1.5);
    expect(row[8]).toBeNull();
    expect(r.columns!.map((c) => c.type)).toEqual([
      'bigint', 'decimal', 'datetime', 'date', 'json', 'varbinary', 'bit', 'double', 'text',
    ]);
  });

  it('truncates with sql_select_limit and flags it', async () => {
    const s = await open();
    const r = await s.execute('SELECT * FROM big', { maxRows: 1000 });
    expect(r.rows).toHaveLength(1000);
    expect(r.truncated).toBe(true);
    const more = await s.execute('SELECT * FROM big', { maxRows: 5000 });
    expect(more.rows).toHaveLength(5000);
    expect(more.truncated).toBe(true);
    const small = await s.execute('SELECT * FROM people', { maxRows: 1000 });
    expect(small.truncated).toBeUndefined();
  });

  it('does not truncate when the result has exactly maxRows rows', async () => {
    const s = await open();
    const r = await s.execute('SELECT * FROM big LIMIT 1000', { maxRows: 1000 });
    expect(r.rows).toHaveLength(1000);
    expect(r.truncated).toBeUndefined();
  });

  it('stops an explicit huge LIMIT by killing the query, and the session stays usable', async () => {
    const s = await open();
    const started = Date.now();
    const r = await s.execute('SELECT * FROM big LIMIT 100000', { maxRows: 1000 });
    expect(r.error).toBeUndefined();
    expect(r.rows).toHaveLength(1000);
    expect(r.truncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(10000);
    const next = await s.execute('SELECT 1', { maxRows: 1000 });
    expect(next.rows).toEqual([['1']]);
    expect(next.error).toBeUndefined();
  });

  it('reports affected rows and insert ids', async () => {
    const s = await open();
    const ins = await s.execute("INSERT INTO people (name) VALUES ('Dani'), ('Edu')", { maxRows: 1000 });
    expect(ins.affectedRows).toBe(2);
    expect(Number(ins.insertId)).toBeGreaterThan(3);
    const upd = await s.execute("UPDATE people SET note = 'x' WHERE name IN ('Dani', 'Edu')", { maxRows: 1000 });
    expect(upd.affectedRows).toBe(2);
    await s.execute("DELETE FROM people WHERE name IN ('Dani', 'Edu')", { maxRows: 1000 });
  });

  it('returns SQL errors as results, keeping code and original message', async () => {
    const s = await open();
    const r = await s.execute('SELECT * FROM nope', { maxRows: 10 });
    expect(r.error).toMatchObject({ code: 'ER_NO_SUCH_TABLE', errno: 1146, sqlState: '42S02' });
    expect(r.error!.message).toContain("doesn't exist");
    const ok = await s.execute('SELECT 1', { maxRows: 10 });
    expect(ok.error).toBeUndefined();
  });

  it('reports the current database', async () => {
    const s = await open();
    expect(await s.currentDatabase()).toBe(fixture().database);
    await s.execute('USE `information_schema`', { maxRows: 1 });
    expect(await s.currentDatabase()).toBe('information_schema');
  });
});

describe('modes and transactions', () => {
  it('read-only is enforced by the server (second layer), calling the driver directly', async () => {
    const s = await open();
    await s.applyMode('read-only');
    const r = await s.execute("INSERT INTO people (name) VALUES ('Intruso')", { maxRows: 10 });
    expect(r.error?.errno).toBe(1792);
    expect(r.error?.message).toBe('A sessão está em somente leitura.');
    const [rows] = await admin.query("SELECT COUNT(*) AS c FROM people WHERE name = 'Intruso'");
    expect((rows as { c: number }[])[0]!.c).toBe(0);
    const read = await s.execute('SELECT COUNT(*) FROM people', { maxRows: 10 });
    expect(read.error).toBeUndefined();
  });

  it('transaction mode: rollback and commit are seen from a second connection', async () => {
    const s = await open();
    await s.applyMode('transaction');
    await s.execute("INSERT INTO people (name) VALUES ('Tx1')", { maxRows: 10 });
    const count = async () => {
      const [rows] = await admin.query("SELECT COUNT(*) AS c FROM people WHERE name = 'Tx1'");
      return (rows as { c: number }[])[0]!.c;
    };
    expect(await count()).toBe(0); // not visible before commit
    await s.rollback();
    expect(await count()).toBe(0);
    await s.execute("INSERT INTO people (name) VALUES ('Tx1')", { maxRows: 10 });
    await s.commit();
    expect(await count()).toBe(1);
    await admin.query("DELETE FROM people WHERE name = 'Tx1'");
  });

  it('autocommit mode commits each statement', async () => {
    const s = await open();
    await s.applyMode('autocommit');
    await s.execute("INSERT INTO people (name) VALUES ('Auto1')", { maxRows: 10 });
    const [rows] = await admin.query("SELECT COUNT(*) AS c FROM people WHERE name = 'Auto1'");
    expect((rows as { c: number }[])[0]!.c).toBe(1);
    await admin.query("DELETE FROM people WHERE name = 'Auto1'");
  });
});

describe('cancel', () => {
  it('cancels SELECT SLEEP(10) in under 2 seconds', async () => {
    const s = await open();
    const started = Date.now();
    const pending = s.execute('SELECT SLEEP(10)', { maxRows: 10 });
    await new Promise((r) => setTimeout(r, 300));
    await s.cancel();
    const r = await pending;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.error?.message).toBe('Query cancelada.');
    const next = await s.execute('SELECT 2', { maxRows: 10 });
    expect(next.rows).toEqual([['2']]);
  });

  it('cancels a long-running query that ends with error 1317', async () => {
    const s = await open();
    const pending = s.execute('SELECT SUM(a.n * b.n) FROM big a, big b', { maxRows: 10 });
    await new Promise((r) => setTimeout(r, 300));
    await s.cancel();
    const r = await pending;
    expect(r.error?.message).toBe('Query cancelada.');
  });

  it('cancel without a running query does nothing', async () => {
    const s = await open();
    await s.cancel();
    const r = await s.execute('SELECT 3', { maxRows: 10 });
    expect(r.rows).toEqual([['3']]);
  });
});

describe('introspection', () => {
  it('lists databases, tables, views, columns and keys, hiding system schemas', async () => {
    const tree = await mysqlDriver.introspect(params());
    expect(tree.databases.map((d) => d.name)).toEqual([fixture().database]);
    const db = tree.databases[0]!;
    const people = db.tables.find((t) => t.name === 'people')!;
    expect(people.type).toBe('table');
    expect(people.columns).toEqual([
      { name: 'id', type: 'int', nullable: false, key: 'PRI' },
      { name: 'name', type: 'varchar(50)', nullable: false },
      { name: 'email', type: 'varchar(80)', nullable: true, key: 'UNI' },
      { name: 'note', type: 'text', nullable: true },
    ]);
    expect(db.tables.find((t) => t.name === 'people_names')!.type).toBe('view');
  });
});

describe('SessionManager with the real driver', () => {
  const env: Environment = {
    id: 'e', projectId: 'p', name: 'dev', engine: 'mysql', host: '', port: 0, credentialId: 'c', production: false,
  };
  const events: SessionState[] = [];
  let manager: SessionManager;

  beforeAll(() => {
    const f = fixture();
    const e = { ...env, host: f.host, port: f.port };
    manager = new SessionManager({
      getEnvironment: (id) => (id === 'e' ? e : id === 'pro' ? { ...e, id: 'pro', production: true } : undefined),
      resolveConnectParams: async () => params(),
      getDriver: () => mysqlDriver,
      getDialect,
      emit: (s) => events.push(s),
      now: () => Date.now(),
    });
  });
  afterAll(() => manager.closeAll());

  const run = (tab: string, sql: string, extra = {}) =>
    manager.run(tab, { sql, scope: 'all', cursor: 0, maxRows: 1000, ...extra });

  it('production opens read-only: the write is refused in the app and never reaches the server', async () => {
    await manager.open('ro', 'pro');
    const res = await run('ro', "INSERT INTO people (name) VALUES ('Nope')");
    expect(res.results[0]!.error?.code).toBe('REFUSED');
    const [rows] = await admin.query("SELECT COUNT(*) AS c FROM people WHERE name = 'Nope'");
    expect((rows as { c: number }[])[0]!.c).toBe(0);
    expect((await run('ro', 'SELECT COUNT(*) FROM people')).results[0]!.error).toBeUndefined();
    await manager.close('ro');
  });

  it('transaction mode with rollback and commit, counter and elapsed start', async () => {
    await manager.open('tx', 'e');
    await manager.setMode('tx', 'transaction');
    const res = await run('tx', "INSERT INTO people (name) VALUES ('M1'); UPDATE people SET note = 'n' WHERE name = 'M1'");
    expect(res.results.map((r) => r.affectedRows)).toEqual([1, 1]);
    expect(res.session.transaction).toMatchObject({ open: true, statements: 2 });
    await manager.rollback('tx');
    const [rows] = await admin.query("SELECT COUNT(*) AS c FROM people WHERE name = 'M1'");
    expect((rows as { c: number }[])[0]!.c).toBe(0);
    await manager.close('tx');
  });

  it('warns about implicit commit before running DDL inside an open transaction', async () => {
    await manager.open('ddl', 'e');
    await manager.setMode('ddl', 'transaction');
    await run('ddl', "INSERT INTO people (name) VALUES ('Ddl1')");
    const warn = await run('ddl', 'CREATE TABLE tmp_implicit (a INT)');
    expect(warn.needsConfirmation?.reason).toBe('implicit-commit');
    const [t] = await admin.query("SHOW TABLES LIKE 'tmp_implicit'");
    expect(t as unknown[]).toHaveLength(0);
    const done = await run('ddl', 'CREATE TABLE tmp_implicit (a INT)', { confirmed: true });
    expect(done.results[0]!.error).toBeUndefined();
    expect(done.session.transaction.open).toBe(false);
    const [rows] = await admin.query("SELECT COUNT(*) AS c FROM people WHERE name = 'Ddl1'");
    expect((rows as { c: number }[])[0]!.c).toBe(1); // committed implicitly
    await admin.query("DELETE FROM people WHERE name = 'Ddl1'");
    await admin.query('DROP TABLE tmp_implicit');
    await manager.close('ddl');
  });

  it('cancels through the manager', async () => {
    await manager.open('cx', 'e');
    const started = Date.now();
    const pending = run('cx', 'SELECT SLEEP(10)');
    await new Promise((r) => setTimeout(r, 300));
    expect(manager.state('cx').status).toBe('running');
    await manager.cancel('cx');
    const res = await pending;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.results[0]!.error?.message).toBe('Query cancelada.');
    expect(res.session.status).toBe('idle');
    await manager.close('cx');
  });

  it('reports a lost connection with an open transaction', async () => {
    await manager.open('lost', 'e');
    await manager.setMode('lost', 'transaction');
    await run('lost', "INSERT INTO people (name) VALUES ('Lost1')");
    const id = (await run('lost', 'SELECT CONNECTION_ID()')).results[0]!.rows![0]![0];
    await admin.query(`KILL ${id}`);
    await new Promise((r) => setTimeout(r, 500));
    const state = manager.state('lost');
    expect(state.status).toBe('error');
    expect(state.error).toBe('A conexão caiu e o servidor desfez a transação aberta (2 comandos).');
    const [rows] = await admin.query("SELECT COUNT(*) AS c FROM people WHERE name = 'Lost1'");
    expect((rows as { c: number }[])[0]!.c).toBe(0);
  });
});
