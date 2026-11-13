// Security guards: agent policy, broker, agent sessions, the person's tabs, scripts and text helpers.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import { MAX_PENDING, READ_GRANT_MS } from '@shared/agents';
import type { Environment } from '@shared/model';
import type { SchemaTree, StatementResult } from '@shared/results';
import { hiddenTextProblem, markInvisible } from '@shared/text';
import { AgentError } from '@main/agents/errors';
import { decide, MESSAGES, type DecideInput } from '@main/agents/policy';
import { AgentSessions, type RunArgs, type WriteRun } from '@main/agents/sessions';
import type { ConnectParams, DbSession, DbSessionError, Driver } from '@main/drivers/types';
import { SessionManager } from '@main/sessions';
import { CatalogStore } from '@main/store/catalog';
import { ScriptStore } from '@main/store/scripts';
import { FakeVault } from '@main/store/vault';
import { FakeClock, FakeExecutor, flush, makeBroker } from '../support/agent-fakes';

const dialect = getDialect('mysql');
const analyze = (sql: string) =>
  dialect.splitStatements(sql).map((s) => ({ text: s.text, c: dialect.classify(s.text), ids: dialect.identifiers(s.text) }));
const d = (sql: string, over: Partial<DecideInput> = {}) =>
  decide({ mode: 'read', production: false, statements: analyze(sql), rules: dialect.agentRules, reason: 'r', pendingCount: 0, grantActive: false, ...over });

const refused = async (p: Promise<unknown>): Promise<AgentError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AgentError);
    return e as AgentError;
  }
  throw new Error('expected a refusal');
};

// --- policy ------------------------------------------------------------------------------------

describe('policy: executable comments', () => {
  it.each(['SELECT /*!50000 1 */', 'SELECT /*! 1 */', 'SELECT /*M! 1 */', 'SELECT 1 /*!80000 , SLEEP(1) */', 'UPDATE t SET a = 1 /*!99999 , b = 2 */ WHERE id = 1'])(
    'refuses %s in read and write mode',
    (sql) => {
      for (const mode of ['read', 'write'] as const) {
        expect(d(sql, { mode }), `${mode}: ${sql}`).toEqual({ action: 'refuse', code: 'executable_comment', message: MESSAGES.executableComment });
      }
    },
  );

  it('an ordinary comment is not an executable one', () => {
    expect(d('SELECT /* plain */ 1')).toEqual({ action: 'run' });
  });
});

describe('policy: functions agents never call', () => {
  it.each(["SELECT GET_LOCK('a', 1)", "SELECT RELEASE_LOCK('a')", 'SELECT RELEASE_ALL_LOCKS()', 'SELECT SLEEP(1)', "SELECT BENCHMARK(10, MD5('a'))", "SELECT LOAD_FILE('/etc/passwd')", 'SELECT `sleep` (1)', 'select get_lock ("x", 0)'])(
    'refuses %s with function_not_allowed and names the function',
    (sql) => {
      const out = d(sql);
      expect(out).toMatchObject({ action: 'refuse', code: 'function_not_allowed' });
      const name = /(GET_LOCK|RELEASE_ALL_LOCKS|RELEASE_LOCK|SLEEP|BENCHMARK|LOAD_FILE)/i.exec(sql)![1]!.toUpperCase();
      expect((out as { message: string }).message).toBe(MESSAGES.functionNotAllowed(name));
    },
  );

  it('refuses SET_VAR and MAX_EXECUTION_TIME optimizer hints', () => {
    for (const sql of ['SELECT /*+ SET_VAR(sort_buffer_size = 16M) */ * FROM t', 'SELECT /*+ MAX_EXECUTION_TIME(100000) */ * FROM t']) {
      expect(d(sql), sql).toEqual({ action: 'refuse', code: 'function_not_allowed', message: MESSAGES.hint });
    }
  });

  it.each([
    "UPDATE t SET a = SOURCE_POS_WAIT('binlog.000001', 4) WHERE id = 1",
    "UPDATE t SET a = MASTER_POS_WAIT('binlog.000001', 4) WHERE id = 1",
    "UPDATE t SET a = WAIT_FOR_EXECUTED_GTID_SET('uuid:1-5') WHERE id = 1",
    "INSERT INTO t VALUES (ASYNCHRONOUS_CONNECTION_FAILOVER_ADD_SOURCE('ch', 'h', 3306, '', 50))",
    "UPDATE t SET a = keyring_key_remove('k', '') WHERE id = 1",
    "DELETE FROM t WHERE id = GROUP_REPLICATION_SET_AS_PRIMARY('uuid')",
    "UPDATE t SET a = SERVICE_GET_WRITE_LOCKS('ns', 'x', 10) WHERE id = 1",
  ])('refuses the server-state function in a write: %s', (sql) => {
    expect(d(sql, { mode: 'write' })).toMatchObject({ action: 'refuse', code: 'function_not_allowed' });
    expect(d(sql, { mode: 'read' })).toMatchObject({ action: 'refuse', code: 'function_not_allowed' });
  });

  it('ordinary functions stay allowed', () => {
    expect(d('SELECT COUNT(*), NOW(), CONCAT(a, b) FROM t')).toEqual({ action: 'run' });
    expect(d('UPDATE t SET a = UPPER(a) WHERE id = 1', { mode: 'write' })).toEqual({ action: 'approve' });
  });
});

describe('policy: system schemas', () => {
  it.each([
    "UPDATE mysql.user SET authentication_string = '' WHERE user = 'x'",
    "INSERT INTO performance_schema.setup_instruments VALUES ('x', 'YES', 'YES')",
    "DELETE FROM sys.sys_config WHERE variable = 'x'",
    'UPDATE `information_schema`.`tables` SET a = 1 WHERE id = 1',
    "REPLACE INTO `MySQL`.db VALUES ('x')",
  ])('agents never write to a system schema: %s', (sql) => {
    expect(d(sql, { mode: 'write' })).toEqual({ action: 'refuse', code: 'system_schema', message: dialect.agentRules.messages.systemSchemaWrite });
  });

  it('a write with --database set to a system schema is refused', () => {
    for (const database of ['mysql', 'performance_schema', 'SYS', 'information_schema']) {
      expect(d('UPDATE t SET a = 1 WHERE id = 1', { mode: 'write', database }), database).toMatchObject({ action: 'refuse', code: 'system_schema' });
    }
    expect(d('UPDATE t SET a = 1 WHERE id = 1', { mode: 'write', database: 'app' })).toEqual({ action: 'approve' });
  });

  it('agents never read the mysql schema, by identifier or by --database; other system schemas stay readable', () => {
    expect(d('SELECT user, authentication_string FROM mysql.user')).toEqual({ action: 'refuse', code: 'system_schema', message: dialect.agentRules.messages.systemSchemaRead });
    expect(d('SELECT * FROM `mysql`.`user`')).toMatchObject({ code: 'system_schema' });
    expect(d('SELECT * FROM user', { database: 'MySQL' })).toMatchObject({ code: 'system_schema' });
    expect(d('SELECT * FROM performance_schema.threads')).toEqual({ action: 'run' });
    expect(d('SELECT * FROM information_schema.tables')).toEqual({ action: 'run' });
  });
});

// --- broker ------------------------------------------------------------------------------------

describe('broker: SQL text the person cannot read honestly', () => {
  it.each([
    ['zero-width space', "SELECT 'a​b'"],
    ['Arabic letter mark', 'SELECT 1 ؜'],
    ['tag character', 'SELECT 1 -- \u{E0041}'],
    ['lone CR', 'SELECT 1 -- x\rDELETE FROM t'],
    ['line separator', 'SELECT 1 -- x DELETE FROM t'],
    ['vertical tab', 'SELECT 1\u000b'],
    ['C1 control', 'SELECT 1\u0090'],
  ])('query with a %s is refused as hidden_text, audited, and never reaches the executor', async (_name, sql) => {
    const h = makeBroker();
    expect((await refused(h.broker.query({ env: 'api/dev', sql }))).code).toBe('hidden_text');
    expect(h.executor.reads.length + h.executor.writes.length).toBe(0);
    expect(h.audit.at(-1)).toMatchObject({ state: 'refused', errorCode: 'hidden_text' });
  });

  it('raw /*! or /*M! anywhere (even inside a string) is refused as executable_comment for query', async () => {
    const h = makeBroker();
    for (const sql of ["SELECT '/*!'", "SELECT 'x' -- /*M! y", 'SELECT /*!50000 1 */']) {
      expect((await refused(h.broker.query({ env: 'api/dev', sql }))).code, sql).toBe('executable_comment');
    }
    expect(h.executor.reads).toHaveLength(0);
  });

  it('script save refuses hidden text and raw executable comments', async () => {
    const h = makeBroker();
    for (const sql of ["SELECT 'a​b'", 'SELECT 1\rDROP TABLE t', "SELECT '/*!'", 'SELECT /*M! 1 */ 2']) {
      expect((await refused(h.broker.scriptSave({ project: 'api', name: `s${sql.length}`, sql }))).code, JSON.stringify(sql)).toBe('invalid_script');
    }
    expect(h.scripts).toHaveLength(0);
  });

  it('--database over 64 characters or with hidden text is refused', async () => {
    const h = makeBroker();
    expect((await refused(h.broker.query({ env: 'api/dev', sql: 'SELECT 1', database: 'a'.repeat(65) }))).code).toBe('invalid_database');
    expect((await refused(h.broker.query({ env: 'api/dev', sql: 'SELECT 1', database: 'ap​p' }))).code).toBe('invalid_database');
    expect(((await h.broker.query({ env: 'api/dev', sql: 'SELECT 1', database: 'a'.repeat(64) })) as any).status).toBe('succeeded');
  });
});

describe('broker: script-save follows the agent write policy', () => {
  it.each([
    'DROP TABLE t',
    'CREATE TABLE x (a INT)',
    'SET autocommit = 0',
    'COMMIT',
    'START TRANSACTION',
    'SELECT SLEEP(10)',
    "SELECT GET_LOCK('a', 1)",
    "UPDATE mysql.user SET authentication_string = '' WHERE user = 'x'",
    'SELECT /*+ SET_VAR(sort_buffer_size = 1) */ 1',
    'CALL proc()',
    'KILL 1',
  ])('refuses %s', async (sql) => {
    const h = makeBroker();
    expect((await refused(h.broker.scriptSave({ project: 'api', name: 'x', sql }))).code).toBe('invalid_script');
    expect(h.scripts).toHaveLength(0);
    expect(h.events.scriptsChanged).toBe(0);
  });

  it('accepts reads and plain DML (and an empty script)', async () => {
    const h = makeBroker();
    const ok = ['SELECT * FROM cards', 'UPDATE cards SET a = 1 WHERE id = 1', "INSERT INTO t VALUES (1); DELETE FROM t WHERE id = 2", '-- só um comentário'];
    for (const [i, sql] of ok.entries()) {
      expect((await h.broker.scriptSave({ project: 'api', name: `ok${i}`, sql })) as any, sql).toMatchObject({ created_by: 'agent' });
    }
    expect(h.scripts).toHaveLength(ok.length);
  });

  it('allows at most 2 consecutive blank lines (with or without spaces, LF or CRLF)', async () => {
    const h = makeBroker();
    await h.broker.scriptSave({ project: 'api', name: 'two', sql: 'SELECT 1;\n\n\nSELECT 2;' });
    await h.broker.scriptSave({ project: 'api', name: 'two-crlf', sql: 'SELECT 1;\r\n\r\n\r\nSELECT 2;' });
    for (const sql of ['SELECT 1;\n\n\n\nSELECT 2;', 'SELECT 1;\n  \n\t\n \nSELECT 2;', 'SELECT 1;\r\n\r\n\r\n\r\nSELECT 2;', `SELECT 1;${'\n'.repeat(300)}DELETE FROM t WHERE id = 1;`]) {
      const e = await refused(h.broker.scriptSave({ project: 'api', name: `many${sql.length}`, sql }));
      expect(e.code, JSON.stringify(sql.slice(0, 30))).toBe('invalid_script');
      expect(e.message).toContain('linhas em branco');
    }
    expect(h.scripts.map((s) => s.name)).toEqual(['two', 'two-crlf']);
  });
});

describe('broker: 15-minute grants', () => {
  async function openGrant(h: ReturnType<typeof makeBroker>) {
    const r = (await h.broker.query({ env: 'api/pro', sql: 'SELECT 1', reason: 'r' })) as any;
    h.broker.approve(r.request_id, { shareResult: true, grantReads: true });
    await flush();
    return r.request_id as string;
  }
  const grantEvents = (h: ReturnType<typeof makeBroker>) => h.audit.filter((a) => a.mode === 'grant');

  it('a grant requires sharing the result: refused with grant_not_applicable, nothing audited, nothing granted', async () => {
    const h = makeBroker();
    const r = (await h.broker.query({ env: 'api/pro', sql: 'SELECT 1', reason: 'r' })) as any;
    let err: unknown;
    try {
      h.broker.approve(r.request_id, { shareResult: false, grantReads: true });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'grant_not_applicable' });
    expect(grantEvents(h)).toEqual([]);
    expect(h.broker.snapshot().grants).toEqual([]);
    expect(h.executor.reads).toHaveLength(0);
  });

  it('created is audited with the request id and the sharing choice; reads under it are decidedBy "grant"', async () => {
    const h = makeBroker();
    const id = await openGrant(h);
    expect(grantEvents(h)).toEqual([
      expect.objectContaining({ requestId: id, mode: 'grant', state: 'created', decidedBy: 'user', environment: 'api/pro', production: true, shareResult: true, client: 'pessoa' }),
    ]);
    const direct = (await h.broker.query({ env: 'api/pro', sql: 'SELECT 2', client: 'Claude Code' })) as any;
    expect(direct.status).toBe('succeeded');
    expect(h.audit.at(-1)).toMatchObject({ id: direct.request_id, state: 'succeeded', decidedBy: 'grant', production: true });
    expect(h.broker.snapshot().recent.find((v) => v.id === direct.request_id)!.decidedBy).toBe('grant');
    // outside production a direct read is still the policy's decision
    await h.broker.query({ env: 'api/dev', sql: 'SELECT 3' });
    expect(h.audit.at(-1)).toMatchObject({ decidedBy: 'policy' });
  });

  it('revoked, expired, environment_changed, access_off and shutdown end a grant and are each audited', async () => {
    const h = makeBroker();
    await openGrant(h);
    h.broker.revokeGrant('e-pro');
    expect(grantEvents(h).at(-1)).toMatchObject({ state: 'revoked', decidedBy: 'user', mode: 'grant' });

    await openGrant(h);
    await h.clock.advance(READ_GRANT_MS);
    expect(grantEvents(h).at(-1)).toMatchObject({ state: 'expired', decidedBy: 'timeout' });

    await openGrant(h);
    await h.broker.environmentChanged('e-pro');
    expect(grantEvents(h).at(-1)).toMatchObject({ state: 'environment_changed', decidedBy: 'environment' });

    await openGrant(h);
    await h.broker.disable();
    expect(grantEvents(h).at(-1)).toMatchObject({ state: 'access_off', decidedBy: 'shutdown' });

    const s = makeBroker();
    await openGrant(s);
    await s.broker.shutdown();
    expect(grantEvents(s).at(-1)).toMatchObject({ state: 'shutdown', decidedBy: 'shutdown' });

    expect(grantEvents(h).map((e) => e.state)).toEqual(['created', 'revoked', 'created', 'expired', 'created', 'environment_changed', 'created', 'access_off']);
  });
});

describe('broker: queue reservation while the schema loads', () => {
  it(`two writes racing for the last of ${MAX_PENDING} places: only one gets it`, async () => {
    const h = makeBroker();
    for (let i = 0; i < MAX_PENDING - 1; i++) await h.broker.query({ env: 'api/pro', sql: `SELECT ${i}`, reason: 'r' });
    let open!: () => void;
    let schemaCalls = 0;
    h.executor.schema = () => {
      schemaCalls++;
      return new Promise<SchemaTree>((resolve) => (open = () => resolve(h.executor.tree)));
    };
    const a = h.broker.query({ env: 'api/dev', sql: 'UPDATE t SET a = 1 WHERE id = 1', write: true, reason: 'r' });
    const b = h.broker.query({ env: 'api/dev', sql: 'UPDATE t SET a = 2 WHERE id = 1', write: true, reason: 'r' });
    expect((await refused(b)).code).toBe('queue_full');
    expect(schemaCalls).toBe(1);
    open();
    expect(((await a) as any).status).toBe('pending_approval');
    expect(h.broker.snapshot().pending).toHaveLength(MAX_PENDING);
    expect((await refused(h.broker.query({ env: 'api/pro', sql: 'SELECT 99', reason: 'r' }))).code).toBe('queue_full');
  });

  it('access turned off while the schema loads: the request is refused and nothing stays pending', async () => {
    const h = makeBroker();
    let open!: () => void;
    h.executor.schema = () => new Promise<SchemaTree>((resolve) => (open = () => resolve(h.executor.tree)));
    const a = h.broker.query({ env: 'api/dev', sql: 'UPDATE t SET a = 1 WHERE id = 1', write: true, reason: 'r' });
    await flush();
    await h.broker.disable();
    open();
    expect((await refused(a)).code).toBe('agent_access_off');
    expect(h.broker.snapshot().pending).toEqual([]);
  });
});

describe('broker: commit after a connection loss', () => {
  class CommitFails extends FakeExecutor {
    constructor(private readonly error: Error) {
      super();
    }
    override async runWrite(env: Environment, args: RunArgs): Promise<WriteRun> {
      const run = await super.runWrite(env, args);
      return { ...run, commit: async () => { throw this.error; } };
    }
  }

  async function openWrite(executor: FakeExecutor) {
    const h = makeBroker({ executor });
    const r = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE t SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    h.broker.approve(r.request_id, { shareResult: true });
    await flush();
    expect(((await h.broker.status({ id: r.request_id })) as any).status).toBe('awaiting_commit');
    return { h, id: r.request_id as string };
  }

  it('maps commit_unknown to a failed request that says so (never "commit_failed")', async () => {
    const { h, id } = await openWrite(new CommitFails(new AgentError('Não foi possível confirmar o commit: a conexão caiu depois do envio.', 'commit_unknown')));
    const view = await h.broker.commit(id);
    expect(view.status).toBe('failed');
    expect(view.errorMessage).toContain('Não foi possível confirmar o commit');
    const st = (await h.broker.status({ id })) as any;
    expect(st.error).toMatchObject({ code: 'commit_unknown' });
    expect(h.audit.at(-1)).toMatchObject({ state: 'failed', errorCode: 'commit_unknown' });
  });

  it('any other commit error is commit_failed', async () => {
    const { h, id } = await openWrite(new CommitFails(new Error('boom')));
    await h.broker.commit(id);
    expect(((await h.broker.status({ id })) as any).error).toMatchObject({ code: 'commit_failed' });
  });
});

describe('broker: non-transactional warnings for views and triggers', () => {
  const tree = (): SchemaTree => ({
    databases: [{
      name: 'app',
      tables: [
        { name: 'legacy_log', type: 'table', engine: 'MyISAM', columns: [] },
        { name: 'cards', type: 'table', engine: 'InnoDB', columns: [], triggers: ['BEGIN INSERT INTO legacy_log (id) VALUES (NEW.id); END'] },
        { name: 'v_log', type: 'view', columns: [], uses: ['app.legacy_log'] },
        { name: 'v_cards', type: 'view', columns: [], uses: ['app.cards'] },
        { name: 'plain', type: 'table', engine: 'InnoDB', columns: [] },
        { name: '2fa_codes', type: 'table', engine: 'MEMORY', columns: [] },
      ],
    }],
  });
  const warningsFor = async (h: ReturnType<typeof makeBroker>, sql: string) => {
    const r = (await h.broker.query({ env: 'api/dev', sql, write: true, reason: 'r' })) as any;
    return h.broker.snapshot().pending.find((p) => p.id === r.request_id)!.warnings;
  };

  it('warns for a view over a non-transactional table', async () => {
    const h = makeBroker();
    h.executor.tree = tree();
    expect(await warningsFor(h, 'UPDATE v_log SET a = 1 WHERE id = 1')).toContain(
      'A view v_log usa a tabela não transacional app.legacy_log: o Rollback não desfaz o que for gravado por ela.',
    );
  });

  it('warns for a table whose trigger writes to a non-transactional table', async () => {
    const h = makeBroker();
    h.executor.tree = tree();
    expect(await warningsFor(h, 'UPDATE cards SET a = 1 WHERE id = 1')).toContain(
      'Um trigger da tabela cards grava em legacy_log, que não é transacional (MyISAM): o Rollback não desfaz isso.',
    );
  });

  it('sees table names that start with a digit', async () => {
    const h = makeBroker();
    h.executor.tree = tree();
    expect(await warningsFor(h, 'DELETE FROM 2fa_codes WHERE id = 1')).toContain(
      'A tabela 2fa_codes não é transacional (MEMORY): o Rollback não desfaz o que for gravado nela.',
    );
  });

  it('stays quiet for InnoDB tables, and follows a view to the triggers of its table', async () => {
    const h = makeBroker();
    h.executor.tree = tree();
    expect(await warningsFor(h, 'UPDATE plain SET a = 1 WHERE id = 1')).toEqual([]);
    expect(await warningsFor(h, 'UPDATE v_cards SET a = 1 WHERE id = 1')).toEqual([
      'Um trigger da tabela cards grava em legacy_log, que não é transacional (MyISAM): o Rollback não desfaz isso.',
    ]);
  });

  it('fails closed: when the schema cannot be read, the request warns that the Rollback may not undo everything', async () => {
    const h = makeBroker();
    h.executor.schema = async () => {
      throw new AgentError('x', 'connection_failed');
    };
    expect(await warningsFor(h, 'UPDATE t SET a = 1 WHERE id = 1')).toContain(
      'Não foi possível verificar se as tabelas são transacionais: o Rollback pode não desfazer tudo.',
    );
  });
});

// --- AgentSessions against a controllable fake driver ------------------------------------------

/** A fake session: statements matching HANG wait for `release` (or a KILL); `onExecute` can move a clock. */
class CtlSession implements DbSession {
  serverVersion = 'fake';
  executed: string[] = [];
  modes: string[] = [];
  limits: { maxExecutionMs?: number; lockWaitSeconds?: number }[] = [];
  resets = 0;
  resetError?: Error;
  modeError?: Error;
  limitsError?: Error;
  commits = 0;
  rollbacks = 0;
  cancels = 0;
  closed = false;
  destroyed = false;
  lastRollbackIncomplete = false;
  result: (sql: string) => Partial<StatementResult> = () => ({ inTransaction: true });
  onExecute?: (sql: string) => void;
  private held?: (r: Partial<StatementResult>) => void;
  private fatal: ((e: DbSessionError) => void)[] = [];
  async applyMode(mode: string) {
    this.modes.push(mode);
    if (this.modeError) throw this.modeError;
  }
  async applyLimits(l: { maxExecutionMs?: number; lockWaitSeconds?: number }) {
    this.limits.push(l);
    if (this.limitsError) throw this.limitsError;
  }
  useDatabase(name: string): Promise<StatementResult> {
    return this.execute(`USE ${'`' + name.replace(/`/g, '``') + '`'}`);
  }

  async transactionProbe(): Promise<boolean | undefined> {
    return (await this.execute('DO 0').catch(() => undefined))?.inTransaction;
  }

  async execute(sql: string): Promise<StatementResult> {
    this.executed.push(sql);
    this.onExecute?.(sql);
    const extra = /HANG/.test(sql) ? await new Promise<Partial<StatementResult>>((r) => (this.held = r)) : this.result(sql);
    return { index: 0, sql, kind: 'other', verb: '', durationMs: 1, ...extra };
  }
  release(extra: Partial<StatementResult>) {
    const h = this.held;
    this.held = undefined;
    h?.(extra);
  }
  async cancel() {
    this.cancels++;
    this.release({ error: { message: 'Query cancelada.', code: 'CANCELLED' } });
  }
  async commit() {
    this.commits++;
  }
  async rollback() {
    this.rollbacks++;
  }
  /** Like the server: the database the connection opened in ('app'), then whatever USE chose. */
  db: string | null = 'app';
  async currentDatabase() {
    return this.db;
  }
  onFatalError(cb: (e: DbSessionError) => void) {
    this.fatal.push(cb);
  }
  async close() {
    this.closed = true;
  }
  async reset() {
    this.resets++;
    if (this.resetError) throw this.resetError;
  }
  destroy() {
    this.destroyed = true;
    this.release({ error: { message: 'Conexão perdida.', code: 'PROTOCOL_CONNECTION_LOST', fatal: true } });
  }
}

const agentEnv: Environment = { id: 'e1', projectId: 'p', name: 'dev', engine: 'mysql', host: 'db.internal.example', port: 3306, defaultDatabase: 'app', credentialId: 'c', production: false };

function ctlHarness(prepare: (s: CtlSession, n: number) => void = () => undefined) {
  const clock = new FakeClock();
  const opened: { session: CtlSession; params: ConnectParams }[] = [];
  let resolveCalls = 0;
  const driver: Driver = {
    engine: 'mysql',
    open: async (params) => {
      const session = new CtlSession();
      prepare(session, opened.length);
      opened.push({ session, params });
      return session;
    },
    introspect: async () => ({ databases: [] }),
    test: async () => ({ serverVersion: 'x' }),
  };
  const sessions = new AgentSessions({
    getDriver: () => driver,
    resolveConnectParams: async () => {
      resolveCalls++;
      return { host: 'h', port: 1, user: 'u', password: `token-${resolveCalls}`, tls: 'off' };
    },
    scheduler: clock,
    now: () => clock.now,
  });
  return { sessions, opened, clock, resolveCalls: () => resolveCalls };
}
const reads = (...texts: string[]) => texts.map((text) => ({ text, verb: 'SELECT', kind: 'read' as const }));
const updates = (...texts: string[]) => texts.map((text) => ({ text, verb: 'UPDATE', kind: 'write' as const }));

describe('AgentSessions: reads reset the pooled connection', () => {
  it('reset() runs after every read request, and the connection is reused', async () => {
    const { sessions, opened } = ctlHarness();
    await sessions.runRead(agentEnv, { statements: reads('SELECT 1'), maxRows: 1 });
    await sessions.runRead(agentEnv, { statements: reads('SELECT 2', 'SELECT 3'), maxRows: 1 });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.session.resets).toBe(2);
  });

  it('a read that fails with a statement error still resets the connection', async () => {
    const { sessions, opened } = ctlHarness((s) => (s.result = (sql) => (/bad/.test(sql) ? { error: { message: 'x', code: 'ER_X' } } : {})));
    const out = await sessions.runRead(agentEnv, { statements: reads('SELECT bad'), maxRows: 1 });
    expect(out.error?.code).toBe('ER_X');
    expect(opened[0]!.session.resets).toBe(1);
  });

  it('when reset fails the connection is dropped and the next read opens a new one', async () => {
    const { sessions, opened } = ctlHarness((s, n) => {
      if (n === 0) s.resetError = new Error('reset failed');
    });
    const out = await sessions.runRead(agentEnv, { statements: reads('SELECT 1'), maxRows: 1 });
    expect(out.error).toBeUndefined();
    expect(opened[0]!.session.closed).toBe(true);
    await sessions.runRead(agentEnv, { statements: reads('SELECT 2'), maxRows: 1 });
    expect(opened).toHaveLength(2);
    expect(opened[1]!.session.executed).toEqual(['SELECT 2']);
  });
});

describe('AgentSessions: setup failures close the session', () => {
  it('a read session whose mode or limits fail is closed and reported as connection_failed', async () => {
    const a = ctlHarness((s) => (s.modeError = new Error('boom')));
    const e1 = (await a.sessions.runRead(agentEnv, { statements: reads('SELECT 1'), maxRows: 1 }).catch((e) => e)) as AgentError;
    expect(e1).toBeInstanceOf(AgentError);
    expect(e1.code).toBe('connection_failed');
    expect(a.opened[0]!.session.closed).toBe(true);
    expect(a.opened[0]!.session.executed).toEqual([]);

    const b = ctlHarness((s) => (s.limitsError = new Error('boom')));
    await expect(b.sessions.runRead(agentEnv, { statements: reads('SELECT 1'), maxRows: 1 })).rejects.toBeInstanceOf(AgentError);
    expect(b.opened[0]!.session.closed).toBe(true);
  });

  it('a write session whose mode or limits fail is closed before anything runs', async () => {
    for (const fail of ['modeError', 'limitsError'] as const) {
      const h = ctlHarness((s) => (s[fail] = new Error('boom')));
      const e = (await h.sessions.runWrite(agentEnv, { statements: updates('UPDATE t SET a = 1 WHERE id = 1'), maxRows: 1 }).catch((x) => x)) as AgentError;
      expect(e, fail).toBeInstanceOf(AgentError);
      expect(h.opened[0]!.session.closed, fail).toBe(true);
      expect(h.opened[0]!.session.executed, fail).toEqual([]);
    }
  });
});

describe('AgentSessions: writes', () => {
  it('a write the server did not keep in the transaction fails with non_transactional_write, rolled back and closed', async () => {
    const h = ctlHarness((s) => (s.result = () => ({ affectedRows: 3, inTransaction: false })));
    const run = await h.sessions.runWrite(agentEnv, { statements: updates('UPDATE legacy SET a = 1 WHERE id = 1', 'UPDATE t SET a = 2 WHERE id = 1'), maxRows: 1 });
    expect(run).toMatchObject({ open: false, rollbackIncomplete: true, error: { code: 'non_transactional_write' } });
    expect(run.results).toHaveLength(1);
    const s = h.opened[0]!.session;
    expect(s.executed).toEqual(['UPDATE legacy SET a = 1 WHERE id = 1']);
    expect(s.rollbacks).toBe(1);
    expect(s.closed).toBe(true);
  });

  it('with no transaction flag at all it also fails; with no rows changed the rollback is not reported incomplete', async () => {
    const h = ctlHarness((s) => (s.result = () => ({ affectedRows: 0 })));
    const run = await h.sessions.runWrite(agentEnv, { statements: updates('DELETE FROM t WHERE id = 1'), maxRows: 1 });
    expect(run.error?.code).toBe('non_transactional_write');
    expect(run.rollbackIncomplete).toBeUndefined();
  });

  it('a statement still running after 35 s is cut: agent_timeout, rolled back and closed', async () => {
    const h = ctlHarness();
    const p = h.sessions.runWrite(agentEnv, { statements: updates('UPDATE t SET a = 1 WHERE id = 1 -- HANG'), maxRows: 1 });
    await flush();
    await h.clock.advance(34_999);
    let settled = false;
    void p.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    await h.clock.advance(1);
    const run = await p;
    expect(run).toMatchObject({ open: false, error: { code: 'agent_timeout' } });
    const s = h.opened[0]!.session;
    expect(s.cancels).toBe(1);
    expect(s.rollbacks).toBe(1);
    expect(s.closed).toBe(true);
  });

  it('the per-statement cut shrinks to what is left of the 60 s budget', async () => {
    const h = ctlHarness();
    const p = h.sessions.runWrite(agentEnv, { statements: updates('UPDATE a SET x = 1 WHERE id = 1 -- HANG', 'UPDATE b SET x = 1 WHERE id = 1 -- HANG'), maxRows: 1 });
    await flush();
    await h.clock.advance(30_000);
    h.opened[0]!.session.release({ inTransaction: true, affectedRows: 1 });
    await flush();
    expect(h.opened[0]!.session.executed).toHaveLength(2);
    let settled = false;
    void p.then(() => (settled = true));
    await h.clock.advance(29_999);
    expect(settled).toBe(false);
    await h.clock.advance(1);
    const run = await p;
    expect(run.error?.code).toBe('agent_timeout');
    expect(run.results).toHaveLength(2);
  });

  it('past the 60 s total the next statement never starts', async () => {
    const h = ctlHarness((s) => (s.onExecute = () => void (h.clock.now += 40_000)));
    const run = await h.sessions.runWrite(agentEnv, {
      statements: updates('UPDATE a SET x = 1 WHERE id = 1', 'UPDATE b SET x = 1 WHERE id = 1', 'UPDATE c SET x = 1 WHERE id = 1'),
      maxRows: 1,
    });
    expect(run).toMatchObject({ open: false, error: { code: 'agent_timeout' } });
    expect(h.opened[0]!.session.executed).toHaveLength(2);
    expect(h.opened[0]!.session.rollbacks).toBe(1);
    expect(h.opened[0]!.session.closed).toBe(true);
  });

  it('closeAll aborts a running write and an open one (KILL, then the socket is dropped)', async () => {
    const h = ctlHarness();
    const open = await h.sessions.runWrite(agentEnv, { statements: updates('UPDATE t SET a = 1 WHERE id = 1'), maxRows: 1 });
    expect(open.open).toBe(true);
    const running = h.sessions.runWrite(agentEnv, { statements: updates('UPDATE t SET a = 2 WHERE id = 1 -- HANG'), maxRows: 1 });
    await flush();
    await h.sessions.closeAll();
    const out = await running;
    expect(out.open).toBe(false);
    expect(out.error).toBeDefined();
    for (const { session } of h.opened) {
      expect(session.cancels).toBeGreaterThanOrEqual(1);
      expect(session.destroyed).toBe(true);
    }
  });

  it('connection params carry refresh(), which asks for fresh credentials (KILL QUERY gets a fresh token)', async () => {
    const h = ctlHarness();
    await h.sessions.runRead(agentEnv, { statements: reads('SELECT 1'), maxRows: 1 });
    await h.sessions.runWrite(agentEnv, { database: 'other', statements: updates('UPDATE t SET a = 1 WHERE id = 1'), maxRows: 1 });
    expect(h.opened).toHaveLength(2);
    for (const { params } of h.opened) expect(typeof params.refresh).toBe('function');
    expect(h.opened[1]!.params.database).toBe('other');
    const before = h.resolveCalls();
    const fresh = await h.opened[1]!.params.refresh!();
    expect(h.resolveCalls()).toBe(before + 1);
    expect(fresh.password).toBe(`token-${before + 1}`);
  });
});

// --- the person's tabs -------------------------------------------------------------------------

class TabSession implements DbSession {
  serverVersion = '8.4.0-fake';
  executed: string[] = [];
  opts: { maxRows: number; stopAtCap?: boolean }[] = [];
  modes: string[] = [];
  closed = false;
  cancels = 0;
  txFlag: boolean | undefined;
  probeFlag: boolean | undefined;
  hold?: RegExp;
  private held?: () => void;
  async applyMode(mode: string) {
    this.modes.push(mode);
  }
  useDatabase(name: string): Promise<StatementResult> {
    return this.execute(`USE ${'`' + name.replace(/`/g, '``') + '`'}`, { maxRows: 1 });
  }

  async transactionProbe(): Promise<boolean | undefined> {
    return (await this.execute('DO 0', { maxRows: 1 }).catch(() => undefined))?.inTransaction;
  }

  async execute(sql: string, opts: { maxRows: number; stopAtCap?: boolean }): Promise<StatementResult> {
    this.executed.push(sql);
    this.opts.push(opts);
    if (this.hold?.test(sql)) await new Promise<void>((r) => (this.held = r));
    const inTransaction = sql === 'DO 0' ? this.probeFlag : this.txFlag;
    return { index: 0, sql, kind: 'other', verb: '', durationMs: 1, columns: [], rows: [], inTransaction };
  }
  release() {
    this.held?.();
  }
  async cancel() {
    this.cancels++;
  }
  async commit() {}
  async rollback() {}
  async currentDatabase() {
    return 'app';
  }
  onFatalError(_cb: (e: DbSessionError) => void) {}
  async close() {
    this.closed = true;
  }
}

const tabDev: Environment = { id: 'dev', projectId: 'p', name: 'dev', engine: 'mysql', host: 'h', port: 3306, credentialId: 'c', production: false };

function makeManager() {
  const envs: Record<string, Environment> = { dev: { ...tabDev } };
  const opened: TabSession[] = [];
  const driver: Driver = {
    engine: 'mysql',
    open: async () => {
      const s = new TabSession();
      opened.push(s);
      return s;
    },
    introspect: async () => ({ databases: [] }),
    test: async () => ({ serverVersion: 'x' }),
  };
  const manager = new SessionManager({
    getEnvironment: (id) => envs[id],
    resolveConnectParams: async () => ({ host: 'h', port: 3306, user: 'u', tls: 'off' }),
    getDriver: () => driver,
    getDialect,
    emit: () => undefined,
    now: () => 1000,
  });
  const run = (sql: string, extra: Record<string, unknown> = {}) => manager.run('t', { sql, scope: 'all', cursor: 0, maxRows: 1000, ...extra });
  return { manager, envs, opened, run };
}

describe('SessionManager: Cancelar stops the rest of the run', () => {
  it('in autocommit, the statements after the cancelled one never start', async () => {
    const { manager, opened, run } = makeManager();
    await manager.open('t', 'dev');
    const s = opened[0]!;
    s.hold = /^SELECT 1$/;
    const p = run('SELECT 1; SELECT 2; SELECT 3');
    await flush();
    await manager.cancel('t');
    expect(s.cancels).toBe(1);
    s.release();
    const res = await p;
    expect(s.executed).toEqual(['SELECT 1']);
    expect(res.results).toHaveLength(2);
    expect(res.results[1]).toMatchObject({ index: 1, sql: 'SELECT 2', error: { code: 'CANCELLED' } });
    expect(res.session.status).toBe('idle');
  });

  it('in Transação, the state after a cancel comes from the server (probe)', async () => {
    const { manager, opened, run } = makeManager();
    await manager.open('t', 'dev');
    await manager.setMode('t', 'transaction');
    const s = opened[0]!;
    s.txFlag = true;
    s.probeFlag = false;
    s.hold = /SET b = 1/;
    const p = run('UPDATE a SET b = 1; UPDATE a SET b = 2');
    await flush();
    await manager.cancel('t');
    s.release();
    const res = await p;
    expect(s.executed).toEqual(['UPDATE a SET b = 1', 'DO 0']);
    expect(res.results.at(-1)!.error?.code).toBe('CANCELLED');
    expect(res.session.transaction.open).toBe(false);
  });

  it('a cancel from an earlier run does not leak into the next one', async () => {
    const { manager, opened, run } = makeManager();
    await manager.open('t', 'dev');
    const s = opened[0]!;
    s.hold = /^SELECT 1$/;
    const p = run('SELECT 1; SELECT 2');
    await flush();
    await manager.cancel('t');
    s.release();
    await p;
    s.hold = undefined;
    const next = await run('SELECT 3; SELECT 4');
    expect(next.results.map((r) => r.error)).toEqual([undefined, undefined]);
  });
});

describe('SessionManager: an environment newly marked production', () => {
  it('a tab that was in Auto-commit reopens in Somente leitura with a notice', async () => {
    const { manager, envs, opened } = makeManager();
    expect((await manager.open('t', 'dev')).mode).toBe('autocommit');
    envs.dev = { ...envs.dev!, production: true };
    await manager.environmentChanged('dev');
    const again = await manager.open('t', 'dev');
    expect(again.mode).toBe('read-only');
    expect(again.notice).toBe('O ambiente agora é produção: a aba voltou para Somente leitura.');
    expect(opened[1]!.modes).toEqual(['read-only']);
    // going back to Auto-commit needs the production confirmation
    expect((await manager.setMode('t', 'autocommit')).needsConfirmation).toEqual({ reason: 'production-autocommit' });
  });

  it('a requested Auto-commit on the newly production environment needs confirmation', async () => {
    const { manager, envs } = makeManager();
    await manager.open('t', 'dev');
    envs.dev = { ...envs.dev!, production: true };
    await manager.environmentChanged('dev');
    await expect(manager.open('t', 'dev', { mode: 'autocommit' })).rejects.toMatchObject({ code: 'confirmation-required' });
  });
});

describe('SessionManager: "Buscar até 50.000" (refetch) only for a single plain read', () => {
  it.each(['UPDATE a SET b = 1', 'SELECT 1; SELECT 2', 'SELECT * FROM t FOR UPDATE', 'CALL p()', "SELECT 1 INTO OUTFILE '/tmp/x'", 'SET @a = 1'])(
    'refuses %s before anything runs',
    async (sql) => {
      const { manager, opened, run } = makeManager();
      await manager.open('t', 'dev');
      await expect(run(sql, { refetch: true })).rejects.toMatchObject({ code: 'refetch-not-read' });
      expect(opened[0]!.executed).toEqual([]);
    },
  );

  it('runs a single SELECT', async () => {
    const { manager, opened, run } = makeManager();
    await manager.open('t', 'dev');
    const res = await run('SELECT * FROM t', { refetch: true, maxRows: 50_000 });
    expect(res.results[0]!.error).toBeUndefined();
    expect(opened[0]!.executed).toEqual(['SELECT * FROM t']);
  });

  it('the row cap stops the query only for reads (a CALL is never cut between its SELECT and its writes)', async () => {
    const { manager, opened, run } = makeManager();
    await manager.open('t', 'dev');
    await run('SELECT 1; CALL p()');
    expect(opened[0]!.opts.map((o) => o.stopAtCap)).toEqual([true, false]);
  });
});

// --- scripts -----------------------------------------------------------------------------------

describe('ScriptStore.duplicate keeps who wrote the SQL', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cais-scripts-dup-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a copy of an agent script is still the agent\'s; a copy of a person\'s is the person\'s', async () => {
    const catalog = new CatalogStore(dir, new FakeVault());
    const api = await catalog.saveProject({ name: 'api' });
    let clock = 1000;
    const scripts = new ScriptStore(dir, { getProject: (id) => catalog.getProject(id), getEnvironment: (id) => catalog.getEnvironment(id), now: () => ++clock });
    await scripts.load();
    const byAgent = await scripts.save({ projectId: api.id, name: 'Do agente', sql: 'SELECT 1' }, 'agent');
    const byUser = await scripts.save({ projectId: api.id, name: 'Meu', sql: 'SELECT 2' });
    const copyA = await scripts.duplicate(byAgent.id);
    const copyU = await scripts.duplicate(byUser.id);
    expect(copyA).toMatchObject({ createdBy: 'agent', sql: 'SELECT 1' });
    expect(copyA.name).not.toBe(byAgent.name);
    expect(copyU.createdBy).toBe('user');
    // the person saving the copy is what clears the mark
    const saved = await scripts.save({ id: copyA.id, projectId: api.id, name: copyA.name, sql: copyA.sql });
    expect(saved.createdBy).toBe('user');
  });
});

// --- text helpers ------------------------------------------------------------------------------

describe('text: markInvisible and hiddenTextProblem cover every class', () => {
  const cases: [string, string, string][] = [
    ['zero-width space', '​', '⟨U+200B⟩'],
    ['Arabic letter mark', '؜', '⟨U+061C⟩'],
    ['tag character', '\u{E0041}', '⟨U+E0041⟩'],
    ['lone CR', '\r', '⟨U+000D⟩'],
    ['line separator', ' ', '⟨U+2028⟩'],
    ['paragraph separator', ' ', '⟨U+2029⟩'],
    ['vertical tab', '\u000b', '⟨U+000B⟩'],
    ['form feed', '\u000c', '⟨U+000C⟩'],
    ['next line (C1)', '\u0085', '⟨U+0085⟩'],
    ['Hangul filler', 'ㅤ', '⟨U+3164⟩'],
    ['braille blank', '⠀', '⟨U+2800⟩'],
  ];

  it.each(cases)('marks a %s visibly and refuses it', (_name, ch, mark) => {
    const sql = `SELECT 1 -- a${ch}b`;
    expect(markInvisible(sql)).toBe(`SELECT 1 -- a${mark}b`);
    const problem = hiddenTextProblem(sql);
    expect(problem).not.toBeNull();
    expect(problem).toContain(mark);
  });

  it('refuses other C0 and C1 controls', () => {
    for (const ch of ['\u0001', '\u001b', '\u007f', '\u0090', '\u009b']) {
      expect(hiddenTextProblem(`SELECT 1${ch}`), JSON.stringify(ch)).toMatch(/caractere de controle/);
    }
  });
  it('leaves ordinary SQL alone: \\n, \\r\\n, tabs and accents', () => {
    for (const sql of ['SELECT 1;\nSELECT 2;', 'SELECT 1;\r\nSELECT 2;', "SELECT\t'ação'", 'SELECT 日本']) {
      expect(hiddenTextProblem(sql), JSON.stringify(sql)).toBeNull();
      expect(markInvisible(sql)).toBe(sql);
    }
  });
});

// --- agent SQL: non-ASCII, comments and routines ----------------------------------------------

describe('non-ASCII and comment tricks in agent SQL', () => {
  const mysql = getDialect('mysql');
  const problem = (sql: string) => mysql.agentCodeProblem!(sql);

  it.each([
    'SELECT id, email FROM users WHERE id ＝ 3',
    'DELETE FROM orders WHERE archived',
    "SET @id = 42; UPDATE users SET role = 'admin' WHERE id = COALESCE(@іd, id)",
    'WITH ſelect AS (SELECT 1) DELETE FROM t',
    "SELECT ÀSYNCHRONOUS_CONNECTION_FAILOVER_ADD_SOURCE('c','h',1,'',1)",
    'SELECT `ÍNNODB_SET_OPEN_FILES_LIMIT`(4321)',
    'SELECT @`іd`',
    'SELECT email FROM users WHERE id = 5 /* ver /* */ OR id > 0 /* fim */',
  ])('refuses %s', (sql) => {
    expect(problem(sql)).not.toBeNull();
  });

  it.each([
    "SELECT id FROM users WHERE nome = 'João da Conceição'",
    'SELECT `preço` FROM produtos -- comentário em português',
    "UPDATE t SET v = 'ação' WHERE id = 1 /* ajuste */",
    "SELECT 'a\\'b' AS x",
  ])('allows %s', (sql) => {
    expect(problem(sql)).toBeNull();
  });

  it('the broker refuses them before classification, for queries and scripts', async () => {
    const h = makeBroker();
    await expect(h.broker.query({ env: 'api/dev', sql: 'DELETE FROM orders WHERE archived', write: true, reason: 'r' })).rejects.toMatchObject({
      code: 'hidden_text',
    });
    await expect(h.broker.query({ env: 'api/dev', sql: 'WITH ſelect AS (SELECT 1) DELETE FROM t', write: true, reason: 'r' })).rejects.toMatchObject({
      code: 'ambiguous_text',
    });
    await expect(h.broker.scriptSave({ project: 'api', name: 'x', sql: 'SELECT 1 /* a /* b */ OR 1' })).rejects.toMatchObject({ code: 'invalid_script' });
    expect(h.audit.at(-1)).toMatchObject({ mode: 'script', state: 'refused', errorCode: 'ambiguous_text' });
  });

  it('script-save validates --database like a query (no system schema, no hidden text)', async () => {
    const h = makeBroker();
    await expect(h.broker.scriptSave({ project: 'api', name: 'x', sql: 'SELECT 1', database: 'mysql' })).rejects.toMatchObject({ code: 'invalid_script' });
    await expect(h.broker.scriptSave({ project: 'api', name: 'y', sql: 'SELECT 1', database: 'app‮' })).rejects.toMatchObject({ code: 'invalid_script' });
  });
});

describe('classifier follows the server', () => {
  const mysql = getDialect('mysql');
  it('keywords are ASCII only: ſelect is a name, so the DELETE is seen', () => {
    expect(mysql.classify('WITH ſelect AS (SELECT 1) DELETE FROM t')).toMatchObject({ verb: 'DELETE', kind: 'write' });
    expect(mysql.warnings('WITH ſelect AS (SELECT 1) DELETE FROM t')).toContain('DELETE sem WHERE');
  });

  it('a function name with a non-ASCII letter is refused in read-only (the server ignores accents)', () => {
    const c = mysql.classify("SELECT ÀSYNCHRONOUS_CONNECTION_FAILOVER_ADD_SOURCE('c','h',1,'',1)");
    expect(c.allowedInReadOnly).toBe(false);
    expect(c.serverStateFunction).toMatch(/^#NON_ASCII:/);
  });

  it.each(['SELECT innodb_set_open_files_limit(10)', 'SELECT innodb_redo_log_archive_start(1)', "SELECT mysqlx_error(1)"])(
    'more loadable functions are server-state: %s',
    (sql) => expect(mysql.classify(sql).allowedInReadOnly).toBe(false),
  );

  it.each(['SET @@autocommìt = 0', 'SET `autocommìt` = 1', 'SET complétion_type = 1', "SET tranßaction_isolation = 'SERIALIZABLE'"])(
    'accented transaction variables are refused in every mode: %s',
    (sql) => expect(mysql.classify(sql).alwaysRefuse).toBeDefined(),
  );

  it('user variables with accents stay allowed', () => {
    expect(mysql.classify('SET @açúcar = 1')).toMatchObject({ allowedInReadOnly: true });
    expect(mysql.classify('SET @açúcar = 1').alwaysRefuse).toBeUndefined();
  });

  it('SHOW CREATE USER is flagged and refused for agents', () => {
    const c = mysql.classify("SHOW /**/ CREATE USER 'root'@'localhost'");
    expect(c.accountSecrets).toBe(true);
    const d = decide({ mode: 'read', production: false, statements: [{ text: 'x', c }], rules: dialect.agentRules, pendingCount: 0, grantActive: false });
    expect(d).toMatchObject({ action: 'refuse', code: 'system_schema' });
    expect(mysql.classify('SHOW GRANTS').accountSecrets).toBeUndefined();
  });

  it.each(['INSERT INTO audit_logs (a, b) VALUES (1, 2)', 'REPLACE INTO keyring_keys (id) VALUES (1)', 'WITH audit_totais (n) AS (SELECT 1) SELECT n FROM audit_totais', 'WITH a AS (SELECT 1), audit_x (n) AS (SELECT 2) SELECT * FROM a'])(
    'a table or CTE named like a server function is not a call: %s',
    (sql) => expect(mysql.classify(sql).serverStateFunction).toBeUndefined(),
  );

  it('markInvisible marks non-ASCII spaces and other controls', () => {
    expect(markInvisible('a b　c\u0001d')).toBe('a⟨U+00A0⟩b⟨U+3000⟩c⟨U+0001⟩d');
    expect(hiddenTextProblem('WHERE id')).not.toBeNull();
  });
});

describe('non-transactional warnings follow routines', () => {
  it('warns when a called function writes to a MyISAM table, and when a routine cannot be read', async () => {
    const executor = new FakeExecutor();
    executor.tree = {
      databases: [
        {
          name: 'app',
          tables: [
            { name: 'cards', type: 'table', engine: 'InnoDB', columns: [] },
            { name: 'logm', type: 'table', engine: 'MyISAM', columns: [] },
          ],
          routines: [
            { name: 'f_log', body: "BEGIN INSERT INTO logm VALUES (1); RETURN 1; END" },
            { name: 'p_hidden', body: null },
          ],
        },
      ],
    };
    const h = makeBroker({ executor });
    await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET v = f_log() WHERE id = 1', write: true, reason: 'r' });
    expect(h.broker.snapshot().pending[0]!.warnings.join('\n')).toMatch(/rotina f_log grava em logm/);
    await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET v = p_hidden() WHERE id = 1', write: true, reason: 'r' });
    expect(h.broker.snapshot().pending[1]!.warnings.join('\n')).toMatch(/Não foi possível ler a rotina p_hidden/);
  });
});

// --- lexer edge cases and nested routines -----------------------------------------------------

describe('"*/" outside an executable comment is a multiplication', () => {
  const mysql = getDialect('mysql');
  it.each([
    "SET @a = 2 */* ' */ 1, PERSIST max_connections = 7 /* ' */",
    "SET @a = 2 */* ' */ 1, GLOBAL offline_mode = ON /* ' */",
    "SELECT 2 */* ' */ 1 FROM orders FOR UPDATE /* ' */",
    "SELECT 2 */* ' */ 1 INTO OUTFILE '/tmp/x' /* ' */",
    "SELECT 2 */* ' */ 1, asynchronous_connection_failover_add_source('c','h',1,'',1) /* ' */",
  ])('refused in read-only: %s', (sql) => {
    expect(mysql.classify(sql).allowedInReadOnly).toBe(false);
  });
  it('the hidden names are seen', () => {
    expect(mysql.identifiers("SELECT 2 */* ' */ 1, authentication_string FROM mysql.user /* ' */")).toContain('mysql');
    expect(mysql.classify("SELECT 2 */* ' */ GET_LOCK('k', 0) /* ' */").functions).toContain('GET_LOCK');
  });
  it('an executable comment still closes with */', () => {
    expect(mysql.classify('SELECT /*! 1 */ + 1').verb).toBe('SELECT');
  });
});

describe('functions after FROM inside TRIM/SUBSTRING/EXTRACT are calls', () => {
  const mysql = getDialect('mysql');
  it.each([
    ["SELECT TRIM(LEADING 'x' FROM GET_LOCK('k', 0))", 'GET_LOCK'],
    ["SELECT TRIM(BOTH 'x' FROM LOAD_FILE('/tmp/s'))", 'LOAD_FILE'],
    ["SELECT SUBSTRING('a' FROM SLEEP(1))", 'SLEEP'],
    ['SELECT EXTRACT(YEAR FROM BENCHMARK(1, 1))', 'BENCHMARK'],
    ["SELECT STRAIGHT_JOIN GET_LOCK('k', 0)", 'GET_LOCK'],
  ])('%s calls %s', (sql, fn) => {
    expect(mysql.classify(sql).functions).toContain(fn);
    const d = decide({ mode: 'read', production: false, statements: [{ text: sql, c: mysql.classify(sql) }], rules: mysql.agentRules, pendingCount: 0, grantActive: false });
    expect(d).toMatchObject({ action: 'refuse', code: 'function_not_allowed' });
  });
  it('server-state functions there are refused in read-only', () => {
    expect(mysql.classify("SELECT TRIM('z' FROM asynchronous_connection_failover_add_source('c','h',1,'',1))").allowedInReadOnly).toBe(false);
  });
});

describe('what the approval highlighter would read differently is refused for agents', () => {
  const mysql = getDialect('mysql');
  it.each([
    "UPDATE orders SET status = 'x' WHERE @'lote\\' OR'IS NULL -- ' AND id = 42",
    'SELECT @"x"',
    'SELECT @`x`',
    "SELECT @@'autocommit'",
    'DELETE FROM orders WHERE tenant_id = 3 --\tAND id = 42',
    'SELECT 1 --',
  ])('%s', (sql) => {
    expect(mysql.agentCodeProblem!(sql)).not.toBeNull();
  });
  it.each(['SELECT 1 -- comentário', "INSERT INTO `histórico` (`id`, `ação`) VALUES (1, 'criação')", 'SELECT 5--3'])('allows %s', (sql) => {
    expect(mysql.agentCodeProblem!(sql)).toBeNull();
  });
});

describe('routines and views in the non-transactional warning', () => {
  it('a same-named routine in another schema does not hide the one that writes to MyISAM; unreadable nested routines warn', async () => {
    const executor = new FakeExecutor();
    executor.tree = {
      databases: [
        {
          name: 'app',
          triggersVisible: true,
          tables: [
            { name: 'plain', type: 'table', engine: 'InnoDB', columns: [] },
            { name: 'log_m', type: 'table', engine: 'MyISAM', columns: [] },
            { name: 'base', type: 'table', engine: 'InnoDB', columns: [], triggers: ['CALL p_audit(NEW.id)'] },
            { name: 'v1', type: 'view', columns: [], uses: ['app.log_m'] },
            { name: 'v2', type: 'view', columns: [], uses: ['app.v1'] },
          ],
          routines: [{ name: 'f_log', body: 'BEGIN INSERT INTO log_m VALUES (1); RETURN 1; END' }, { name: 'p_audit', body: null }],
        },
        { name: 'other', triggersVisible: true, tables: [], routines: [{ name: 'f_log', body: 'BEGIN RETURN 1; END' }] },
      ],
    };
    const h = makeBroker({ executor });
    const warn = async (sql: string) => {
      await h.broker.query({ env: 'api/dev', sql, write: true, reason: 'r' });
      return h.broker.snapshot().pending.at(-1)!.warnings.join('\n');
    };
    expect(await warn('UPDATE plain SET n = app.f_log() WHERE id = 1')).toMatch(/rotina f_log grava em log_m/);
    expect(await warn('UPDATE base SET n = 1 WHERE id = 1')).toMatch(/Não foi possível ler a rotina p_audit/);
    expect(await warn('UPDATE v2 SET n = 5 WHERE id = 1')).toMatch(/view v2 usa a tabela não transacional app.log_m/);
  });

  it('a database whose triggers this account cannot see is reported when non-transactional tables exist', async () => {
    const executor = new FakeExecutor();
    executor.tree = {
      databases: [
        {
          name: 'app',
          triggersVisible: false,
          tables: [
            { name: 'cards', type: 'table', engine: 'InnoDB', columns: [] },
            { name: 'log_m', type: 'table', engine: 'MyISAM', columns: [] },
          ],
        },
      ],
    };
    const h = makeBroker({ executor });
    await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET n = 1 WHERE id = 1', write: true, reason: 'r' });
    expect(h.broker.snapshot().pending[0]!.warnings.join('\n')).toMatch(/falta o privilégio TRIGGER/);
  });
});
