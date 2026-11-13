import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLLBACK_AFTER_MS } from '@shared/agents';
import { makeRig, observer, rootConnection, type Rig } from '../support/agent-rig';

// Attacks from an agent: nothing an agent sends may change data it was not approved to
// change, create files, or leave a transaction behind. Attacks run against a real MySQL (cais-test-* container).

let rig: Rig;
let admin: any;
let root: any;
const q = (p: any) => rig.broker.query(p) as Promise<any>;
const items = async (sql = 'SELECT id, v FROM atk_items ORDER BY id') => JSON.stringify((await admin.query(sql))[0]);
const settle = (id: string, ms = 15000) => rig.broker.waitForStatus(id, (s) => !['pending_approval', 'running'].includes(s), ms);

beforeAll(async () => {
  root = await rootConnection();
  await root.query('SET GLOBAL log_bin_trust_function_creators = 1');
  for (const t of ['DROP TABLE IF EXISTS atk_items', 'DROP TABLE IF EXISTS atk_items2', 'DROP TABLE IF EXISTS atk_ddl', 'DROP FUNCTION IF EXISTS atk_fw', 'DROP FUNCTION IF EXISTS atk_fcommit']) await root.query(t);
  await root.query('CREATE TABLE atk_items (id INT PRIMARY KEY AUTO_INCREMENT, v VARCHAR(40)) ENGINE=InnoDB');
  await root.query("INSERT INTO atk_items (v) VALUES ('a'), ('b')");
  await root.query("CREATE FUNCTION atk_fw() RETURNS INT MODIFIES SQL DATA BEGIN INSERT INTO atk_items (v) VALUES ('from-fn'); RETURN 1; END");
  await root.query("CREATE FUNCTION atk_fcommit() RETURNS INT MODIFIES SQL DATA BEGIN UPDATE atk_items SET v = 'fn-upd' WHERE id = 1; RETURN 1; END");
  await root.query('CREATE DATABASE IF NOT EXISTS other_db');
  await root.query('CREATE TABLE IF NOT EXISTS other_db.t (x INT)');
  await root.query('GRANT ALL ON other_db.* TO cais@"%"');
  admin = await observer();
  await admin.query('SET SESSION innodb_lock_wait_timeout = 1');
  rig = makeRig();
});
afterAll(async () => {
  await rig.broker.shutdown();
  await rig.sessions.closeAll();
  await root.query('DROP DATABASE IF EXISTS other_db'); // keep the shared container as the other suites expect it
  await admin?.end();
  await root?.end();
});

const ATTACKS: [string, string][] = [
  ['set names + sysvar', "SET NAMES utf8mb4, @@autocommit=0"],
  ['set names + tx ro off', "SET NAMES utf8mb4, @@session.transaction_read_only=0"],
  ['set user var then sysvar', "SET @a=1, @@SESSION . transaction_read_only = 0"],
  ['set exec comment', "SET @a=1 /*!, transaction_read_only=0 */"],
  ['set tx', "SET TRANSACTION READ WRITE"],
  ['set session tx', "SET SESSION TRANSACTION READ WRITE"],
  ['dumpfile 1.', "SELECT 1.INTO DUMPFILE '/tmp/atk1'"],
  ['outfile 1e0', "SELECT 1e0INTO OUTFILE '/tmp/atk2'"],
  ['outfile nbsp-dash', "SELECT 1 -- \nINTO OUTFILE '/tmp/atk3'"],
  ['outfile versioned', "SELECT 1 /*!50000 INTO OUTFILE '/tmp/atk4' */"],
  ['insert versioned', "/*!50000 INSERT INTO atk_items (v) VALUES ('ver') */"],
  ['insert versioned99999', "/*!99999 INSERT INTO atk_items (v) VALUES ('ver') */"],
  ['with delete', "WITH x AS (SELECT 1) DELETE FROM atk_items"],
  ['with update', "WITH x AS (SELECT 1 AS c) UPDATE atk_items SET v='w'"],
  ['with paren delete', "(WITH x AS (SELECT 1) DELETE FROM atk_items)"],
  ['select fn writes', "SELECT atk_fw()"],
  ['select fn update', "SELECT atk_fcommit()"],
  ['explain analyze delete', "EXPLAIN ANALYZE DELETE FROM atk_items"],
  ['explain analyze select fn', "EXPLAIN ANALYZE SELECT atk_fw()"],
  ['multi', "SELECT 1; DELETE FROM atk_items"],
  ['delimiter', "DELIMITER //\nSELECT 1; DELETE FROM atk_items//\n"],
  ['delimiter2', "DELIMITER $$\nSELECT 1; DELETE FROM atk_items $$"],
  ['execcomment semicolon', "SELECT 1 /*! ; DELETE FROM atk_items */"],
  ['execcomment semicolon2', "SELECT 1 /*!50000 ; DELETE FROM atk_items */"],
  ['comment commit', "SELECT 1 /*! ; COMMIT */"],
  ['for update', "SELECT * FROM atk_items FOR UPDATE"],
  ['for/**/share', "SELECT * FROM atk_items FOR/**/SHARE"],
  ['lock in share', "SELECT * FROM atk_items LOCK IN SHARE MODE"],
  ['insert', "INSERT INTO atk_items (v) VALUES ('x')"],
  ['do', "DO (SELECT atk_fw())"],
  ['call', "CALL nonexistent()"],
  ['prepare', "PREPARE s FROM 'DELETE FROM atk_items'"],
  ['handler', "HANDLER atk_items OPEN"],
  ['truncate', "TRUNCATE atk_items"],
  ['create temp', "CREATE TEMPORARY TABLE tt (a int)"],
  ['kill', "KILL QUERY 1"],
  ['load', "LOAD DATA INFILE '/etc/passwd' INTO TABLE atk_items"],
  ['table stmt', "TABLE atk_items"],
  ['values', "VALUES ROW(1,2)"],
  ['select into var', "SELECT v INTO @x FROM atk_items LIMIT 1"],
  ['set pw', "SET PASSWORD = 'x'"],
  ['set role', "SET ROLE ALL"],
  ['set sql_log_bin', "SET sql_log_bin = 0"],
  ['set var assign sysvar expr', "SET @a = @@global.max_connections"],
  ['select @@ assign', "SELECT @@session.transaction_read_only"],
  ['begin', "BEGIN"],
  ['start tx rw', "START TRANSACTION READ WRITE"],
  ['commit', "COMMIT"],
  ['lock tables', "LOCK TABLES atk_items WRITE"],
  ['flush', "FLUSH TABLES"],
  ['analyze', "ANALYZE TABLE atk_items"],
  ['optimize', "OPTIMIZE TABLE atk_items"],
  ['checksum', "CHECKSUM TABLE atk_items"],
  ['show', "SHOW VARIABLES LIKE 'hostname'"],
  ['explain for connection', "EXPLAIN FOR CONNECTION 1"],
  ['with values-cte', "WITH `values` AS (SELECT 1) DELETE FROM atk_items"],
  ['select ro-bypass update lowercase', "update atk_items set v='lc'"],
  ['unicode ws before verb', " DELETE FROM atk_items"],
  ['bom', "﻿DELETE FROM atk_items"],
  ['nested comment', "/* /* */ DELETE FROM atk_items"],
  ['hash comment multi', "SELECT 1 # x\n; DELETE FROM atk_items"],
  ['backslash string', "SELECT '\\' ; DELETE FROM atk_items; -- '"],
  ['into outfile nested', "SELECT * FROM (SELECT 1) t INTO/**/OUTFILE '/tmp/atk5'"],
  ['xa', "XA START 'a'"],
  ['import', "IMPORT TABLE FROM '/tmp/x.sdi'"],
  ['rename', "RENAME TABLE atk_items TO atk_items2"],
  ['alter', "ALTER TABLE atk_items ADD c INT"],
  ['set autocommit', "SET autocommit=1"],
  ['set @@global', "SET GLOBAL max_connections=1000"],
  ['set persist', "SET PERSIST max_connections=1000"],
  ['select sleep0', "SELECT SLEEP(0)"],
  ['select load_file', "SELECT LOAD_FILE('/etc/passwd')"],
  ['select user()', "SELECT USER(), CURRENT_USER(), @@hostname, @@port, @@report_host"],
];


describe('read mode outside production (runs without a click): no attack changes anything', () => {
  it('every statement is refused, fails or only reads; the data is identical afterwards', async () => {
    const before = await items();
    for (const [name, sql] of ATTACKS) {
      const outcome = await q({ env: 'api/dev', sql }).then(
        (res) => (res.results ?? []).some((r: any) => r.kind === 'write') ? 'WROTE' : res.status,
        (e: any) => (e.name === 'AgentError' ? 'refused' : `unexpected ${e.name}`),
      );
      expect(['refused', 'succeeded', 'failed'], `${name}: ${outcome}`).toContain(outcome);
    }
    expect(await items()).toBe(before);
    expect(rig.broker.snapshot().pending).toHaveLength(0);
  });
});

const BATCHES: [string, string][] = [
  ['set autocommit', "INSERT INTO atk_items (v) VALUES ('a1'); SET autocommit=1; INSERT INTO atk_items (v) VALUES ('a2')"],
  ['set @a, autocommit', "INSERT INTO atk_items (v) VALUES ('b1'); SET @x=1, autocommit=1"],
  ['set @@autocommit', "INSERT INTO atk_items (v) VALUES ('b2'); SET @@session.autocommit=1"],
  ['commit exec comment', "INSERT INTO atk_items (v) VALUES ('c1'); /*!50000 COMMIT */"],
  ['commit comment-suffix', "INSERT INTO atk_items (v) VALUES ('c2') /*!50000 ; COMMIT */"],
  ['commit delimiter', "DELIMITER //\nINSERT INTO atk_items (v) VALUES ('c3'); COMMIT//"],
  ['ddl delimiter', "DELIMITER //\nINSERT INTO atk_items (v) VALUES ('d1'); CREATE TABLE atk_ddl (a int)//"],
  ['start transaction', "INSERT INTO atk_items (v) VALUES ('e1'); START TRANSACTION"],
  ['begin', "INSERT INTO atk_items (v) VALUES ('e2'); BEGIN"],
  ['lock tables', "INSERT INTO atk_items (v) VALUES ('f1'); LOCK TABLES atk_items WRITE"],
  ['create table', "INSERT INTO atk_items (v) VALUES ('g1'); CREATE TABLE atk_ddl (a int)"],
  ['create temp', "INSERT INTO atk_items (v) VALUES ('g2'); CREATE TEMPORARY TABLE atk_t (a int)"],
  ['get_lock + use', "INSERT INTO atk_items (v) VALUES ('h1'); SELECT GET_LOCK('atk', 0); USE other_db"],
  ['set sql_mode', "INSERT INTO atk_items (v) VALUES ('h2'); SET sql_mode=''"],
  ['for update', "INSERT INTO atk_items (v) VALUES ('h3'); SELECT * FROM atk_items FOR UPDATE"],
  ['into outfile', "INSERT INTO atk_items (v) VALUES ('h4'); SELECT * FROM atk_items INTO OUTFILE '/tmp/atk_w_out'"],
  ['call', "INSERT INTO atk_items (v) VALUES ('h5'); CALL x()"],
  ['set transaction', "INSERT INTO atk_items (v) VALUES ('h6'); SET TRANSACTION ISOLATION LEVEL READ COMMITTED"],
  ['set names then insert', "SET NAMES utf8mb4; INSERT INTO atk_items (v) VALUES ('h7')"],
  ['with-delete', "WITH x AS (SELECT 1) DELETE FROM atk_items WHERE id>1000"],
  ['explain analyze delete (write mode)', "EXPLAIN ANALYZE DELETE FROM atk_items"],
  ['insert + show', "INSERT INTO atk_items (v) VALUES ('h8'); SHOW TABLES"],
];


describe('write batches: nothing may commit behind the second decision', () => {
  for (const [name, sql] of BATCHES) {
    it(name, async () => {
      const before = await items();
      let status: string;
      try {
        const res = await q({ env: 'api/dev', sql, write: true, reason: 'test' });
        rig.broker.approve(res.request_id, { shareResult: true });
        await settle(res.request_id);
        status = ((await rig.broker.status({ id: res.request_id })) as any).status;
        if (status === 'awaiting_commit') await rig.broker.rollback(res.request_id);
      } catch (e: any) {
        status = 'refused';
        expect(e.name).toBe('AgentError');
      }
      expect(['refused', 'failed', 'awaiting_commit']).toContain(status);
      const [t] = await root.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_NAME='atk_ddl'");
      expect(Number((t as any)[0].n)).toBe(0);
      expect(await items()).toBe(before);
    });
  }

  it('a request approved and then cut by access-off is rolled back, never committed', async () => {
    const before = await items();
    const res = await q({ env: 'api/dev', sql: "INSERT INTO atk_items (v) VALUES ('race1')", write: true, reason: 'test' });
    rig.broker.approve(res.request_id, { shareResult: true });
    await rig.broker.disable();
    await new Promise((r) => setTimeout(r, 700));
    expect(await items()).toBe(before);
    rig.broker.setEnabled(true);
  });

  it('Commit and the 120 s timer at the same instant resolve exactly once, and the table agrees with the outcome', async () => {
    const res = await q({ env: 'api/dev', sql: "INSERT INTO atk_items (v) VALUES ('race2')", write: true, reason: 'test' });
    rig.broker.approve(res.request_id, { shareResult: true });
    await rig.broker.waitForStatus(res.request_id, (s) => s === 'awaiting_commit', 10000);
    const c = rig.broker.commit(res.request_id).catch((e) => e);
    await rig.clock.advance(ROLLBACK_AFTER_MS + 10);
    await c;
    const st = ((await rig.broker.status({ id: res.request_id })) as any).status;
    expect(['committed', 'rolled_back']).toContain(st);
    expect((await items()).includes('race2')).toBe(st === 'committed');
    await root.query("DELETE FROM atk_items WHERE v = 'race2'");
  });

  it('a connection killed while awaiting commit: Commit fails and nothing persisted', async () => {
    const before = await items();
    const res = await q({ env: 'api/dev', sql: "INSERT INTO atk_items (v) VALUES ('killed')", write: true, reason: 'test' });
    rig.broker.approve(res.request_id, { shareResult: true });
    await rig.broker.waitForStatus(res.request_id, (s) => s === 'awaiting_commit', 10000);
    const [pl] = await root.query("SELECT ID FROM information_schema.PROCESSLIST WHERE USER='cais' AND ID <> CONNECTION_ID() AND INFO IS NULL");
    for (const p of pl as any[]) if (p.ID !== admin.threadId) await root.query(`KILL ${p.ID}`).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    admin = await observer();
    await admin.query('SET SESSION innodb_lock_wait_timeout = 1');
    expect((await rig.broker.commit(res.request_id)).status).toBe('failed');
    expect(await items()).toBe(before);
  });
});
