import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import type { Environment } from '@shared/model';
import type { SessionState, StatementResult } from '@shared/results';
import type { ConnectParams, DbSession, DbSessionError, Driver } from '@main/drivers/types';
import { DriverError } from '@main/drivers/types';
import { SessionManager, type PersonTrailLine, type SessionDeps } from '@main/sessions';
import { FakeClock } from '../support/agent-fakes';
import { setLocale } from '@shared/i18n';

class FakeSession implements DbSession {
  serverVersion = '8.4.0-fake';
  executed: string[] = [];
  modes: string[] = [];
  commits = 0;
  rollbacks = 0;
  closed = false;
  database: string | null = 'app';
  nextError: StatementResult['error'] | undefined;
  txFlag: boolean | undefined;
  private fatal: ((e: DbSessionError) => void)[] = [];
  async applyMode(mode: string) {
    this.modes.push(mode);
  }
  async execute(sql: string): Promise<StatementResult> {
    this.executed.push(sql);
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = undefined;
      return { index: 0, sql, kind: 'other', verb: '', durationMs: 1, error, inTransaction: this.txFlag };
    }
    const m = /^USE `(.+)`$/.exec(sql);
    if (m) this.database = m[1]!.replace(/``/g, "`");
    return { index: 0, sql, kind: 'other', verb: '', durationMs: 1, columns: [], rows: [], inTransaction: this.txFlag };
  }
  async cancel() {}
  async commit() {
    this.commits++;
  }
  async rollback() {
    this.rollbacks++;
  }
  async currentDatabase() {
    return this.database;
  }
  onFatalError(cb: (e: DbSessionError) => void) {
    this.fatal.push(cb);
  }
  async close() {
    this.closed = true;
  }
  isClosed() {
    return this.closed;
  }
  triggerFatal(info: DbSessionError) {
    this.fatal.forEach((cb) => cb(info));
  }
}

const dev: Environment = {
  id: 'dev', projectId: 'p', name: 'dev', engine: 'mysql', host: 'h', port: 3306, credentialId: 'c', production: false,
};
const pro: Environment = { ...dev, id: 'pro', name: 'pro', production: true };

let sessions: FakeSession[];
let events: SessionState[];
let manager: SessionManager;
let clock = 1000;
/** When set, the next driver open fails with it. */
let openError: Error | undefined;

function makeManager(extra: Partial<SessionDeps> = {}): SessionManager {
  const driver: Driver = {
    engine: 'mysql',
    open: async (_p: ConnectParams) => {
      if (openError) {
        const error = openError;
        openError = undefined;
        throw error;
      }
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
    introspect: async () => ({ databases: [] }),
    test: async () => ({ serverVersion: 'x' }),
  };
  return new SessionManager({
    getEnvironment: (id) => ({ dev, pro })[id as 'dev' | 'pro'],
    resolveConnectParams: async () => ({ host: 'h', port: 3306, user: 'u', tls: 'off' }),
    getDriver: () => driver,
    getDialect: getDialect,
    emit: (s) => events.push(s),
    now: () => clock,
    ...extra,
  });
}

beforeEach(() => {
  sessions = [];
  events = [];
  clock = 1000;
  openError = undefined;
  manager = makeManager();
});

const run = (tab: string, sql: string, extra: Record<string, unknown> = {}) =>
  manager.run(tab, { sql, scope: 'all', cursor: 0, maxRows: 1000, ...extra });

describe('SessionManager: modes', () => {
  it('opens production in read-only and the others in autocommit', async () => {
    expect((await manager.open('t1', 'pro')).mode).toBe('read-only');
    expect((await manager.open('t2', 'dev')).mode).toBe('autocommit');
    expect(sessions[0]!.modes).toEqual(['read-only']);
    expect(sessions[1]!.modes).toEqual(['autocommit']);
  });

  it('requires confirmation to go to autocommit in production, and only there', async () => {
    await manager.open('t1', 'pro');
    const first = await manager.setMode('t1', 'autocommit');
    expect(first.needsConfirmation).toEqual({ reason: 'production-autocommit' });
    expect(first.session.mode).toBe('read-only');
    const second = await manager.setMode('t1', 'autocommit', { confirmed: true });
    expect(second.session.mode).toBe('autocommit');
    expect(sessions[0]!.modes).toEqual(['read-only', 'autocommit']);

    await manager.open('t2', 'dev');
    expect((await manager.setMode('t2', 'transaction')).session.mode).toBe('transaction');
    expect((await manager.setMode('t2', 'autocommit')).needsConfirmation).toBeUndefined();
  });

  it('refuses switching mode with an open transaction', async () => {
    await manager.open('t', 'dev');
    await manager.setMode('t', 'transaction');
    await run('t', 'UPDATE a SET b = 1');
    await expect(manager.setMode('t', 'autocommit')).rejects.toThrow('Faça commit ou rollback antes de trocar o modo');
    await manager.commit('t');
    expect((await manager.setMode('t', 'autocommit')).session.mode).toBe('autocommit');
  });
});

describe('SessionManager: read-only', () => {
  beforeEach(async () => {
    await manager.open('t', 'pro');
  });

  it('refuses writes before they leave the app, with the reason', async () => {
    const res = await run('t', 'INSERT INTO a VALUES (1)');
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.error?.message).toContain('Somente leitura');
    expect(sessions[0]!.executed).toEqual([]);
  });

  it('reclassifies on the main side: CTE + UPDATE, FOR UPDATE and SET autocommit are refused', async () => {
    for (const sql of [
      'WITH x AS (SELECT 1) UPDATE t SET a = 1',
      'SELECT * FROM t FOR UPDATE',
      'SET autocommit = 0',
      'START TRANSACTION',
    ]) {
      const res = await run('t', sql);
      expect(res.results[0]!.error, sql).toBeDefined();
    }
    expect(sessions[0]!.executed).toEqual([]);
  });

  it('runs the allowed list', async () => {
    const res = await run('t', "SELECT 1; SHOW TABLES; SET @x = 1; USE `other`");
    expect(res.results.map((r) => r.error)).toEqual([undefined, undefined, undefined, undefined]);
    expect(sessions[0]!.executed).toHaveLength(4);
    expect(res.session.database).toBe('other');
  });

  it('refuses the whole script when any statement is refused', async () => {
    const res = await run('t', 'SELECT 1; DELETE FROM t');
    expect(res.results[0]!.index).toBe(1);
    expect(sessions[0]!.executed).toEqual([]);
  });
});

describe('SessionManager: transaction mode', () => {
  beforeEach(async () => {
    await manager.open('t', 'dev');
    await manager.setMode('t', 'transaction');
  });

  it('counts a transaction as open from the first command, even a SELECT', async () => {
    clock = 5000;
    const res = await run('t', 'SELECT 1');
    expect(res.session.transaction).toEqual({ open: true, statements: 1, startedAt: 5000 });
    const res2 = await run('t', 'UPDATE a SET b = 1; UPDATE a SET b = 2');
    expect(res2.session.transaction).toMatchObject({ open: true, statements: 3, startedAt: 5000 });
  });

  it('does not open a transaction for USE / SET @x', async () => {
    const res = await run('t', 'SET @x = 1; USE `db2`');
    expect(res.session.transaction.open).toBe(false);
  });

  it('typed COMMIT and ROLLBACK reset the counter', async () => {
    await run('t', 'UPDATE a SET b = 1');
    expect((await run('t', 'COMMIT')).session.transaction).toEqual({ open: false, statements: 0 });
    await run('t', 'UPDATE a SET b = 1');
    expect((await run('t', 'ROLLBACK')).session.transaction).toEqual({ open: false, statements: 0 });
  });

  it('asks for confirmation on implicit commit with an open transaction, running nothing', async () => {
    await run('t', 'UPDATE a SET b = 1');
    const before = sessions[0]!.executed.length;
    const res = await run('t', 'ALTER TABLE a ADD c int');
    expect(res.needsConfirmation).toEqual({ reason: 'implicit-commit', statements: ['ALTER TABLE a ADD c int'] });
    expect(res.results).toEqual([]);
    expect(sessions[0]!.executed.length).toBe(before);
    const confirmed = await run('t', 'ALTER TABLE a ADD c int', { confirmed: true });
    expect(confirmed.results[0]!.error).toBeUndefined();
    expect(confirmed.session.transaction.open).toBe(false);
  });

  it('detects the implicit commit inside a script that opens the transaction itself', async () => {
    const res = await run('t', 'UPDATE a SET b = 1; DROP TABLE x');
    expect(res.needsConfirmation?.statements).toEqual(['DROP TABLE x']);
    expect(sessions[0]!.executed).toEqual([]);
  });

  it('does not ask when there is no transaction to commit', async () => {
    const res = await run('t', 'CREATE TABLE z (a int)');
    expect(res.needsConfirmation).toBeUndefined();
  });

  it('refuses SET autocommit and accepts START TRANSACTION', async () => {
    const res = await run('t', 'SET autocommit = 1');
    expect(res.results[0]!.error?.message).toContain('modo da aba');
    const begin = await run('t', 'START TRANSACTION');
    expect(begin.results[0]!.error).toBeUndefined();
    expect(begin.session.transaction.open).toBe(true);
  });

  it('stops at the first error and keeps the transaction state of what ran', async () => {
    sessions[0]!.nextError = { message: 'boom', code: 'X' };
    const res = await run('t', 'UPDATE a SET b = 1; UPDATE a SET b = 2');
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.error?.message).toBe('boom');
    expect(sessions[0]!.executed).toHaveLength(1);
    expect(res.session.status).toBe('idle');
  });
});

describe('SessionManager: modes without transaction', () => {
  it('refuses BEGIN and SET autocommit typed in autocommit mode', async () => {
    await manager.open('t', 'dev');
    for (const sql of ['BEGIN', 'START TRANSACTION', 'SET autocommit=0']) {
      const res = await run('t', sql);
      expect(res.results[0]!.error?.message, sql).toContain('modo');
    }
    expect(sessions[0]!.executed).toEqual([]);
  });
});

describe('SessionManager: selecting what runs', () => {
  it('runs the statement under the cursor, or the selection', async () => {
    await manager.open('t', 'dev');
    const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3;';
    await manager.run('t', { sql, scope: 'current', cursor: 12, maxRows: 10 });
    expect(sessions[0]!.executed).toEqual(['SELECT 2']);
    await manager.run('t', { sql, scope: 'current', cursor: 0, selection: { from: 0, to: 19 }, maxRows: 10 });
    expect(sessions[0]!.executed.slice(1)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('rejects empty input', async () => {
    await manager.open('t', 'dev');
    await expect(run('t', '  -- nothing')).rejects.toThrow('Não há nenhum comando');
  });
});

describe('SessionManager: closing and failures', () => {
  it('requires a resolution to close a tab with an open transaction', async () => {
    await manager.open('t', 'dev');
    await manager.setMode('t', 'transaction');
    await run('t', 'UPDATE a SET b = 1');
    expect(manager.pendingTransactions()).toEqual([{ tabId: 't', statements: 1 }]);
    await expect(manager.close('t')).rejects.toThrow('transação aberta');
    await manager.close('t', { resolve: 'rollback' });
    expect(sessions[0]!.rollbacks).toBe(1);
    expect(sessions[0]!.closed).toBe(true);
    expect(manager.pendingTransactions()).toEqual([]);
  });

  it('commits on request when closing', async () => {
    await manager.open('t', 'dev');
    await manager.setMode('t', 'transaction');
    await run('t', 'UPDATE a SET b = 1');
    await manager.close('t', { resolve: 'commit' });
    expect(sessions[0]!.commits).toBe(1);
  });

  it('reports a lost connection with an open transaction', async () => {
    await manager.open('t', 'dev');
    await manager.setMode('t', 'transaction');
    await run('t', 'UPDATE a SET b = 1');
    sessions[0]!.triggerFatal({ message: 'Conexão perdida.', fatal: true });
    const state = manager.state('t');
    expect(state.status).toBe('error');
    expect(state.error).toBe('A conexão caiu e o servidor desfez a transação aberta (1 comando).');
    expect(state.notice).toBe(state.error);
    expect(state.transaction.open).toBe(false);
    await expect(run('t', 'SELECT 1')).rejects.toThrow('não está conectada');
  });

  it('rewrites a fatal statement error when a transaction was open', async () => {
    await manager.open('t', 'dev');
    await manager.setMode('t', 'transaction');
    await run('t', 'UPDATE a SET b = 1');
    sessions[0]!.nextError = { message: 'Conexão perdida.', fatal: true };
    const res = await run('t', 'SELECT 1');
    expect(res.results[0]!.error?.message).toBe('A conexão caiu e o servidor desfez a transação aberta (1 comando).');
  });

  it('switches database through USE with the quoted name', async () => {
    await manager.open('t', 'dev');
    const state = await manager.useDatabase('t', 'we`ird');
    expect(sessions[0]!.executed).toEqual(['USE `we``ird`']);
    expect(state.database).toBe('we`ird');
  });

  it('publishes state changes', async () => {
    await manager.open('t', 'dev');
    expect(events.map((e) => e.status)).toEqual(['connecting', 'idle']);
  });
});

describe('SessionManager: transaction state comes from the server flag', () => {
  beforeEach(async () => {
    await manager.open('t', 'dev');
    await manager.setMode('t', 'transaction');
  });

  it('follows the flag after each statement: open while set, counting non-control statements', async () => {
    clock = 7000;
    sessions[0]!.txFlag = false;
    expect((await run('t', 'SELECT 1')).session.transaction.open).toBe(false); // SELECT without tables
    sessions[0]!.txFlag = true;
    expect((await run('t', 'INSERT INTO a VALUES (1)')).session.transaction).toEqual({ open: true, statements: 1, startedAt: 7000 });
    expect((await run('t', 'UPDATE a SET b = 1')).session.transaction.statements).toBe(2);
    sessions[0]!.txFlag = false;
    expect((await run('t', 'COMMIT')).session.transaction).toEqual({ open: false, statements: 0 });
  });

  it('transaction-control statements do not add to the counter', async () => {
    sessions[0]!.txFlag = true;
    const begin = await run('t', 'START TRANSACTION');
    expect(begin.session.transaction).toMatchObject({ open: true, statements: 0 });
    expect((await run('t', 'UPDATE a SET b = 1')).session.transaction.statements).toBe(1);
  });

  it('a failing statement can close the transaction (server committed) or leave it open', async () => {
    sessions[0]!.txFlag = true;
    await run('t', 'INSERT INTO a VALUES (1)');
    sessions[0]!.nextError = { message: 'Table exists', errno: 1050 };
    sessions[0]!.txFlag = false; // failing DDL: the server committed implicitly
    const closed = await run('t', 'CREATE TABLE a (x int)', { confirmed: true });
    expect(closed.results[0]!.error).toBeDefined();
    expect(closed.session.transaction.open).toBe(false);

    sessions[0]!.txFlag = true;
    await run('t', 'INSERT INTO a VALUES (2)');
    sessions[0]!.nextError = { message: 'dup', errno: 1062 };
    const open = await run('t', 'INSERT INTO a VALUES (2)');
    expect(open.session.transaction).toMatchObject({ open: true, statements: 2 });
  });
});

describe('SessionManager: the mode belongs to the tab', () => {
  it('survives a dropped connection (transaction and read-only)', async () => {
    await manager.open('t', 'dev');
    await manager.setMode('t', 'transaction');
    sessions[0]!.triggerFatal({ message: 'gone', fatal: true });
    expect(manager.state('t').status).toBe('error');
    const again = await manager.open('t', 'dev');
    expect(again.mode).toBe('transaction');
    expect(sessions[1]!.modes).toEqual(['transaction']);

    await manager.open('p', 'pro');
    sessions[2]!.triggerFatal({ message: 'gone', fatal: true });
    expect((await manager.open('p', 'pro')).mode).toBe('read-only');
  });

  it('keeps a confirmed production autocommit across reconnects, but asks for a new one', async () => {
    await manager.open('p', 'pro');
    await manager.setMode('p', 'autocommit', { confirmed: true });
    sessions[0]!.triggerFatal({ message: 'gone', fatal: true });
    expect((await manager.open('p', 'pro')).mode).toBe('autocommit');
    await manager.close('p');
    await expect(manager.open('q', 'pro', { mode: 'autocommit' })).rejects.toThrow('confirmação');
    expect((await manager.open('q', 'pro', { mode: 'autocommit', confirmed: true })).mode).toBe('autocommit');
  });

  it('uses the requested mode on the first open', async () => {
    expect((await manager.open('t', 'dev', { mode: 'transaction' })).mode).toBe('transaction');
  });
});

describe('SessionManager: environment edits', () => {
  it('drops idle sessions so they reconnect with the new settings', async () => {
    await manager.open('t', 'dev');
    await manager.environmentChanged('dev');
    expect(sessions[0]!.isClosed()).toBe(true);
    expect(manager.state('t').status).toBe('disconnected');
    await expect(run('t', 'SELECT 1')).rejects.toThrow('não está conectada');
    expect((await manager.open('t', 'dev')).status).toBe('idle');
    expect(sessions).toHaveLength(2);
  });

  it('keeps a session with an open transaction, warns, and recycles it when the transaction ends', async () => {
    await manager.open('t', 'dev');
    await manager.setMode('t', 'transaction');
    sessions[0]!.txFlag = true;
    await run('t', 'UPDATE a SET b = 1');
    await manager.environmentChanged('dev');
    expect(sessions[0]!.isClosed()).toBe(false);
    expect(manager.state('t').notice).toBe('O ambiente mudou; vale depois de encerrar a transação.');
    sessions[0]!.txFlag = false;
    await manager.commit('t');
    expect(sessions[0]!.isClosed()).toBe(true);
    expect(manager.state('t').status).toBe('disconnected');
    expect(manager.state('t').notice).toBeUndefined();
  });
});

describe('SessionManager: statement under the cursor', () => {
  it('runs nothing on a blank line', async () => {
    await manager.open('t', 'dev');
    const sql = 'SELECT 1;\n\nSELECT 2;';
    await expect(manager.run('t', { sql, scope: 'current', cursor: 10, maxRows: 10 })).rejects.toThrow(
      'Nenhum comando sob o cursor.',
    );
    expect(sessions[0]!.executed).toEqual([]);
  });

  it('runs the statement below a comment directly above it', async () => {
    await manager.open('t', 'dev');
    const sql = 'DELETE FROM a;\n\n-- now the select\nSELECT 2;';
    await manager.run('t', { sql, scope: 'current', cursor: sql.indexOf('now'), maxRows: 10 });
    expect(sessions[0]!.executed).toEqual(['SELECT 2']);
  });
});

describe('SessionManager: connection state', () => {
  it('a failed open is a connection error with the message, and the next open clears it', async () => {
    const refused = 'Não foi possível conectar em h:3306 (ECONNREFUSED).';
    openError = new DriverError(refused, { message: refused, code: 'ECONNREFUSED' });
    await expect(manager.open('t', 'dev')).rejects.toThrow('ECONNREFUSED');
    expect(events.map((e) => e.status)).toEqual(['connecting', 'error']);
    expect(events[1]!.error).toBe('Não foi possível conectar em h:3306 (ECONNREFUSED).');
    const again = await manager.open('t', 'dev');
    expect(again.status).toBe('idle');
    expect(again.error).toBeUndefined();
    expect(events.map((e) => e.status)).toEqual(['connecting', 'error', 'connecting', 'idle']);
  });

  it('a dropped connection publishes error with the message', async () => {
    await manager.open('t', 'dev');
    sessions[0]!.triggerFatal({ message: 'Conexão perdida.', fatal: true });
    expect(events.map((e) => e.status)).toEqual(['connecting', 'idle', 'error']);
    expect(events.at(-1)!.error).toBe('Conexão perdida.');
  });

  it('Desconectar keeps the mode and the database, and reconnecting restores them', async () => {
    await manager.open('t', 'dev');
    await manager.setMode('t', 'transaction');
    await manager.useDatabase('t', 'other');
    const off = await manager.disconnect('t');
    expect(off).toMatchObject({ status: 'disconnected', mode: 'transaction', disconnectReason: 'manual' });
    expect(off.serverVersion).toBeUndefined();
    expect(sessions[0]!.isClosed()).toBe(true);
    await expect(run('t', 'SELECT 1')).rejects.toMatchObject({ code: 'not-connected' });
    const on = await manager.open('t', 'dev');
    expect(on.mode).toBe('transaction');
    expect(on.disconnectReason).toBeUndefined();
    expect(sessions[1]!.modes).toEqual(['transaction']);
  });

  it('Desconectar is refused in main with a transaction open or a statement running', async () => {
    await manager.open('t', 'dev');
    await manager.setMode('t', 'transaction');
    sessions[0]!.txFlag = true;
    await run('t', 'UPDATE a SET b = 1');
    await expect(manager.disconnect('t')).rejects.toMatchObject({ code: 'transaction-open', message: 'Faça commit ou rollback antes de desconectar.' });
    expect(sessions[0]!.isClosed()).toBe(false);
    expect(manager.state('t').status).toBe('idle');
    sessions[0]!.txFlag = false;
    await manager.rollback('t');
    expect((await manager.disconnect('t')).status).toBe('disconnected');

    await manager.open('r', 'dev');
    let release!: () => void;
    const slow = sessions[1]!;
    slow.execute = async (sql: string) => {
      await new Promise<void>((r) => (release = r));
      return { index: 0, sql, kind: 'read', verb: 'SELECT', durationMs: 1 };
    };
    const running = run('r', 'SELECT SLEEP(10)');
    await Promise.resolve();
    await expect(manager.disconnect('r')).rejects.toMatchObject({ code: 'running' });
    release();
    await running;
  });

  it('Desconectar on a connection error clears the error', async () => {
    await manager.open('t', 'dev');
    sessions[0]!.triggerFatal({ message: 'gone', fatal: true });
    const off = await manager.disconnect('t');
    expect(off).toMatchObject({ status: 'disconnected', disconnectReason: 'manual' });
    expect(off.error).toBeUndefined();
  });
});

describe('SessionManager: idle disconnect', () => {
  const IDLE = 30 * 60 * 1000;
  let fake: FakeClock;

  beforeEach(() => {
    fake = new FakeClock();
    manager = makeManager({ scheduler: fake, idleMs: IDLE });
  });

  it('disconnects after the idle time, keeps the mode and says why; the next open clears the reason', async () => {
    await manager.open('t', 'dev');
    await manager.setMode('t', 'transaction');
    await fake.advance(IDLE - 1);
    expect(manager.state('t').status).toBe('idle');
    await fake.advance(1);
    expect(sessions[0]!.isClosed()).toBe(true);
    expect(manager.state('t')).toMatchObject({ status: 'disconnected', disconnectReason: 'idle', mode: 'transaction' });
    expect(events.at(-1)).toMatchObject({ status: 'disconnected', disconnectReason: 'idle' });
    const again = await manager.open('t', 'dev');
    expect(again).toMatchObject({ status: 'idle', mode: 'transaction' });
    expect(again.disconnectReason).toBeUndefined();
  });

  it('every activity starts the clock over', async () => {
    await manager.open('t', 'dev');
    for (const act of [
      () => run('t', 'SELECT 1'),
      () => manager.setMode('t', 'transaction'),
      () => manager.useDatabase('t', 'x'),
      () => manager.commit('t'),
      () => manager.rollback('t'),
    ]) {
      await fake.advance(IDLE - 1000);
      await act();
    }
    await fake.advance(IDLE - 1000);
    expect(manager.state('t').status).toBe('idle');
    await fake.advance(1000);
    expect(manager.state('t').status).toBe('disconnected');
  });

  it('never disconnects with a transaction open; once it ends the clock runs again', async () => {
    await manager.open('t', 'dev');
    await manager.setMode('t', 'transaction');
    sessions[0]!.txFlag = true;
    await run('t', 'UPDATE a SET b = 1');
    await fake.advance(IDLE * 5);
    expect(sessions[0]!.isClosed()).toBe(false);
    expect(manager.state('t')).toMatchObject({ status: 'idle', transaction: { open: true } });
    sessions[0]!.txFlag = false;
    await manager.commit('t');
    await fake.advance(IDLE);
    expect(manager.state('t')).toMatchObject({ status: 'disconnected', disconnectReason: 'idle' });
  });

  it('never disconnects while a statement runs', async () => {
    await manager.open('t', 'dev');
    let release!: () => void;
    const slow = sessions[0]!;
    slow.execute = async (sql: string) => {
      await new Promise<void>((r) => (release = r));
      return { index: 0, sql, kind: 'read', verb: 'SELECT', durationMs: 1 };
    };
    await fake.advance(IDLE - 10);
    const running = run('t', 'SELECT SLEEP(3600)');
    await fake.advance(IDLE * 3);
    expect(manager.state('t').status).toBe('running');
    expect(slow.isClosed()).toBe(false);
    release();
    await running;
    expect(manager.state('t').status).toBe('idle');
    await fake.advance(IDLE);
    expect(manager.state('t').status).toBe('disconnected');
  });

  it('a closed tab or a dropped connection leaves no timer behind', async () => {
    await manager.open('a', 'dev');
    await manager.open('b', 'dev');
    expect(fake.pendingTimers).toBe(2);
    await manager.close('a');
    sessions[1]!.triggerFatal({ message: 'gone', fatal: true });
    expect(fake.pendingTimers).toBe(0);
    await fake.advance(IDLE);
    expect(manager.state('b').status).toBe('error');
  });
});

describe('SessionManager: grid edits', () => {
  it('labels the UPDATEs of Aplicar on the trail, and the mode still decides', async () => {
    const lines: PersonTrailLine[] = [];
    manager = makeManager({ trail: { append: (l) => lines.push(l) } });
    await manager.open('t1', 'dev');
    const sql = "UPDATE `app`.`people` SET `name` = 'Ana' WHERE `id` = 1;\nUPDATE `app`.`people` SET `name` = 'Bia' WHERE `id` = 2;";
    const res = await run('t1', sql, { origin: 'grid', maxRows: 1 });
    expect(res.results).toHaveLength(2);
    expect(sessions[0]!.executed).toHaveLength(2);
    const done = lines.filter((l) => l.event === 'statement' && l.state === 'ok');
    expect(done.map((l) => l.detail)).toEqual(['Edição na grade', 'Edição na grade']);

    // read-only refuses it like any typed UPDATE: nothing leaves the app
    await manager.open('t2', 'pro');
    const refused = await run('t2', sql, { origin: 'grid', maxRows: 1 });
    expect(refused.results[0]!.error?.code).toBe('REFUSED');
    expect(sessions[1]!.executed).toHaveLength(0);
  });

  it('refuses the grid label on anything but UPDATE', async () => {
    await manager.open('t1', 'dev');
    for (const sql of ['DELETE FROM t WHERE id = 1', "UPDATE t SET a = 1 WHERE id = 1; SELECT 1", 'SELECT 1']) {
      await expect(run('t1', sql, { origin: 'grid' })).rejects.toMatchObject({ code: 'grid-not-update' });
    }
    await expect(run('t1', 'UPDATE t SET a = 1 WHERE id = 1', { origin: 'grid', refetch: true })).rejects.toMatchObject({ code: 'refetch-not-read' });
    expect(sessions[0]!.executed).toHaveLength(0);
  });
});

describe('SessionManager in English', () => {
  afterEach(() => setLocale('pt-BR'));

  it('writes errors, notices and trail details in the app locale', async () => {
    const lines: PersonTrailLine[] = [];
    manager = makeManager({ trail: { append: (l) => lines.push(l) } });
    setLocale('en');
    await manager.open('t', 'dev');
    await expect(manager.open('q', 'pro', { mode: 'autocommit' })).rejects.toThrow('Auto-commit in production needs confirmation.');
    await manager.setMode('t', 'transaction');
    expect(lines.at(-1)!.detail).toBe('Auto-commit → Transaction');
    await run('t', 'UPDATE a SET b = 1');
    await expect(manager.setMode('t', 'read-only')).rejects.toThrow('Commit or roll back before changing the mode.');
    await expect(manager.close('t')).rejects.toThrow('A transaction is open in this tab. Choose Commit or Rollback.');
    await manager.commit('t');
    expect(lines.at(-1)!.detail).toBe('1 statement in the transaction');
    await run('t', 'UPDATE a SET b = 2');
    await run('t', 'UPDATE a SET b = 3');
    sessions[0]!.triggerFatal({ message: 'Connection lost.', fatal: true });
    expect(manager.state('t').error).toBe('The connection dropped and the server rolled back the open transaction (2 statements).');
    await expect(run('t', 'SELECT 1')).rejects.toThrow('The session is not connected. Run again to reconnect.');
    await manager.open('r', 'pro');
    const refused = await run('r', 'BEGIN');
    expect(refused.results[0]!.error?.message).toBe('Use the tab’s Transaction mode to open a transaction.');
    await expect(run('r', '  -- nothing')).rejects.toThrow('There is no statement to run.');
  });
});

describe('SessionManager: races with a connect or a statement in flight', () => {
  /** A gate the fake connect or statement waits on. */
  const gate = () => {
    let open!: () => void;
    const wait = new Promise<void>((r) => (open = r));
    return { wait, open };
  };

  it('closing a tab while it connects drops the new connection instead of leaking it', async () => {
    const g = gate();
    manager = makeManager({
      resolveConnectParams: async () => {
        await g.wait;
        return { host: 'h', port: 3306, user: 'u', tls: 'off' };
      },
    });
    const opening = manager.open('t', 'dev');
    await Promise.resolve();
    await manager.close('t');
    g.open();
    await expect(opening).rejects.toThrow('A aba não tem sessão aberta.');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.isClosed()).toBe(true);
    expect(manager.state('t').status).toBe('disconnected');
    expect(events.at(-1)!.status).toBe('disconnected');
  });

  it('an environment edited while a tab connects drops that connection; the next open uses the new settings', async () => {
    let env: Environment = { ...dev };
    const g = gate();
    let first = true;
    manager = makeManager({
      getEnvironment: (id) => (id === 'dev' ? env : undefined),
      resolveConnectParams: async () => {
        if (first) {
          first = false;
          await g.wait;
        }
        return { host: 'h', port: 3306, user: 'u', tls: 'off' };
      },
    });
    const opening = manager.open('t', 'dev');
    await Promise.resolve();
    env = { ...env, production: true };
    await manager.environmentChanged('dev');
    g.open();
    await expect(opening).rejects.toMatchObject({ code: 'not-connected' });
    expect(sessions[0]!.isClosed()).toBe(true);
    expect(manager.state('t').status).toBe('disconnected');
    // reconnecting reads the environment again: production now, so Auto-commit is not kept unconfirmed
    const again = await manager.open('t', 'dev');
    expect(again.status).toBe('idle');
    expect(again.mode).toBe('read-only');
    expect(again.notice).toBe('O ambiente agora é produção: a aba voltou para Somente leitura.');
    expect((await manager.setMode('t', 'autocommit')).needsConfirmation).toEqual({ reason: 'production-autocommit' });
  });

  it('Desconectar or the idle timer during a USE ends it cleanly, not with a TypeError', async () => {
    await manager.open('t', 'dev');
    const g = gate();
    const s = sessions[0]!;
    const execute = s.execute.bind(s);
    s.execute = async (sql: string) => {
      await g.wait;
      return execute(sql);
    };
    const using = manager.useDatabase('t', 'other');
    await Promise.resolve();
    await manager.disconnect('t');
    g.open();
    await expect(using).rejects.toMatchObject({ code: 'not-connected' });
    expect(manager.state('t').status).toBe('disconnected');
    expect(manager.state('t').database).toBe('app');
  });

  it('a mode change that lands after the connection dropped does not claim the new mode', async () => {
    await manager.open('t', 'dev');
    const g = gate();
    const s = sessions[0]!;
    s.applyMode = async (mode: string) => {
      await g.wait;
      s.modes.push(mode);
    };
    const changing = manager.setMode('t', 'transaction');
    await Promise.resolve();
    await manager.disconnect('t');
    g.open();
    await expect(changing).rejects.toMatchObject({ code: 'not-connected' });
    expect(manager.state('t').mode).toBe('autocommit');
  });
});

describe('SessionManager: switching the environment of a tab', () => {
  it('closing the tab while the old connection closes drops the new connection', async () => {
    await manager.open('t', 'dev');
    let release!: () => void;
    const old = sessions[0]!;
    old.close = () => new Promise<void>((r) => { release = () => { old.closed = true; r(); }; });
    const opening = manager.open('t', 'pro').catch((e: unknown) => e);
    await Promise.resolve();
    await manager.close('t').catch(() => undefined);
    release();
    await opening;
    for (const s of sessions) expect(s.closed).toBe(true);
    expect(manager.state('t').status).toBe('disconnected');
  });
});
