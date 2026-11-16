import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import type { MysqlEnvironment as Environment } from '@shared/model';
import { AgentBroker } from '@main/agents/broker';
import { AgentSessions } from '@main/agents/sessions';
import { mysqlDriver } from '@main/drivers/mysql';
import { SessionManager } from '@main/sessions';
import { FakeClock, projects } from '../support/agent-fakes';
import { makeRig, observer, rootConnection, type Rig } from '../support/agent-rig';
import { fixture, params } from '../support/fixture';

// Attempts to get around the guards, end to end against a real MySQL 8.4 (cais-test-*).
// Every payload below was checked live against an unguarded mysql2 connection: it changes the server.
// The agent rig and the person's tabs used for those payloads connect as root, so a refusal that failed
// would really change global state (restored in afterAll anyway).

const f = fixture();
const rootParams = (over: { host?: string; port?: number } = {}) => params({ ...over, user: 'root', password: f.rootPassword });

/** makeRig, but the agents' connections log in as root: a smuggled SET GLOBAL / KILL would succeed. */
function makeRootRig(): Rig {
  const base: Environment = { id: 'e-dev', projectId: 'p-api', name: 'dev', engine: 'mysql', host: f.host, port: f.port, defaultDatabase: f.database, credentialId: 'c', production: false };
  const envs = [base, { ...base, id: 'e-pro', name: 'pro', production: true }];
  const clock = new FakeClock();
  const sessions = new AgentSessions({
    getDriver: () => mysqlDriver,
    resolveConnectParams: async (e) => rootParams({ host: (e as Environment).host, port: (e as Environment).port }),
    scheduler: clock,
  });
  let seq = 0;
  const audit: any[] = [];
  const broker = new AgentBroker({
    now: () => clock.now, scheduler: clock, newId: () => `au_${++seq}`,
    catalog: { projects: () => projects, environments: () => envs },
    scripts: { list: () => [], get: () => undefined, save: async () => { throw new Error('unused'); } },
    executor: sessions, audit: { append: (e) => void audit.push(e) },
    getDialect, onChange: () => undefined, onNewPending: () => undefined, onScriptsChanged: () => undefined,
  });
  broker.setEnabled(true);
  return { clock, broker, sessions, audit, envs, catalogProjects: projects };
}

/** The person's tabs, logged in as root (dev = Auto-commit, pro = Somente leitura). */
function makeManager(): SessionManager {
  const base: Environment = { id: 'dev', projectId: 'p', name: 'dev', engine: 'mysql', host: f.host, port: f.port, defaultDatabase: f.database, credentialId: 'c', production: false };
  return new SessionManager({
    getEnvironment: (id) => (id === 'dev' ? base : id === 'pro' ? { ...base, id: 'pro', production: true } : undefined),
    resolveConnectParams: async () => rootParams(),
    getDriver: () => mysqlDriver,
    getDialect,
    emit: () => undefined,
    now: () => Date.now(),
  });
}

let root: any;
let admin: any;
let rig: Rig; // agents as root
let plain: Rig; // agents as the regular test user (makeRig)
let manager: SessionManager;
let saved: { maxConnections: number; offline: number; sqlMode: string };

const scalar = async (sql: string): Promise<unknown> => {
  const [rows] = await root.query(sql);
  return Object.values((rows as Record<string, unknown>[])[0]!)[0];
};
const globals = async () => ({
  maxConnections: Number(await scalar('SELECT @@GLOBAL.max_connections')),
  offline: Number(await scalar('SELECT @@GLOBAL.offline_mode')),
});
const run = (tab: string, sql: string, extra = {}) => manager.run(tab, { sql, scope: 'all', cursor: 0, maxRows: 1000, ...extra });
const refusedCode = (p: Promise<unknown>) => p.then((r: any) => `ran:${r.status}`, (e: any) => (e.name === 'AgentError' ? e.code : `unexpected:${e.name}:${e.message}`));
const settle = (r: Rig, id: string, ms = 15000) => r.broker.waitForStatus(id, (s) => !['pending_approval', 'running'].includes(s), ms);
const alive = (conn: any) => conn.query('SELECT 1').then(() => true, () => false);

// U+0127 is sent as 0x27 (') and U+0137 as 0x37 ('7') once mysql2 believes the client charset is latin1.
const SMUGGLE_MAX = "SET @note = 'oķħ, GLOBAL max_connections = 77, @z = ħ'";
const SMUGGLE_OFFLINE = "SET @note = 'oķħ, GLOBAL offline_mode = ON, @z = ħ'";
const LATIN1_PAYLOADS = [
  `SET NAMES latin1; ${SMUGGLE_MAX}`,
  `SET NAMES latin1; ${SMUGGLE_OFFLINE}`,
  `SET CHARACTER SET latin1; ${SMUGGLE_MAX}`,
  `SET CHARSET latin1; ${SMUGGLE_OFFLINE}`,
  'SET NAMES latin1',
  "SET NAMES 'latin1'",
  'SET NAMES latin1 COLLATE latin1_swedish_ci',
];

beforeAll(async () => {
  root = await rootConnection();
  for (const t of ['au_inno']) await root.query(`DROP TABLE IF EXISTS ${t}`);
  await root.query('DROP PROCEDURE IF EXISTS au_ac_on');
  await root.query('CREATE TABLE au_inno (id INT PRIMARY KEY AUTO_INCREMENT, v VARCHAR(40)) ENGINE=InnoDB');
  await root.query("INSERT INTO au_inno (v) VALUES ('a'), ('b')");
  saved = { ...(await globals()), sqlMode: String(await scalar('SELECT @@GLOBAL.sql_mode')) };
  admin = await observer();
  rig = makeRootRig();
  plain = makeRig();
  manager = makeManager();
});

afterAll(async () => {
  for (const r of [rig, plain]) {
    await r?.broker.shutdown();
    await r?.sessions.closeAll();
  }
  await manager?.closeAll();
  if (saved) {
    await root.query(`SET GLOBAL max_connections = ${saved.maxConnections}`);
    await root.query(`SET GLOBAL offline_mode = ${saved.offline}`);
    await root.query('SET GLOBAL sql_mode = ?', [saved.sqlMode]);
  }
  for (const t of ['au_inno']) await root.query(`DROP TABLE IF EXISTS ${t}`);
  await root.query('DROP PROCEDURE IF EXISTS au_ac_on');
  await admin?.end();
  await root?.end();
});

describe('latin1 smuggling: SET NAMES latin1 never reaches a guarded session', () => {
  it('agents: every latin1 payload is refused in read and write mode, and the globals stay put', async () => {
    for (const sql of LATIN1_PAYLOADS) {
      for (const env of ['api/dev', 'api/pro']) {
        const read = await refusedCode(rig.broker.query({ env, sql, reason: 'test' } as any));
        expect(read, `read ${env}: ${sql}`).toMatch(/^(writes_in_read|ddl_or_transaction|command_not_allowed)$/);
      }
      const write = await refusedCode(rig.broker.query({ env: 'api/dev', sql, write: true, reason: 'test' } as any));
      expect(write, `write: ${sql}`).toMatch(/^(writes_in_read|ddl_or_transaction|command_not_allowed)$/);
    }
    // two separate requests on the same pooled connection: the first is refused, the second is a harmless string
    expect(await refusedCode(rig.broker.query({ env: 'api/dev', sql: 'SET NAMES latin1' } as any))).not.toMatch(/^ran:/);
    for (const sql of [SMUGGLE_MAX, SMUGGLE_OFFLINE]) {
      const res: any = await rig.broker.query({ env: 'api/dev', sql } as any);
      expect(res.status, sql).toBe('succeeded');
    }
    expect(rig.broker.snapshot().pending).toHaveLength(0);
    expect(await globals()).toEqual({ maxConnections: saved.maxConnections, offline: saved.offline });
  });

  it('read-only tab: the payloads are refused before anything leaves the app', async () => {
    await manager.open('a-ro', 'pro');
    for (const sql of LATIN1_PAYLOADS) {
      const r = await run('a-ro', sql);
      expect(r.results[0]!.error?.code, sql).toBe('REFUSED');
      expect(r.results, sql).toHaveLength(1);
    }
    expect((await run('a-ro', 'SELECT @@character_set_client, @@character_set_connection')).results[0]!.rows).toEqual([['utf8mb4', 'utf8mb4']]);
    await manager.close('a-ro');
    expect(await globals()).toEqual({ maxConnections: saved.maxConnections, offline: saved.offline });
  });

  it('Auto-commit tab: SET NAMES latin1 runs, but the next statement goes out in utf8mb4 again (the string stays one string)', async () => {
    await manager.open('a-ac', 'dev');
    const r = await run('a-ac', `SET NAMES latin1; ${SMUGGLE_MAX}; ${SMUGGLE_OFFLINE.replace('@note', '@note2')}`);
    expect(r.results.map((x) => x.error)).toEqual([undefined, undefined, undefined]);
    const back = await run('a-ac', 'SELECT @note, @note2, @@character_set_client');
    expect(back.results[0]!.rows).toEqual([[
      'oķħ, GLOBAL max_connections = 77, @z = ħ',
      'oķħ, GLOBAL offline_mode = ON, @z = ħ',
      'utf8mb4',
    ]]);
    await manager.close('a-ac');
    expect(await globals()).toEqual({ maxConnections: saved.maxConnections, offline: saved.offline });
  });
});

describe('executable comments that hide what the server runs', () => {
  it('agents: /*!99999 … */ KILL <observer> and /*M! … */ SET GLOBAL are refused; the observer lives, the globals stay', async () => {
    const victim = await observer();
    try {
      const payloads = [
        `/*!99999 SELECT 1 */ KILL ${victim.threadId}`,
        `/*!99999 SELECT 1 */ KILL CONNECTION ${victim.threadId}`,
        '/*M! SELECT */ SET GLOBAL max_connections = 44',
        '/*M! SELECT */ SET GLOBAL offline_mode = ON',
        `SELECT 1 /*!99999 , 2 */; /*M! x */ KILL ${victim.threadId}`,
      ];
      for (const sql of payloads) {
        for (const write of [false, true]) {
          for (const env of ['api/dev', 'api/pro']) {
            const code = await refusedCode(rig.broker.query({ env, sql, write, reason: 'test' } as any));
            expect(code, `${env} write=${write}: ${sql}`).toBe('executable_comment');
          }
        }
      }
      expect(rig.broker.snapshot().pending).toHaveLength(0);
      expect(rig.audit.filter((e) => e.state === 'refused' && e.errorCode === 'executable_comment').length).toBe(payloads.length * 4);
      expect(await alive(victim)).toBe(true);
      expect(await globals()).toEqual({ maxConnections: saved.maxConnections, offline: saved.offline });
    } finally {
      await victim.end().catch(() => undefined);
    }
  });

  it('read-only tab: the same payloads are refused and nothing happened on the server', async () => {
    const victim = await observer();
    try {
      await manager.open('b-ro', 'pro');
      for (const sql of [
        `/*!99999 SELECT 1 */ KILL ${victim.threadId}`,
        `/*!99999 SELECT 1 */ KILL QUERY ${victim.threadId}`,
        '/*M! SELECT */ SET GLOBAL max_connections = 44',
        '/*M! SELECT */ SET GLOBAL offline_mode = ON',
        '/*! SELECT 1 */',
      ]) {
        const r = await run('b-ro', sql);
        expect(r.results[0]!.error?.code, sql).toBe('REFUSED');
      }
      expect(await alive(victim)).toBe(true);
      expect(await globals()).toEqual({ maxConnections: saved.maxConnections, offline: saved.offline });
      await manager.close('b-ro');
    } finally {
      await victim.end().catch(() => undefined);
    }
  });
});

describe('GLOBAL sql_mode with NO_BACKSLASH_ESCAPES', () => {
  let nbe: Rig;
  beforeAll(async () => {
    await root.query("SET GLOBAL sql_mode = CONCAT(@@GLOBAL.sql_mode, ',NO_BACKSLASH_ESCAPES')");
    nbe = makeRootRig(); // new connections only: they inherit the global
  });
  afterAll(async () => {
    await nbe?.broker.shutdown();
    await nbe?.sessions.closeAll();
    await root.query('SET GLOBAL sql_mode = ?', [saved.sqlMode]);
  });

  const sessionSqlMode = async (connectionId: unknown): Promise<string> => {
    const [rows] = await root.query(
      `SELECT v.VARIABLE_VALUE AS m FROM performance_schema.variables_by_thread v
         JOIN performance_schema.threads t ON t.THREAD_ID = v.THREAD_ID
        WHERE t.PROCESSLIST_ID = ? AND v.VARIABLE_NAME = 'sql_mode'`,
      [Number(connectionId)],
    );
    return String((rows as any[])[0]?.m);
  };

  it('a new agent session runs without it (also after the pooled reset), and the backslash payload is refused', async () => {
    expect(String(await scalar('SELECT @@GLOBAL.sql_mode'))).toContain('NO_BACKSLASH_ESCAPES');
    const first: any = await nbe.broker.query({ env: 'api/dev', sql: 'SELECT CONNECTION_ID()' } as any);
    expect(first.status).toBe('succeeded');
    const id = first.results[0].rows[0][0];
    const mode = await sessionSqlMode(id);
    expect(mode).not.toContain('NO_BACKSLASH_ESCAPES');
    expect(mode).toContain('STRICT_TRANS_TABLES'); // the rest of the mode is kept

    for (const sql of [
      "SET @a = 'x\\', GLOBAL max_connections = 43, @b = 'y'",
      "SET @a = 'x\\', GLOBAL offline_mode = ON, @b = 'y'",
      "SELECT 'x\\', (SELECT GET_LOCK('au', 0)), 'y'",
    ]) {
      for (const env of ['api/dev', 'api/pro']) {
        const code = await refusedCode(nbe.broker.query({ env, sql, reason: 'test' } as any));
        expect(code, `${env}: ${sql}`).not.toMatch(/^(ran:|unexpected)/);
      }
      expect(await refusedCode(nbe.broker.query({ env: 'api/dev', sql, write: true, reason: 'test' } as any)), sql).not.toMatch(/^(ran:|unexpected)/);
    }
    // the same pooled connection after COM_RESET_CONNECTION (which brings the global sql_mode back)
    const again: any = await nbe.broker.query({ env: 'api/dev', sql: 'SELECT CONNECTION_ID()' } as any);
    expect(String(again.results[0].rows[0][0])).toBe(String(id));
    expect(await sessionSqlMode(id)).not.toContain('NO_BACKSLASH_ESCAPES');
    expect(nbe.broker.snapshot().pending).toHaveLength(0);
    expect(await globals()).toEqual({ maxConnections: saved.maxConnections, offline: saved.offline });
  });

  it('a new read-only tab also runs without it and refuses the payload', async () => {
    await manager.open('c-ro', 'pro');
    const m = await run('c-ro', 'SELECT @@SESSION.sql_mode');
    expect(String(m.results[0]!.rows![0]![0])).not.toContain('NO_BACKSLASH_ESCAPES');
    const r = await run('c-ro', "SET @a = 'x\\', GLOBAL max_connections = 43, @b = 'y'");
    expect(r.results[0]!.error?.code).toBe('REFUSED');
    await manager.close('c-ro');
    expect(await globals()).toEqual({ maxConnections: saved.maxConnections, offline: saved.offline });
  });
});

describe('pooled read sessions are reset between requests', () => {
  it('a user variable from request 1 is NULL in request 2; utf8mb4 and read-only are back', async () => {
    const one: any = await plain.broker.query({ env: 'api/dev', sql: "SET @au_v = 42, @au_s = 'kept?'; SELECT @au_v, CONNECTION_ID()" } as any);
    expect(one.status).toBe('succeeded');
    expect(one.results[1].rows[0].map(String)[0]).toBe('42');
    const id = String(one.results[1].rows[0][1]);

    const two: any = await plain.broker.query({
      env: 'api/dev',
      sql: 'SELECT @au_v, @au_s, @@character_set_client, @@SESSION.transaction_read_only, @@SESSION.autocommit, CONNECTION_ID()',
    } as any);
    expect(two.status).toBe('succeeded');
    const [v, s, charset, ro, ac, id2] = two.results[0].rows[0];
    expect(String(id2)).toBe(id); // same pooled connection, so the reset (not a new connection) cleared it
    expect(v).toBeNull();
    expect(s).toBeNull();
    expect(charset).toBe('utf8mb4');
    expect(String(ro)).toBe('1');
    expect(String(ac)).toBe('1');
  });
});

describe('agent writes: transactional or nothing', () => {
  // Not covered here: an INSERT into a MyISAM table. On MySQL 8.4 with autocommit=0 the OK packet still carries
  // SERVER_STATUS_IN_TRANS, so the request reaches awaiting_commit instead of failing with non_transactional_write.
  const approveAndSettle = async (r: Rig, sql: string) => {
    const res: any = await r.broker.query({ env: 'api/dev', sql, write: true, reason: 'test' } as any);
    expect(res.status).toBe('pending_approval');
    r.broker.approve(res.request_id, { shareResult: true });
    await settle(r, res.request_id);
    return (await r.broker.status({ id: res.request_id })) as any;
  };

  it('an UPDATE on InnoDB matching 0 rows still reaches awaiting_commit (no false non_transactional_write)', async () => {
    const before = JSON.stringify((await admin.query('SELECT id, v FROM au_inno ORDER BY id'))[0]);
    const st = await approveAndSettle(plain, "UPDATE au_inno SET v = 'zero' WHERE id = -1");
    expect(st.status).toBe('awaiting_commit');
    expect(st.error).toBeUndefined();
    await plain.broker.rollback(st.request_id);
    expect(((await plain.broker.status({ id: st.request_id })) as any).status).toBe('rolled_back');
    expect(JSON.stringify((await admin.query('SELECT id, v FROM au_inno ORDER BY id'))[0])).toBe(before);
  });

  it('UPDATE performance_schema.setup_consumers is refused (system_schema) and nothing changed', async () => {
    const consumers = async () => JSON.stringify((await root.query('SELECT NAME, ENABLED FROM performance_schema.setup_consumers ORDER BY NAME'))[0]);
    const before = await consumers();
    for (const [sql, database] of [
      ["UPDATE performance_schema.setup_consumers SET ENABLED = 'NO'", undefined],
      ["UPDATE `performance_schema`.`setup_consumers` SET ENABLED = 'NO' WHERE NAME LIKE '%'", undefined],
      ["UPDATE setup_consumers SET ENABLED = 'NO'", 'performance_schema'],
    ] as [string, string | undefined][]) {
      for (const r of [plain, rig]) {
        const code = await refusedCode(r.broker.query({ env: 'api/dev', sql, write: true, reason: 'test', ...(database ? { database } : {}) } as any));
        expect(code, sql).toBe('system_schema');
      }
    }
    expect(plain.broker.snapshot().pending).toHaveLength(0);
    expect(await consumers()).toBe(before);
  });
});

describe("the person's Transação tab cannot be turned into autocommit; AND CHAIN only in Transação", () => {
  it('SET `autocommit`=1 (every spelling) is refused and the open transaction is still uncommitted', async () => {
    await manager.open('f-tx', 'dev');
    await manager.setMode('f-tx', 'transaction');
    const ins = await run('f-tx', "INSERT INTO au_inno (v) VALUES ('f-tx')");
    expect(ins.results[0]!.error).toBeUndefined();
    expect(ins.session.transaction.open).toBe(true);
    for (const sql of [
      'SET `autocommit`=1',
      'SET @@session.`autocommit` = 1',
      'SET @@SESSION . autocommit = 1',
      'SET /* x */ autocommit = 1',
      "SET @a = 1, `autocommit` = 'ON'",
      'SET `completion_type` = 1',
      'SET `transaction_read_only` = 0',
    ]) {
      const r = await run('f-tx', sql);
      expect(r.results[0]!.error?.code, sql).toBe('REFUSED');
    }
    expect(manager.state('f-tx').transaction.open).toBe(true);
    expect(Number((await admin.query("SELECT COUNT(*) n FROM au_inno WHERE v = 'f-tx'"))[0][0].n)).toBe(0);
    const ac = await run('f-tx', 'SELECT @@SESSION.autocommit');
    expect(String(ac.results[0]!.rows![0]![0])).toBe('0');
    await manager.rollback('f-tx');
    expect(Number((await admin.query("SELECT COUNT(*) n FROM au_inno WHERE v = 'f-tx'"))[0][0].n)).toBe(0);
    await manager.close('f-tx');
  });

  it('COMMIT / ROLLBACK AND CHAIN are refused in Auto-commit and Somente leitura', async () => {
    await manager.open('f-ac', 'dev');
    await manager.open('f-ro', 'pro');
    for (const tab of ['f-ac', 'f-ro']) {
      for (const sql of ['COMMIT AND CHAIN', 'COMMIT WORK AND CHAIN', 'ROLLBACK AND CHAIN', 'COMMIT AND NO RELEASE AND CHAIN']) {
        const r = await run(tab, sql);
        expect(r.results[0]!.error?.code, `${tab}: ${sql}`).toBe('REFUSED');
      }
    }
    // the Auto-commit tab is still in autocommit, no transaction was chained open
    expect(String((await run('f-ac', 'SELECT @@SESSION.autocommit')).results[0]!.rows![0]![0])).toBe('1');
    await run('f-ac', "INSERT INTO au_inno (v) VALUES ('f-ac')");
    expect(Number((await admin.query("SELECT COUNT(*) n FROM au_inno WHERE v = 'f-ac'"))[0][0].n)).toBe(1);
    await root.query("DELETE FROM au_inno WHERE v = 'f-ac'");
    await manager.close('f-ac');
    await manager.close('f-ro');
  });
});

describe('read-only tab: the client character set cannot leave utf8mb4', () => {
  it('SET NAMES latin1 is refused and the session stays utf8mb4 and read-only', async () => {
    await manager.open('g-ro', 'pro');
    for (const sql of ['SET NAMES latin1', 'SET NAMES gbk', 'SET CHARACTER SET latin1', 'SET CHARSET sjis', 'SET NAMES utf8mb4 COLLATE latin1_swedish_ci', 'SET character_set_client = latin1']) {
      expect((await run('g-ro', sql)).results[0]!.error?.code, sql).toBe('REFUSED');
    }
    expect((await run('g-ro', 'SET NAMES utf8mb4')).results[0]!.error).toBeUndefined();
    const r = await run('g-ro', 'SELECT @@character_set_client, @@SESSION.transaction_read_only');
    expect(r.results[0]!.rows).toEqual([['utf8mb4', '1']]);
    await manager.close('g-ro');
  });
});

describe('a 15-minute read grant always shares the result', () => {
  it('approve with grantReads and shareResult false is refused; nothing runs and no grant exists', async () => {
    const res: any = await plain.broker.query({ env: 'api/pro', sql: 'SELECT COUNT(*) FROM au_inno', reason: 'test' } as any);
    expect(res.status).toBe('pending_approval');
    let code = 'none';
    try {
      plain.broker.approve(res.request_id, { shareResult: false, grantReads: true });
    } catch (e: any) {
      code = e.code;
    }
    expect(code).toBe('grant_not_applicable');
    expect(((await plain.broker.status({ id: res.request_id })) as any).status).toBe('pending_approval');
    expect(plain.broker.snapshot().grants).toHaveLength(0);
    expect(plain.audit.some((e) => e.mode === 'grant')).toBe(false);

    // approving it without a grant (result withheld) runs this one only: the next production read waits again
    plain.broker.approve(res.request_id, { shareResult: false });
    await settle(plain, res.request_id);
    const done: any = await plain.broker.status({ id: res.request_id });
    expect(done.status).toBe('succeeded');
    expect(done.result_withheld).toBe(true);
    const next: any = await plain.broker.query({ env: 'api/pro', sql: 'SELECT v FROM au_inno', reason: 'test' } as any);
    expect(next.status).toBe('pending_approval');
    expect(plain.broker.snapshot().grants).toHaveLength(0);

    // with sharing on, the grant works and later reads run under it, sharing their result
    plain.broker.approve(next.request_id, { shareResult: true, grantReads: true });
    await settle(plain, next.request_id);
    expect(plain.broker.snapshot().grants).toHaveLength(1);
    const under: any = await plain.broker.query({ env: 'api/pro', sql: 'SELECT v FROM au_inno ORDER BY id' } as any);
    expect(under.status).toBe('succeeded');
    expect(under.result_withheld).toBeUndefined();
    expect(under.results[0].rows.length).toBeGreaterThan(0);
    expect(plain.audit.filter((e) => e.mode === 'grant' && e.shareResult === false)).toHaveLength(0);
  });
});

// --- lexer edge cases, procedures and invisible triggers ----------------------------------------

describe('"*/" outside an executable comment: SET PERSIST hidden in a fake string', () => {
  it('agents and the read-only tab refuse it and max_connections stays put', async () => {
    const before = await globals();
    for (const sql of ["SET @a = 2 */* ' */ 1, GLOBAL max_connections = 7 /* ' */", "SELECT 2 */* ' */ 1, authentication_string FROM mysql.user /* ' */"]) {
      expect(await refusedCode(rig.broker.query({ env: 'api/dev', sql })), sql).not.toMatch(/^ran:|^unexpected/);
    }
    await manager.open('i-ro', 'pro');
    const r = await run('i-ro', "SET @a = 2 */* ' */ 1, GLOBAL max_connections = 7 /* ' */");
    expect(r.results[0]!.error?.code).toBe('REFUSED');
    await manager.close('i-ro');
    expect(await globals()).toEqual(before);
  });
});

describe("the person's Transação tab: a procedure that turns autocommit on", () => {
  it('the tab puts autocommit back to 0 and says what happened', async () => {
    await root.query('CREATE PROCEDURE au_ac_on() BEGIN SET autocommit = 1; END');
    await manager.open('j-tx', 'dev');
    await manager.setMode('j-tx', 'transaction');
    const call = await run('j-tx', 'CALL au_ac_on()', { confirmed: true });
    expect(call.results[0]!.error).toBeUndefined();
    expect(call.results[0]!.notice).toMatch(/ligou o autocommit/);
    const ac = await run('j-tx', 'SELECT @@SESSION.autocommit');
    expect(String(ac.results[0]!.rows![0]![0])).toBe('0');
    const ins = await run('j-tx', "INSERT INTO au_inno (v) VALUES ('j-tx')");
    expect(ins.session.transaction.open).toBe(true);
    expect(Number((await admin.query("SELECT COUNT(*) n FROM au_inno WHERE v = 'j-tx'"))[0][0].n)).toBe(0);
    await manager.rollback('j-tx');
    await manager.close('j-tx');
  });

  it('SHOW WARNINGS keeps the warnings of the statement before it (no per-statement prelude for the person)', async () => {
    await manager.open('j-w', 'dev');
    await manager.setMode('j-w', 'transaction');
    const r = await run('j-w', "INSERT IGNORE INTO au_inno (id, v) VALUES (1, 'dup'); SHOW WARNINGS");
    expect(r.results[1]!.rows!.length).toBeGreaterThan(0);
    await manager.rollback('j-w');
    await manager.close('j-w');
  });
});

describe('introspection knows where triggers are invisible', () => {
  it('root sees every database; a DML-only account does not; a grant written `cais\\_test` (escaped) counts', async () => {
    const asRoot = await mysqlDriver.introspect(rootParams());
    expect(asRoot.databases.every((d) => d.triggersVisible === true)).toBe(true);
    // the regular test user has ALL on `cais\_test`.* (TRIGGER included), granted with the escaped name
    const asUser = await mysqlDriver.introspect(params());
    expect(asUser.databases.find((d) => d.name === f.database)!.triggersVisible).toBe(true);
    await root.query("DROP USER IF EXISTS 'au_dml'@'%'");
    await root.query("CREATE USER 'au_dml'@'%' IDENTIFIED BY 'au-dml-pw'");
    await root.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${f.database}.* TO 'au_dml'@'%'`);
    try {
      const asDml = await mysqlDriver.introspect(params({ user: 'au_dml', password: 'au-dml-pw' }));
      expect(asDml.databases.find((d) => d.name === f.database)!.triggersVisible).toBe(false);
      expect(asDml.foreignKeysComplete).toBe(false);
    } finally {
      await root.query("DROP USER IF EXISTS 'au_dml'@'%'");
    }
  });
});
