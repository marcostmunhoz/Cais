import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MysqlEnvironment as Environment } from '@shared/model';
import type { StatementResult } from '@shared/results';
import { AgentAccess } from '@main/agents/access';
import { AgentError, agentText } from '@main/agents/errors';
import { redactForAgent } from '@main/agents/redact';
import { AgentServer } from '@main/agents/server';
import { AgentSessions } from '@main/agents/sessions';
import { installCli } from '@main/cli-install';
import type { ConnectParams, DbSession, DbSessionError, Driver } from '@main/drivers/types';
import { DriverError } from '@main/drivers/types';
import { SettingsStore } from '@main/store/settings';
import { TabsStore } from '@main/store/tabs';
import { FakeClock, flush, makeBroker } from '../support/agent-fakes';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync('/tmp/cais-misc-');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('broker trail end to end', () => {
  it('records who decided and when, never the rows', async () => {
    const { broker, audit, clock } = makeBroker();
    const r = (await broker.query({ env: 'api/pro', sql: 'SELECT email FROM people', reason: 'incidente', client: 'Claude Code' })) as any;
    await clock.advance(5000);
    broker.approve(r.request_id, { shareResult: false });
    await flush();
    const row = audit.at(-1)!;
    expect(row).toMatchObject({ state: 'succeeded', decidedBy: 'user', shareResult: false, reason: 'incidente', client: 'Claude Code', production: true });
    expect(row.decidedAt).toBe(clock.now);
    // counts only: no column names, no values
    expect(JSON.stringify(audit)).not.toMatch(/ana@x\.com|columns/);
  });
});

describe('redactForAgent', () => {
  it('removes the host, host:port, logins and IPs from error text', () => {
    const t = { host: 'db.internal.example', port: 3306 };
    expect(redactForAgent('No response from db.internal.example:3306. Is the VPN on?', t)).toBe('No response from <server>. Is the VPN on?');
    expect(redactForAgent("Access denied for user 'app'@'10.1.2.3' (using password: YES)", t)).toBe("Access denied for user '<user>'@'<server>' (using password: YES)");
    expect(redactForAgent('connect ECONNREFUSED 10.1.2.3:3306', t)).toBe('connect ECONNREFUSED <server>');
    expect(redactForAgent('Table x does not exist', t)).toBe('Table x does not exist');
  });
});

describe('installCli', () => {
  const target = () => {
    const cli = join(dir, 'res', 'cli');
    mkdirSync(cli, { recursive: true });
    writeFileSync(join(cli, 'cais.mjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
    return join(cli, 'cais.mjs');
  };

  it('links cais in the first folder that accepts it and says when it is not in the PATH', () => {
    const bin1 = join(dir, 'usr-local-bin');
    const bin2 = join(dir, 'home-local-bin');
    const out = installCli({ target: target(), candidates: [bin1, bin2], pathEnv: '/usr/bin' });
    expect(out.ok).toBe(true);
    expect(readlinkSync(join(bin1, 'cais'))).toBe(target());
    expect(out.message).toContain('não está no PATH');
    expect(existsSync(bin2)).toBe(false);
    expect(installCli({ target: target(), candidates: [bin1], pathEnv: `/x:${bin1}` })).toMatchObject({ ok: true, message: expect.stringContaining('já estava instalado') });
  });

  it('falls back to the next folder when the first cannot be written', () => {
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'a file, so mkdir fails');
    const bin2 = join(dir, 'bin2');
    const out = installCli({ target: target(), candidates: [join(blocked, 'bin'), bin2], pathEnv: bin2 });
    expect(out).toMatchObject({ ok: true, linkPath: join(bin2, 'cais') });
    expect(out.message).not.toContain('PATH');
  });

  it('never overwrites a file or a link that is not ours, and reports it', () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'cais'), 'mine');
    expect(installCli({ target: target(), candidates: [bin], pathEnv: '' })).toMatchObject({ ok: false });
    expect(readFileSync(join(bin, 'cais'), 'utf8')).toBe('mine');
    rmSync(join(bin, 'cais'));
    symlinkSync('/usr/bin/true', join(bin, 'cais'));
    expect(installCli({ target: target(), candidates: [bin], pathEnv: '' }).ok).toBe(false);
    expect(readlinkSync(join(bin, 'cais'))).toBe('/usr/bin/true');
  });

  it('replaces an older link of ours (another path of the same app)', () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    symlinkSync('/Applications/Cais.app/Contents/Resources/cli/cais.mjs', join(bin, 'cais'));
    expect(installCli({ target: target(), candidates: [bin], pathEnv: bin }).ok).toBe(true);
    expect(lstatSync(join(bin, 'cais')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(bin, 'cais'))).toBe(target());
  });

  it('refuses when the bundled file is missing', () => {
    expect(installCli({ target: join(dir, 'nope.mjs'), candidates: [join(dir, 'b')], pathEnv: '' }).ok).toBe(false);
  });
});

describe('settings and the on/off switch', () => {
  it('starts off, persists the switch, and sets a corrupt file aside', async () => {
    const s = new SettingsStore(dir);
    await s.load();
    expect(s.agentAccess).toBe(false);
    await s.setAgentAccess(true);
    const again = new SettingsStore(dir);
    await again.load();
    expect(again.agentAccess).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ version: 1, agentAccess: true });
    writeFileSync(join(dir, 'settings.json'), '{"version":1,"agentAccess":"yes"}');
    const bad = new SettingsStore(dir);
    await bad.load();
    expect(bad.agentAccess).toBe(false);
    expect(bad.notice).toContain('settings.json');
  });

  async function access(start: boolean) {
    const h = makeBroker();
    h.broker.setEnabled(false);
    const settings = new SettingsStore(dir);
    await settings.load();
    if (start) await settings.setAgentAccess(true);
    const socketPath = join(dir, 'agent.sock');
    const server = new AgentServer({ broker: h.broker, socketPath, endpointPath: join(dir, 'agent-endpoint.json'), platform: process.platform, pid: 1, appVersion: 'x' });
    const changes: number[] = [];
    const a = new AgentAccess({ settings, broker: h.broker, server, onChange: () => void changes.push(1) });
    return { ...h, settings, server, socketPath, a, changes };
  }

  it('nothing listens until the person turns it on; turning it off closes the socket and cleans up', async () => {
    const { a, server, socketPath, broker, settings } = await access(false);
    await a.init();
    expect(server.isListening()).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
    expect(a.snapshot().enabled).toBe(false);
    await a.set(true);
    expect(existsSync(socketPath)).toBe(true);
    expect(broker.isEnabled()).toBe(true);
    expect(settings.agentAccess).toBe(true);
    await a.set(false);
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(join(dir, 'agent-endpoint.json'))).toBe(false);
    expect(broker.isEnabled()).toBe(false);
    expect(settings.agentAccess).toBe(false);
  });

  it('honors a saved "on" at launch; a socket that cannot open leaves it off and says why', async () => {
    const good = await access(true);
    await good.a.init();
    expect(good.server.isListening()).toBe(true);
    await good.a.shutdown();
    expect(existsSync(good.socketPath)).toBe(false);

    writeFileSync(join(dir, 'agent.sock'), 'a regular file in the way');
    const bad = await access(true);
    await bad.a.init();
    expect(bad.a.snapshot()).toMatchObject({ enabled: false, startError: expect.stringContaining('arquivo') });
    await expect(bad.a.set(true)).rejects.toThrow('arquivo');
    expect(bad.settings.agentAccess).toBe(true); // the saved switch is untouched by a failed start
  });
});

// --- AgentSessions against a fake driver -------------------------------------------------------

class FakeDbSession implements DbSession {
  serverVersion = 'fake';
  executed: string[] = [];
  modes: string[] = [];
  commits = 0;
  rollbacks = 0;
  closed = false;
  script: ((sql: string, n: number) => Partial<StatementResult>)[] = [];
  private fatal: ((e: DbSessionError) => void)[] = [];
  limits: { maxExecutionMs?: number; lockWaitSeconds?: number }[] = [];
  lastRollbackIncomplete = false;
  async applyLimits(l: { maxExecutionMs?: number; lockWaitSeconds?: number }) {
    this.limits.push(l);
  }
  async applyMode(mode: string) {
    this.modes.push(mode);
  }
  useDatabase(name: string): Promise<StatementResult> {
    return this.execute(`USE ${'`' + name.replace(/`/g, '``') + '`'}`);
  }

  async transactionProbe(): Promise<boolean | undefined> {
    return (await this.execute('DO 0').catch(() => undefined))?.inTransaction;
  }

  async execute(sql: string): Promise<StatementResult> {
    this.executed.push(sql);
    const use = /^USE `(.+)`$/.exec(sql);
    if (use) this.db = use[1]!;
    const extra = this.script.shift()?.(sql, this.executed.length) ?? {};
    return { index: 0, sql, kind: 'other', verb: '', durationMs: 1, ...extra };
  }
  async cancel() {}
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
}

const env: Environment = { id: 'e1', projectId: 'p', name: 'dev', engine: 'mysql', host: 'db.internal.example', port: 3306, defaultDatabase: 'app', credentialId: 'c', production: false };

function sessionsHarness() {
  const opened: { session: FakeDbSession; params: ConnectParams }[] = [];
  let openError: Error | undefined;
  const clock = new FakeClock();
  const driver: Driver = {
    engine: 'mysql',
    open: async (params) => {
      if (openError) throw openError;
      const session = new FakeDbSession();
      session.db = (params.engine === 'bigquery' ? params.defaultDataset : params.database) ?? null;
      opened.push({ session, params });
      return session;
    },
    introspect: async () => ({ databases: [] }),
    test: async () => ({ serverVersion: 'x' }),
  };
  const sessions = new AgentSessions({ getDriver: () => driver, resolveConnectParams: async (e) => ({ host: env.host, port: env.port, ...(e.defaultDatabase ? { database: e.defaultDatabase } : {}), user: 'u', password: 'secret-pw', tls: 'off' }), scheduler: clock });
  return { sessions, opened, clock, failOpen: (e: Error) => (openError = e) };
}
const plan = (...texts: string[]) => texts.map((text) => ({ text }));

describe('AgentSessions', () => {
  it('reads share one read-only connection per environment and close after 5 idle minutes', async () => {
    const { sessions, opened, clock } = sessionsHarness();
    await sessions.runRead(env, { statements: plan('SELECT 1'), maxRows: 10 });
    await sessions.runRead(env, { statements: plan('SELECT 2'), maxRows: 10 });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.session.modes).toEqual(['read-only']);
    await clock.advance(5 * 60_000 - 1);
    expect(opened[0]!.session.closed).toBe(false);
    await clock.advance(1);
    expect(opened[0]!.session.closed).toBe(true);
    await sessions.runRead(env, { statements: plan('SELECT 3'), maxRows: 10 });
    expect(opened).toHaveLength(2);
  });

  it('concurrent reads use up to 3 connections per environment; the 4th waits for a free one', async () => {
    const { sessions, opened } = sessionsHarness();
    await Promise.all([1, 2, 3, 4, 5].map((n) => sessions.runRead(env, { statements: plan(`SELECT ${n}`), maxRows: 10 })));
    expect(opened.length).toBeLessThanOrEqual(3);
    expect(opened.flatMap((o) => o.session.executed).sort()).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3', 'SELECT 4', 'SELECT 5']);
  });

  it('--database switches with USE, and a USE inside the SQL recycles the connection', async () => {
    const { sessions, opened } = sessionsHarness();
    await sessions.runRead(env, { database: 'other', statements: plan('SELECT 1'), maxRows: 10 });
    expect(opened[0]!.session.executed).toEqual(['USE `other`', 'SELECT 1']);
    await sessions.runRead(env, { statements: plan('SELECT 2'), maxRows: 10 });
    expect(opened[0]!.session.executed.slice(2)).toEqual(['USE `app`', 'SELECT 2']); // back to the default
    await sessions.runRead(env, { statements: [{ text: 'USE `x`', changesDatabase: true }], maxRows: 10 });
    expect(opened[0]!.session.closed).toBe(true);
  });

  it('a read stops at the first error and the error is redacted', async () => {
    const { sessions, opened } = sessionsHarness();
    await sessions.runRead(env, { statements: plan('SELECT 1'), maxRows: 10 }); // opens the session
    opened[0]!.session.script = [() => ({}), () => ({ error: { message: "Access denied for user 'u'@'10.1.1.1'", code: 'ER_X' } })];
    const out = await sessions.runRead(env, { statements: plan('SELECT 2', 'SELECT 3', 'SELECT 4'), maxRows: 10 });
    expect(out.results).toHaveLength(2);
    // the person reads it in the app locale (pt-BR in unit tests): its own placeholders
    expect(out.error).toMatchObject({ message: "Access denied for user '<usuário>'@'<servidor>'", code: 'ER_X' });
    // what the agent reads: the same redacted text, in English
    expect(agentText(out.error!)).toBe("Access denied for user '<user>'@'<server>'");
  });

  it('the failing statement inside the results is redacted too, for reads and writes, all the way to the agent', async () => {
    const raw = "SELECT command denied to user 'app_ro'@'10.9.8.7' for table 't' on db.internal.example";
    const leak = /app_ro|10\.9\.8\.7|db\.internal/;
    const failing = () => {
      const session = new FakeDbSession();
      // every statement fails like a server refusal that quotes the login, the client address and the host
      session.script = Array.from({ length: 5 }, () => () => ({ error: { message: raw, code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142, sqlState: '42000' } }));
      return session;
    };
    const s = new AgentSessions({
      getDriver: () => ({ engine: 'mysql', open: async () => failing(), introspect: async () => ({ databases: [] }), test: async () => ({ serverVersion: 'x' }) }),
      resolveConnectParams: async () => ({ host: env.host, port: env.port, user: 'app_ro', tls: 'off' }),
    });
    const read = await s.runRead(env, { statements: plan('SELECT * FROM t'), maxRows: 10 });
    const write = await s.runWrite(env, { statements: plan('UPDATE t SET a = 1'), maxRows: 10 });
    for (const out of [read, write]) {
      const failed = out.results.find((r) => r.error);
      expect(failed).toBeDefined();
      expect(JSON.stringify(out.results)).not.toMatch(leak);
      expect(failed!.error).toMatchObject({ code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142, sqlState: '42000' });
      expect(agentText(failed!.error!)).toBe("SELECT command denied to user '<user>'@'<server>' for table 't' on <server>");
    }

    // a failed read still returns its results to the agent: the error in them is the redacted one
    const h = makeBroker();
    h.executor.readOutcome = read;
    const reply = (await h.broker.query({ env: 'api/dev', sql: 'SELECT * FROM t' })) as { results?: { error?: { message: string } }[] };
    expect(reply.results?.[0]?.error?.message).toBe("SELECT command denied to user '<user>'@'<server>' for table 't' on <server>");
    expect(JSON.stringify(reply)).not.toMatch(leak);
  });

  it('every write gets its own new connection in Transaction mode and keeps it open for the decision', async () => {
    const { sessions, opened } = sessionsHarness();
    const a = await sessions.runWrite(env, { statements: plan('UPDATE t SET a = 1 WHERE id = 1'), maxRows: 10 });
    opened[0]!.session.script = [];
    // the fake reports no transaction flag, so it counts as "nothing open"
    expect(a.open).toBe(false);
    expect(opened[0]!.session.modes).toEqual(['transaction']);
    const b = await sessions.runWrite(env, { statements: plan('UPDATE t SET a = 2 WHERE id = 1'), maxRows: 10 });
    expect(opened).toHaveLength(2);
    expect(opened[0]!.session).not.toBe(opened[1]!.session);
    expect(b.open).toBe(false);
  });

  it('with the server reporting a transaction: open until commit/rollback, then the connection closes', async () => {
    const session = new FakeDbSession();
    session.script = [() => ({ kind: 'write', verb: 'UPDATE', affectedRows: 2, inTransaction: true })];
    const s2 = new AgentSessions({
      getDriver: () => ({ engine: 'mysql', open: async () => session, introspect: async () => ({ databases: [] }), test: async () => ({ serverVersion: 'x' }) }),
      resolveConnectParams: async () => ({ host: 'h', port: 1, user: 'u', tls: 'off' }),
    });
    const run = await s2.runWrite(env, { statements: plan('UPDATE t SET a = 1 WHERE id = 1'), maxRows: 10 });
    expect(run.open).toBe(true);
    expect(session.closed).toBe(false);
    await run.commit();
    expect(session.commits).toBe(1);
    expect(session.closed).toBe(true);
  });

  it('a command that fails rolls back and closes at once; a commit behind our back aborts the request', async () => {
    const failing = new FakeDbSession();
    failing.script = [() => ({ inTransaction: true }), () => ({ error: { message: 'boom', code: 'ER_Y' }, inTransaction: true })];
    const s = new AgentSessions({
      getDriver: () => ({ engine: 'mysql', open: async () => failing, introspect: async () => ({ databases: [] }), test: async () => ({ serverVersion: 'x' }) }),
      resolveConnectParams: async () => ({ host: 'h', port: 1, user: 'u', tls: 'off' }),
    });
    const r = await s.runWrite(env, { statements: plan('UPDATE a SET x = 1 WHERE id = 1', 'UPDATE b SET x = 1 WHERE id = 1', 'UPDATE c SET x = 1 WHERE id = 1'), maxRows: 10 });
    expect(r).toMatchObject({ open: false, error: { code: 'ER_Y' } });
    expect(r.results).toHaveLength(2);
    expect(failing.rollbacks).toBe(1);
    expect(failing.closed).toBe(true);

    const sneaky = new FakeDbSession();
    sneaky.script = [() => ({ inTransaction: true }), () => ({ inTransaction: false })];
    const s2 = new AgentSessions({
      getDriver: () => ({ engine: 'mysql', open: async () => sneaky, introspect: async () => ({ databases: [] }), test: async () => ({ serverVersion: 'x' }) }),
      resolveConnectParams: async () => ({ host: 'h', port: 1, user: 'u', tls: 'off' }),
    });
    const r2 = await s2.runWrite(env, { statements: plan('UPDATE a SET x = 1 WHERE id = 1', 'UPDATE b SET x = 1 WHERE id = 1'), maxRows: 10 });
    expect(r2).toMatchObject({ open: false, error: { code: 'unexpected_commit' } });
    expect(sneaky.closed).toBe(true);
  });

  it('connection failures reach the agent without host, login or token', async () => {
    const { sessions, failOpen } = sessionsHarness();
    failOpen(new DriverError('No response from db.internal.example:3306. Is the VPN on?', { message: 'x', code: 'ETIMEDOUT' }));
    const err = (await sessions.runRead(env, { statements: plan('SELECT 1'), maxRows: 1 }).catch((e) => e)) as AgentError;
    expect(err).toBeInstanceOf(AgentError);
    expect(err.code).toBe('connection_failed');
    expect(err.message).not.toContain('db.internal.example');
    expect(err.message).toContain('Não foi possível conectar ao ambiente');
    failOpen(new DriverError("Access denied for user 'u'@'10.1.1.1'", { message: 'x', errno: 1045 }));
    const denied = (await sessions.runWrite(env, { statements: plan('UPDATE t SET a = 1'), maxRows: 1 }).catch((e) => e)) as AgentError;
    expect(denied.message).not.toMatch(/'u'|10\.1\.1\.1|secret-pw/);

    const broken = new AgentSessions({ getDriver: () => sessionsHarness().sessions as never, resolveConnectParams: async () => { throw new Error('gcloud: token ya29.SECRET for ana@corp.com'); } });
    const cred = (await broken.runRead(env, { statements: plan('SELECT 1'), maxRows: 1 }).catch((e) => e)) as AgentError;
    expect(cred.message).not.toMatch(/ya29|ana@corp/);
  });

  it('environmentChanged drops the cached read connection', async () => {
    const { sessions, opened } = sessionsHarness();
    await sessions.runRead(env, { statements: plan('SELECT 1'), maxRows: 1 });
    await sessions.environmentChanged(env.id);
    expect(opened[0]!.session.closed).toBe(true);
    await sessions.runRead(env, { statements: plan('SELECT 1'), maxRows: 1 });
    expect(opened).toHaveLength(2);
    await sessions.closeAll();
    expect(opened[1]!.session.closed).toBe(true);
  });
});

describe('tabs file keeps the script link', () => {
  it('round-trips scriptId and loads files without it', async () => {
    const tabs = new TabsStore(dir);
    await tabs.save({ version: 1, tabs: [{ id: 't1', environmentId: 'e', sql: 'x', scriptId: 's1' }, { id: 't2', environmentId: 'e', sql: 'y' }], activeTabId: 't1' });
    const loaded = await tabs.load();
    expect(loaded.tabs.map((t) => t.scriptId)).toEqual(['s1', undefined]);
  });
});

describe('AgentSessions: limits, pool, database and schema cache', () => {
  /** A session whose statement hangs until the KILL arrives. */
  class HangSession extends FakeDbSession {
    release?: (r: Partial<StatementResult>) => void;
    override async execute(sql: string): Promise<StatementResult> {
      this.executed.push(sql);
      if (!/HANG/.test(sql)) return { index: 0, sql, kind: 'read', verb: 'SELECT', durationMs: 1, columns: [], rows: [] };
      const extra = await new Promise<Partial<StatementResult>>((r) => (this.release = r));
      return { index: 0, sql, kind: 'read', verb: 'SELECT', durationMs: 1, ...extra };
    }
    override async cancel() {
      this.release?.({ error: { message: 'Query cancelada.', code: 'CANCELLED' } });
    }
  }

  function hangHarness(initial: FakeDbSession[] = []) {
    const clock = new FakeClock();
    const opened: FakeDbSession[] = [];
    const queue = [...initial];
    const driver: Driver = {
      engine: 'mysql',
      open: async () => {
        const s = queue.shift() ?? new HangSession();
        opened.push(s);
        return s;
      },
      introspect: async () => ({ databases: [] }),
      test: async () => ({ serverVersion: 'x' }),
    };
    const sessions = new AgentSessions({ getDriver: () => driver, resolveConnectParams: async () => ({ host: 'h', port: 1, user: 'u', tls: 'off' }), scheduler: clock, now: () => clock.now });
    return { sessions, opened, clock };
  }

  it('reads get max_execution_time 30 s; writes get innodb_lock_wait_timeout 10 s', async () => {
    const { sessions, opened } = sessionsHarness();
    await sessions.runRead(env, { statements: plan('SELECT 1'), maxRows: 1 });
    expect(opened[0]!.session.limits).toEqual([{ maxExecutionMs: 30_000 }]);
    await sessions.runWrite(env, { statements: plan('UPDATE t SET a = 1 WHERE id = 1'), maxRows: 1 });
    expect(opened[1]!.session.limits).toEqual([{ lockWaitSeconds: 10, maxExecutionMs: 30_000 }]);
  });

  it('a statement still running after 35 s is killed (it covers what max_execution_time misses), comes back as failed and the connection is dropped', async () => {
    const { sessions, opened, clock } = hangHarness();
    const slow = sessions.runRead(env, { statements: plan('SELECT HANG'), maxRows: 1 });
    await flush();
    await clock.advance(34_999);
    let settled = false;
    void slow.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    await clock.advance(1);
    const out = await slow;
    expect(out.error).toMatchObject({ message: 'Tempo limite para agentes esgotado.', code: 'agent_timeout' });
    expect(agentText(out.error!)).toBe('Time limit for agents reached.');
    expect(opened[0]!.closed).toBe(true);
    await sessions.runRead(env, { statements: plan('SELECT 1'), maxRows: 1 });
    expect(opened).toHaveLength(2); // a new connection, the cut one is never reused
  });

  it('one stuck query does not block the next reads of the same environment', async () => {
    const { sessions, opened, clock } = hangHarness();
    const slow = sessions.runRead(env, { statements: plan('SELECT HANG'), maxRows: 1 });
    await flush();
    const quick = await sessions.runRead(env, { statements: plan('SELECT 1'), maxRows: 1 });
    expect(quick.error).toBeUndefined();
    expect(opened).toHaveLength(2);
    await clock.advance(60_000);
    expect((await slow).error?.code).toBe('agent_timeout');
  });

  it('each read runs in the database it asked for: with no default and no --database a connection left in another database is replaced before running', async () => {
    const { sessions, opened } = sessionsHarness();
    const noDefault: Environment = { ...env, defaultDatabase: undefined };
    await sessions.runRead(noDefault, { database: 'other', statements: plan('SELECT 1'), maxRows: 1 });
    expect(opened[0]!.session.executed).toEqual(['USE `other`', 'SELECT 1']);
    await sessions.runRead(noDefault, { statements: plan('SELECT DATABASE()'), maxRows: 1 });
    expect(opened[0]!.session.closed).toBe(true); // recycled BEFORE the statement
    expect(opened[0]!.session.executed).not.toContain('SELECT DATABASE()');
    expect(opened).toHaveLength(2);
    expect(opened[1]!.session.executed).toEqual(['SELECT DATABASE()']); // fresh connection, no USE
    await sessions.runRead(noDefault, { statements: plan('SELECT 2'), maxRows: 1 });
    expect(opened).toHaveLength(2); // the clean one is reused
  });

  it('metadata is cached for 60 s per environment, fetched once at a time, and failures are not cached', async () => {
    const clock = new FakeClock();
    let calls = 0;
    let fail = false;
    const gate: { open?: () => void } = {};
    const driver: Driver = {
      engine: 'mysql',
      open: async () => new FakeDbSession(),
      introspect: async () => {
        calls++;
        if (fail) throw new DriverError('boom', { message: 'boom' });
        await new Promise<void>((r) => (gate.open = r));
        return { databases: [{ name: 'app', tables: [] }] };
      },
      test: async () => ({ serverVersion: 'x' }),
    };
    const sessions = new AgentSessions({ getDriver: () => driver, resolveConnectParams: async () => ({ host: 'h', port: 1, user: 'u', tls: 'off' }), scheduler: clock, now: () => clock.now });
    const burst = Promise.all(Array.from({ length: 40 }, () => sessions.schema(env)));
    await flush();
    gate.open!();
    await burst;
    expect(calls).toBe(1); // single flight
    await sessions.schema(env);
    expect(calls).toBe(1); // cached
    await clock.advance(60_000);
    const again = sessions.schema(env);
    await flush();
    gate.open!();
    await again;
    expect(calls).toBe(2);
    await sessions.environmentChanged(env.id);
    fail = true;
    await expect(sessions.schema(env)).rejects.toBeInstanceOf(AgentError);
    expect(calls).toBe(3);
    await expect(sessions.schema(env)).rejects.toBeInstanceOf(AgentError);
    expect(calls).toBe(4); // the failure was not cached
  });

  it('a Rollback reports when the server could not undo everything', async () => {
    const session = new FakeDbSession();
    session.script = [() => ({ kind: 'write', verb: 'UPDATE', affectedRows: 1, inTransaction: true })];
    session.lastRollbackIncomplete = true;
    const s = new AgentSessions({
      getDriver: () => ({ engine: 'mysql', open: async () => session, introspect: async () => ({ databases: [] }), test: async () => ({ serverVersion: 'x' }) }),
      resolveConnectParams: async () => ({ host: 'h', port: 1, user: 'u', tls: 'off' }),
    });
    const run = await s.runWrite(env, { statements: plan('UPDATE t SET a = 1 WHERE id = 1'), maxRows: 1 });
    expect(await run.rollback()).toEqual({ incomplete: true });
    expect(session.closed).toBe(true);
  });
});
