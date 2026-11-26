import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRig, observer, rootConnection, type Rig } from '../support/agent-rig';
import { fixture } from '../support/fixture';

// Agent access per environment against a real MySQL 8.4 (cais-test-*): autonomous writes commit by themselves
// only within the limits. A database of its own, where the test user has every privilege
// (TRIGGER included): other suites leave MyISAM tables in the shared one, and with triggers the user cannot see
// plus a MyISAM table nothing may write by itself. Its own account too, with PROCESS: without it
// (or global privileges) the Cais cannot see every foreign key that cascades, and no UPDATE/DELETE commits by itself.
const DB = 'cais_levels';
const AGENT_USER = 'lv_agent';
const AGENT_PASSWORD = 'lv-agent-pw';

let root: any;
let watch: any;
let rig: Rig;

const value = async (sql: string): Promise<unknown> => {
  const [rows] = await watch.query(sql);
  return Object.values((rows as Record<string, unknown>[])[0]!)[0];
};
const settle = (id: string, ms = 15000) => rig.broker.waitForStatus(id, (s) => !['pending_approval', 'running'].includes(s), ms);

beforeAll(async () => {
  const f = fixture();
  root = await rootConnection();
  await root.query(`CREATE DATABASE IF NOT EXISTS ${DB}`);
  await root.query(`GRANT ALL ON ${DB}.* TO '${f.user}'@'%'`);
  await root.query(`DROP USER IF EXISTS '${AGENT_USER}'@'%'`);
  await root.query(`CREATE USER '${AGENT_USER}'@'%' IDENTIFIED BY '${AGENT_PASSWORD}'`);
  await root.query(`GRANT ALL ON ${DB}.* TO '${AGENT_USER}'@'%'`);
  await root.query(`GRANT PROCESS ON *.* TO '${AGENT_USER}'@'%'`);
  await root.query(`USE ${DB}`);
  for (const t of ['lv_items', 'lv_bulk', 'lv_myisam']) await root.query(`DROP TABLE IF EXISTS ${t}`);
  await root.query('CREATE TABLE lv_items (id INT PRIMARY KEY, v VARCHAR(20)) ENGINE=InnoDB');
  await root.query("INSERT INTO lv_items VALUES (1, 'a'), (2, 'b'), (3, 'c')");
  await root.query('CREATE TABLE lv_bulk (id INT PRIMARY KEY AUTO_INCREMENT, v VARCHAR(20)) ENGINE=InnoDB');
  const values = Array.from({ length: 1200 }, () => "('x')").join(',');
  await root.query(`INSERT INTO lv_bulk (v) VALUES ${values}`);
  watch = await observer();
  await watch.query(`USE ${DB}`);
  rig = makeRig({ user: AGENT_USER, password: AGENT_PASSWORD });
  for (const e of rig.envs) e.defaultDatabase = DB;
  rig.envs[0]!.agentLevel = 'free-reads-writes';
});

afterAll(async () => {
  await rig?.broker.shutdown();
  await rig?.sessions.closeAll();
  await root?.query(`DROP DATABASE IF EXISTS ${DB}`);
  await root?.query('DROP DATABASE IF EXISTS lv_hidden');
  await root?.query(`DROP USER IF EXISTS '${AGENT_USER}'@'%'`);
  await watch?.end();
  await root?.end();
});

describe('free-reads-writes outside production', () => {
  it('a small write commits by itself and is visible to everyone', async () => {
    const res = (await rig.broker.query({ database: DB, env: 'api/dev', sql: "UPDATE lv_items SET v = 'z' WHERE id = 1", write: true, reason: 'teste' })) as any;
    expect(res.approval_reason).toBeUndefined();
    expect(res).toMatchObject({ status: 'committed', auto_commit: true, decided_by: 'policy' });
    expect(res.results[0].affected_rows).toBe(1);
    expect(await value('SELECT v FROM lv_items WHERE id = 1')).toBe('z');
    expect(rig.audit.filter((a) => a.id === res.request_id).map((a) => a.state)).toEqual(['running', 'committed']);
  });

  it('more than 1.000 rows: stays open for the person, nobody else sees it, Rollback undoes it', async () => {
    const res = (await rig.broker.query({ database: DB, env: 'api/dev', sql: "UPDATE lv_bulk SET v = 'y' WHERE id > 0", write: true, reason: 'teste' })) as any;
    expect(res.status).toBe('awaiting_commit');
    expect(res.commit_reason).toContain('1,200');
    expect(Number(await value("SELECT COUNT(*) FROM lv_bulk WHERE v = 'y'"))).toBe(0);
    await rig.broker.rollback(res.request_id);
    expect(Number(await value("SELECT COUNT(*) FROM lv_bulk WHERE v = 'y'"))).toBe(0);
  });

  it('a write to a MyISAM table, or to a table whose trigger writes to one, does not run before the person approves', async () => {
    await root.query('CREATE TABLE lv_myisam (id INT PRIMARY KEY, v VARCHAR(20)) ENGINE=MyISAM');
    try {
      const res = (await rig.broker.query({ database: DB, env: 'api/dev', sql: "INSERT INTO lv_myisam VALUES (1, 'a')", write: true, reason: 'teste' })) as any;
      expect(res.status).toBe('pending_approval');
      expect(res.approval_reason).toContain('has an alert');
      expect(Number(await value('SELECT COUNT(*) FROM lv_myisam'))).toBe(0);
      rig.broker.reject(res.request_id);
      // the trigger of an InnoDB table writing to the MyISAM one is seen and stops the write too
      await root.query("CREATE TRIGGER lv_items_au AFTER UPDATE ON lv_items FOR EACH ROW INSERT INTO lv_myisam VALUES (NEW.id + 100, 'log')");
      try {
        const other = (await rig.broker.query({ database: DB, env: 'api/dev', sql: "UPDATE lv_items SET v = 'q' WHERE id = 2", write: true, reason: 'teste' })) as any;
        expect(other.status).toBe('pending_approval');
        expect(rig.broker.snapshot().pending.find((r) => r.id === other.request_id)!.warnings.join(' ')).toContain('trigger');
        rig.broker.reject(other.request_id);
      } finally {
        await root.query('DROP TRIGGER IF EXISTS lv_items_au');
      }
    } finally {
      await root.query('DROP TABLE IF EXISTS lv_myisam');
    }
  });

  it('a write without WHERE does not run before the person approves', async () => {
    const res = (await rig.broker.query({ database: DB, env: 'api/dev', sql: "DELETE FROM lv_items", write: true, reason: 'teste' })) as any;
    expect(res.status).toBe('pending_approval');
    expect(Number(await value('SELECT COUNT(*) FROM lv_items'))).toBe(3);
    rig.broker.reject(res.request_id);
  });

  it('cascading foreign keys, writing triggers and stored functions never commit by themselves (1.500 rows each)', async () => {
    await root.query('CREATE TABLE lv_parent (id INT PRIMARY KEY) ENGINE=InnoDB');
    await root.query('CREATE TABLE lv_child (id INT PRIMARY KEY AUTO_INCREMENT, parent_id INT, FOREIGN KEY (parent_id) REFERENCES lv_parent (id) ON DELETE CASCADE) ENGINE=InnoDB');
    await root.query('INSERT INTO lv_parent VALUES (1)');
    await root.query(`INSERT INTO lv_child (parent_id) VALUES ${Array.from({ length: 1500 }, () => '(1)').join(',')}`);
    await root.query('CREATE TABLE lv_victim (id INT PRIMARY KEY AUTO_INCREMENT, v INT) ENGINE=InnoDB');
    await root.query(`INSERT INTO lv_victim (v) VALUES ${Array.from({ length: 1500 }, () => '(1)').join(',')}`);
    await root.query('CREATE FUNCTION lv_purge() RETURNS INT MODIFIES SQL DATA DETERMINISTIC BEGIN DELETE FROM lv_victim; RETURN 1; END');
    await root.query('CREATE VIEW lv_v AS SELECT id, lv_purge() AS n FROM lv_items');
    try {
      const cases = [
        'DELETE FROM lv_parent WHERE id = 1',
        'SELECT lv_purge()',
        'SET @x = lv_purge()',
        'SELECT * FROM lv_v',
        "UPDATE lv_items SET v = lv_purge() WHERE id = 1",
      ];
      for (const sql of cases) {
        const res = (await rig.broker.query({ database: DB, env: 'api/dev', sql, write: true, reason: 'teste' })) as any;
        expect(res.status, sql).toBe('pending_approval');
        if (sql.startsWith('DELETE')) expect(res.approval_reason).toContain('cascading foreign key (cais_levels.lv_child)');
        if (sql.includes('lv_v')) expect(res.approval_reason).toMatch(/view lv_v|database function lv_purge|only INSERT/);
        rig.broker.reject(res.request_id);
      }
      await root.query("CREATE TRIGGER lv_items_purge AFTER UPDATE ON lv_items FOR EACH ROW DELETE FROM lv_victim");
      const trig = (await rig.broker.query({ database: DB, env: 'api/dev', sql: "UPDATE lv_items SET v = 'k' WHERE id = 1", write: true, reason: 'teste' })) as any;
      expect(trig.status).toBe('pending_approval');
      expect(trig.approval_reason).toContain('trigger');
      rig.broker.reject(trig.request_id);
      expect(Number(await value('SELECT COUNT(*) FROM lv_child'))).toBe(1500);
      expect(Number(await value('SELECT COUNT(*) FROM lv_victim'))).toBe(1500);
    } finally {
      await root.query('DROP TRIGGER IF EXISTS lv_items_purge');
      await root.query('DROP VIEW IF EXISTS lv_v');
      await root.query('DROP FUNCTION IF EXISTS lv_purge');
      for (const t of ['lv_child', 'lv_parent', 'lv_victim']) await root.query(`DROP TABLE IF EXISTS ${t}`);
    }
  });

  it('a foreign key that cascades from a database the account cannot see is still found (InnoDB list), and blocks the commit', async () => {
    await root.query('CREATE TABLE lv_parent2 (id INT PRIMARY KEY) ENGINE=InnoDB');
    await root.query('INSERT INTO lv_parent2 VALUES (1)');
    await root.query('CREATE DATABASE IF NOT EXISTS lv_hidden');
    await root.query(`CREATE TABLE lv_hidden.child (id INT PRIMARY KEY AUTO_INCREMENT, pid INT, FOREIGN KEY (pid) REFERENCES ${DB}.lv_parent2 (id) ON DELETE CASCADE) ENGINE=InnoDB`);
    await root.query(`INSERT INTO lv_hidden.child (pid) VALUES ${Array.from({ length: 3000 }, () => '(1)').join(',')}`);
    try {
      const res = (await rig.broker.query({ database: DB, env: 'api/dev', sql: 'DELETE FROM lv_parent2 WHERE id = 1', write: true, reason: 'teste' })) as any;
      expect(res.status).toBe('pending_approval');
      expect(res.approval_reason).toContain('lv_hidden.child');
      rig.broker.reject(res.request_id);
      const [rows] = await root.query('SELECT COUNT(*) AS n FROM lv_hidden.child');
      expect(Number(rows[0].n)).toBe(3000);
    } finally {
      await root.query('DROP DATABASE IF EXISTS lv_hidden');
      await root.query('DROP TABLE IF EXISTS lv_parent2');
    }
  });

  it('an account without PROCESS (nor global privileges): UPDATE and DELETE wait for the person, a plain INSERT still commits by itself', async () => {
    const plain = makeRig();
    for (const e of plain.envs) e.defaultDatabase = DB;
    plain.envs[0]!.agentLevel = 'free-reads-writes';
    try {
      const upd = (await plain.broker.query({ database: DB, env: 'api/dev', sql: "UPDATE lv_items SET v = 'n' WHERE id = 2", write: true, reason: 'teste' })) as any;
      expect(upd.status).toBe('pending_approval');
      expect(upd.approval_reason).toContain('cannot see every foreign key');
      plain.broker.reject(upd.request_id);
      const ins = (await plain.broker.query({ database: DB, env: 'api/dev', sql: "INSERT INTO lv_items VALUES (50, 'novo')", write: true, reason: 'teste' })) as any;
      expect(ins).toMatchObject({ status: 'committed', auto_commit: true, decided_by: 'policy' });
      await root.query('DELETE FROM lv_items WHERE id = 50');
    } finally {
      await plain.broker.shutdown();
      await plain.sessions.closeAll();
    }
  });

  it('a qualified table name that starts with a digit is still checked for triggers', async () => {
    await root.query('CREATE TABLE `2fa_codes` (id INT PRIMARY KEY, v INT) ENGINE=InnoDB');
    await root.query('INSERT INTO `2fa_codes` VALUES (1, 0)');
    await root.query('CREATE TRIGGER lv_2fa AFTER UPDATE ON `2fa_codes` FOR EACH ROW DELETE FROM lv_bulk');
    try {
      const res = (await rig.broker.query({ database: DB, env: 'api/dev', sql: `UPDATE ${DB}.2fa_codes SET v = v + 1 WHERE id = 1`, write: true, reason: 'teste' })) as any;
      expect(res.status).toBe('pending_approval');
      expect(res.approval_reason).toContain('trigger');
      rig.broker.reject(res.request_id);
      expect(Number(await value('SELECT COUNT(*) FROM lv_bulk'))).toBe(1200);
    } finally {
      await root.query('DROP TRIGGER IF EXISTS lv_2fa');
      await root.query('DROP TABLE IF EXISTS `2fa_codes`');
    }
  });

  it('a failing write rolls back everything it did before the failure', async () => {
    const res = (await rig.broker.query({
      database: DB,
      env: 'api/dev',
      sql: "UPDATE lv_items SET v = 'w' WHERE id = 2; INSERT INTO lv_items VALUES (3, 'dup')",
      write: true,
      reason: 'teste',
    })) as any;
    expect(res.status).toBe('failed');
    expect(await value('SELECT v FROM lv_items WHERE id = 2')).toBe('b');
  });

  it('the refusals hold: DDL and admin never run, whatever the level', async () => {
    for (const sql of ['DROP TABLE lv_items', 'SET GLOBAL max_connections = 5', 'TRUNCATE lv_items']) {
      await expect(rig.broker.query({ database: DB, env: 'api/dev', sql, write: true, reason: 'teste' })).rejects.toMatchObject({ name: 'AgentError' });
    }
    expect(Number(await value('SELECT COUNT(*) FROM lv_items'))).toBe(3);
  });

  it('production with the level set by hand still asks, and runs nothing before the click', async () => {
    rig.envs[1]!.agentLevel = 'free-reads-writes';
    const res = (await rig.broker.query({ database: DB, env: 'api/pro', sql: "UPDATE lv_items SET v = 'p' WHERE id = 3", write: true, reason: 'teste' })) as any;
    expect(res.status).toBe('pending_approval');
    expect(await value('SELECT v FROM lv_items WHERE id = 3')).toBe('c');
    rig.broker.approve(res.request_id, { shareResult: true });
    await settle(res.request_id);
    // approved by the person: the Commit is the person's too
    expect(rig.broker.snapshot().awaitingCommit.map((r) => r.id)).toContain(res.request_id);
    await rig.broker.rollback(res.request_id);
    expect(await value('SELECT v FROM lv_items WHERE id = 3')).toBe('c');
  });
});

describe('free reads in production', () => {
  it('a read runs by itself, a write waits and runs nothing before the click', async () => {
    rig.envs[1]!.agentLevel = 'free-reads';
    try {
      const read = (await rig.broker.query({ database: DB, env: 'api/pro', sql: 'SELECT COUNT(*) FROM lv_items' })) as any;
      expect(read).toMatchObject({ status: 'succeeded' });
      const res = (await rig.broker.query({ database: DB, env: 'api/pro', sql: "UPDATE lv_items SET v = 'p' WHERE id = 3", write: true, reason: 'teste' })) as any;
      expect(res.status).toBe('pending_approval');
      expect(await value('SELECT v FROM lv_items WHERE id = 3')).toBe('c');
      rig.broker.reject(res.request_id);
    } finally {
      delete rig.envs[1]!.agentLevel;
    }
  });
});

describe('approve-all outside production', () => {
  it('a read waits for the person', async () => {
    rig.envs[0]!.agentLevel = 'approve-all';
    const res = (await rig.broker.query({ database: DB, env: 'api/dev', sql: 'SELECT COUNT(*) FROM lv_items', reason: 'teste' })) as any;
    expect(res.status).toBe('pending_approval');
    rig.broker.approve(res.request_id, { shareResult: true });
    await settle(res.request_id);
    const done = (await rig.broker.status({ id: res.request_id })) as any;
    expect(done.error).toBeUndefined();
    expect(done).toMatchObject({ status: 'succeeded' });
    rig.envs[0]!.agentLevel = 'free-reads-writes';
  });
});
