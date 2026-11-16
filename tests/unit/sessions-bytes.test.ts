// The cost of a BigQuery statement in the SessionManager: dry run, limit, confirmation, bytes on the trail.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import { GIB } from '@shared/engines';
import { createFormat, setLocale } from '@shared/i18n';
import type { BigqueryEnvironment } from '@shared/model';
import type { StatementResult } from '@shared/results';
import { DriverError } from '@main/drivers/types';
import type { DbSession, DbSessionError, Driver, ExecuteOptions, PrepareResult } from '@main/drivers/types';
import { SessionManager, type PersonTrailLine } from '@main/sessions';
import { Seal } from '@main/store/seal';
import { FakeVault } from '@main/store/vault';
import { Trail } from '@main/trail';
import { FakeClock } from '../support/agent-fakes';

class PreparingSession implements DbSession {
  serverVersion = 'BigQuery';
  prepared: string[] = [];
  executed: { sql: string; opts: ExecuteOptions }[] = [];
  /** What the dry run says per statement text. */
  estimate = (_sql: string): PrepareResult => ({ serverKind: 'SELECT', bytesEstimated: 1024 });
  async applyMode() {}
  async prepare(sql: string): Promise<PrepareResult> {
    this.prepared.push(sql);
    return this.estimate(sql);
  }
  async execute(sql: string, opts: ExecuteOptions): Promise<StatementResult> {
    this.executed.push({ sql, opts });
    return {
      index: 0, sql, kind: 'read', verb: 'SELECT', durationMs: 5, columns: [], rows: [],
      stats: { jobId: `job_${this.executed.length}`, bytesBilled: 2048, bytesProcessed: 2048 },
    };
  }
  async useDatabase(): Promise<StatementResult> {
    throw new Error('not used');
  }
  async cancel() {}
  async commit() {}
  async rollback() {}
  async currentDatabase() {
    return null;
  }
  onFatalError(_cb: (e: DbSessionError) => void) {}
  async close() {}
}

const bq = (over: Partial<BigqueryEnvironment> = {}): BigqueryEnvironment => ({
  id: 'bq', projectId: 'p', name: 'dev', engine: 'bigquery', gcpProject: 'proj', credentialId: 'c', production: false, maxBytesBilled: 100 * GIB, ...over,
});

let session: PreparingSession;
let environment: BigqueryEnvironment;
let lines: PersonTrailLine[];
let manager: SessionManager;

beforeEach(async () => {
  setLocale('pt-BR');
  session = new PreparingSession();
  environment = bq();
  lines = [];
  const driver: Driver = {
    engine: 'bigquery',
    open: async () => session,
    introspect: async () => ({ databases: [] }),
    test: async () => ({ serverVersion: 'x' }),
  };
  manager = new SessionManager({
    getEnvironment: () => environment,
    resolveConnectParams: async () => ({ engine: 'bigquery', project: 'proj', accessToken: 't', origin: 'person' }),
    getDriver: () => driver,
    getDialect,
    emit: () => {},
    now: () => 1000,
    trail: { append: (l) => void lines.push(l) },
  });
  await manager.open('t', 'bq');
});

const run = (sql: string, extra: Record<string, unknown> = {}) =>
  manager.run('t', { sql, scope: 'all', cursor: 0, maxRows: 1000, ...extra } as never);

describe('SessionManager: bytes of a BigQuery statement', () => {
  it('under the limit: runs with the limit as maxBytesBilled, no question', async () => {
    session.estimate = () => ({ serverKind: 'SELECT', bytesEstimated: 5 * GIB });
    const r = await run('SELECT 1');
    expect(r.needsConfirmation).toBeUndefined();
    expect(session.prepared).toEqual(['SELECT 1']);
    expect(session.executed[0]!.opts.maxBytesBilled).toBe(100 * GIB);
    expect(r.results[0]!.error).toBeUndefined();
  });

  it('exactly at the limit still runs', async () => {
    session.estimate = () => ({ serverKind: 'SELECT', bytesEstimated: 100 * GIB });
    expect((await run('SELECT 1')).needsConfirmation).toBeUndefined();
    expect(session.executed).toHaveLength(1);
  });

  it('over the limit: asks with the estimate and the limit, and runs nothing', async () => {
    session.estimate = () => ({ serverKind: 'SELECT', bytesEstimated: 150 * GIB });
    const r = await run('SELECT * FROM big');
    expect(r.results).toEqual([]);
    expect(r.needsConfirmation).toEqual({ reason: 'bytes', limit: 100 * GIB, statements: [{ index: 0, sql: 'SELECT * FROM big', bytesEstimated: 150 * GIB }] });
    expect(session.executed).toHaveLength(0);
    expect(lines).toHaveLength(0);
    expect(manager.state('t').status).toBe('idle');
    // the reply carries the idle state too: the tab does not stay on "Executando…" behind the question
    expect(r.session.status).toBe('idle');
  });

  it('confirmed: runs with the confirmed value rounded up to the GiB, and the trail says it was confirmed', async () => {
    const estimate = 150.5 * GIB;
    session.estimate = () => ({ serverKind: 'SELECT', bytesEstimated: estimate });
    const r = await run('SELECT * FROM big', { confirmedBytes: [{ sql: 'SELECT * FROM big', bytes: estimate }] });
    expect(r.needsConfirmation).toBeUndefined();
    expect(session.executed[0]!.opts.maxBytesBilled).toBe(151 * GIB);
    const line = lines.at(-1)!;
    expect(line.detail).toBe('Acima do limite de 100 GiB (estimativa de 150,5 GiB), confirmado');
    expect(line).toMatchObject({ jobId: 'job_1', bytesEstimated: estimate, bytesBilled: 2048, state: 'ok' });
  });

  it('a confirmation below the limit never lowers it', async () => {
    session.estimate = () => ({ serverKind: 'SELECT', bytesEstimated: 1 * GIB });
    await run('SELECT 1', { confirmedBytes: [{ sql: 'SELECT 1', bytes: 1 * GIB }] });
    expect(session.executed[0]!.opts.maxBytesBilled).toBe(100 * GIB);
  });

  it('the estimate grew after the confirmation: asks again, running nothing', async () => {
    session.estimate = () => ({ serverKind: 'SELECT', bytesEstimated: 200 * GIB });
    const r = await run('SELECT * FROM big', { confirmedBytes: [{ sql: 'SELECT * FROM big', bytes: 150 * GIB }] });
    expect(r.needsConfirmation).toMatchObject({ reason: 'bytes', statements: [{ index: 0, bytesEstimated: 200 * GIB }] });
    expect(session.executed).toHaveLength(0);
  });

  it('no limit: no question and no maxBytesBilled, however large the estimate', async () => {
    environment = bq();
    delete environment.maxBytesBilled;
    await manager.disconnect('t');
    await manager.open('t', 'bq');
    session.estimate = () => ({ serverKind: 'SELECT', bytesEstimated: 5000 * GIB });
    const r = await run('SELECT * FROM big');
    expect(r.needsConfirmation).toBeUndefined();
    expect(session.executed[0]!.opts).not.toHaveProperty('maxBytesBilled');
    expect(lines.at(-1)!.detail).toBeUndefined();
    expect(lines.at(-1)!.bytesEstimated).toBe(5000 * GIB);
  });

  it('Rodar todos with two statements over the limit asks about both at once, before any runs', async () => {
    session.estimate = (sql) => ({ serverKind: 'SELECT', bytesEstimated: sql.includes('small') ? GIB : sql.includes('a') ? 120 * GIB : 300 * GIB });
    const r = await run('SELECT * FROM a; SELECT 1 FROM small; SELECT * FROM b');
    expect(r.needsConfirmation).toEqual({
      reason: 'bytes',
      limit: 100 * GIB,
      statements: [
        { index: 0, sql: 'SELECT * FROM a', bytesEstimated: 120 * GIB },
        { index: 2, sql: 'SELECT * FROM b', bytesEstimated: 300 * GIB },
      ],
    });
    expect(session.executed).toHaveLength(0);
    // the confirmed run: one value per statement that was asked about, the one under the limit needs none
    const ok = await run('SELECT * FROM a; SELECT 1 FROM small; SELECT * FROM b', { confirmedBytes: [{ sql: 'SELECT * FROM a', bytes: 120 * GIB }, { sql: 'SELECT * FROM b', bytes: 300 * GIB }] });
    expect(ok.results).toHaveLength(3);
    expect(session.executed.map((e) => e.opts.maxBytesBilled)).toEqual([120 * GIB, 100 * GIB, 300 * GIB]);
    expect(lines.filter((l) => l.detail).length).toBe(2);
  });

  it('the server reading a DML as the statement type refuses, runs nothing and leaves a line on the trail', async () => {
    session.estimate = (sql) => ({ serverKind: sql.includes('boom') ? 'INSERT' : 'SELECT', bytesEstimated: 10 });
    const r = await run('SELECT 1; SELECT boom');
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ index: 1, error: { code: 'REFUSED' } });
    expect(r.results[0]!.error!.message).toContain('INSERT');
    expect(session.executed).toHaveLength(0);
    expect(lines.at(-1)).toMatchObject({ state: 'refused', sql: 'SELECT boom' });
    expect(manager.state('t').status).toBe('idle');
    expect(r.session.status).toBe('idle');
  });

  it('a server that names no type is refused too', async () => {
    session.estimate = () => ({ bytesEstimated: 10 });
    const r = await run('SELECT 1');
    expect(r.results[0]!.error?.code).toBe('REFUSED');
    expect(session.executed).toHaveLength(0);
  });

  it('a failed dry run is the statement\'s error, nothing runs', async () => {
    session.estimate = () => ({ error: { message: 'Consulta inválida', code: 'invalidQuery' } });
    const r = await run('SELECT nope');
    expect(r.results[0]!.error).toMatchObject({ code: 'invalidQuery' });
    expect(session.executed).toHaveLength(0);
    expect(lines.at(-1)).toMatchObject({ state: 'error', errorCode: 'invalidQuery' });
    expect(r.session.status).toBe('idle');
  });

  it('refetch: no dry run, no question, no new limit', async () => {
    session.estimate = () => ({ serverKind: 'SELECT', bytesEstimated: 500 * GIB });
    await run('SELECT * FROM big', { confirmedBytes: [{ sql: 'SELECT * FROM big', bytes: 500 * GIB }] });
    const r = await run('SELECT * FROM big', { refetch: true, maxRows: 50_000 });
    expect(r.needsConfirmation).toBeUndefined();
    expect(session.prepared).toHaveLength(1);
    expect(session.executed).toHaveLength(2);
    expect(session.executed[1]!.opts).toMatchObject({ refetch: true });
    expect(session.executed[1]!.opts).not.toHaveProperty('maxBytesBilled');
  });

  it('a confirmation is tied to the text it was asked about: another statement at the same place asks again', async () => {
    session.estimate = (sql) => ({ serverKind: 'SELECT', bytesEstimated: sql.includes('B') ? 400 * GIB : 500 * GIB });
    const confirmed = [{ sql: 'SELECT * FROM A', bytes: 500 * GIB }];
    const r = await run('SELECT * FROM B', { confirmedBytes: confirmed });
    expect(r.needsConfirmation).toMatchObject({ reason: 'bytes', statements: [{ index: 0, sql: 'SELECT * FROM B', bytesEstimated: 400 * GIB }] });
    expect(session.executed).toHaveLength(0);
    // the same text still runs, under the ceiling of its own confirmation
    expect((await run('SELECT * FROM A', { confirmedBytes: confirmed })).needsConfirmation).toBeUndefined();
    expect(session.executed[0]!.opts.maxBytesBilled).toBe(500 * GIB);
  });

  it('refetch line: a re-read of the job keeps the job id and carries no bytes; a new run keeps them', async () => {
    const original = session.execute.bind(session);
    session.execute = async (sql, opts) => {
      const r = await original(sql, opts);
      return { ...r, stats: { ...r.stats, bytesEstimated: 99, reread: true } };
    };
    await run('SELECT 1', { refetch: true });
    expect(lines.at(-1)).toMatchObject({ jobId: 'job_1', state: 'ok' });
    expect(lines.at(-1)).not.toHaveProperty('bytesBilled');
    expect(lines.at(-1)).not.toHaveProperty('bytesEstimated');
    session.execute = original;
    await run('SELECT 1');
    expect(lines.at(-1)).toMatchObject({ bytesBilled: 2048 });
  });

  it('the environment edited during the dry run, estimate over the limit: no question under the old limit, the next run uses the new one', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    session.estimate = () => ({ serverKind: 'SELECT', bytesEstimated: 150 * GIB });
    const original = session.prepare.bind(session);
    session.prepare = async (sql) => {
      await gate;
      return original(sql);
    };
    const running = run('SELECT * FROM big');
    await new Promise((r) => setTimeout(r, 5));
    environment = bq({ maxBytesBilled: 10 * GIB });
    await manager.environmentChanged('bq');
    release();
    await expect(running).rejects.toThrow('O ambiente mudou');
    expect(manager.state('t').status).toBe('disconnected');
    session.prepare = original;
    session.estimate = () => ({ serverKind: 'SELECT', bytesEstimated: 50 * GIB });
    await manager.open('t', 'bq');
    const again = await run('SELECT * FROM other');
    expect(again.needsConfirmation).toMatchObject({ reason: 'bytes', limit: 10 * GIB });
    expect(session.executed).toHaveLength(0);
  });

  it('the environment edited during the dry run, nothing over the limit: nothing runs under the old settings', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const original = session.prepare.bind(session);
    session.prepare = async (sql) => {
      await gate;
      return original(sql);
    };
    session.estimate = () => ({ serverKind: 'SELECT', bytesEstimated: 50 * GIB });
    const running = run('SELECT 1');
    await new Promise((r) => setTimeout(r, 5));
    environment = bq({ maxBytesBilled: 10 * GIB });
    await manager.environmentChanged('bq');
    release();
    await expect(running).rejects.toThrow('O ambiente mudou');
    expect(session.executed).toHaveLength(0);
    expect(manager.state('t').status).toBe('disconnected');
  });

  it('a prepare that throws is the statement error, nothing runs, the tab goes back to idle', async () => {
    for (const thrown of [new DriverError('x', { message: 'x', code: 'backendError' }), new Error('y')]) {
      session.prepare = async () => {
        throw thrown;
      };
      const r = await run('SELECT 1');
      expect(r.results[0]!.error).toBeDefined();
      expect(r.results[0]!.error!.message).toContain(thrown.message === 'x' ? 'x' : 'y');
      if (thrown instanceof DriverError) expect(r.results[0]!.error!.code).toBe('backendError');
      expect(session.executed).toHaveLength(0);
      expect(lines.at(-1)).toMatchObject({ state: 'error' });
      expect(r.session.status).toBe('idle');
    }
  });

  it('Cancelar during the dry run: CANCELLED, nothing runs, the tab goes back to idle', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const original = session.prepare.bind(session);
    session.prepare = async (sql) => {
      await gate;
      return original(sql);
    };
    const running = run('SELECT 1');
    await new Promise((r) => setTimeout(r, 5));
    expect(manager.state('t').status).toBe('running');
    await manager.cancel('t');
    release();
    const r = await running;
    expect(r.results[0]!.error).toMatchObject({ code: 'CANCELLED' });
    expect(session.executed).toHaveLength(0);
    expect(lines.at(-1)).toMatchObject({ state: 'cancelled' });
    expect(r.session.status).toBe('idle');
  });

  it('a MySQL session has no prepare: nothing changes', async () => {
    const plain = new PreparingSession();
    (plain as { prepare?: unknown }).prepare = undefined;
    const driver: Driver = { engine: 'mysql', open: async () => plain, introspect: async () => ({ databases: [] }), test: async () => ({ serverVersion: 'x' }) };
    const my = new SessionManager({
      getEnvironment: () => ({ id: 'my', projectId: 'p', name: 'dev', engine: 'mysql', host: 'h', port: 3306, credentialId: 'c', production: false }),
      resolveConnectParams: async () => ({ host: 'h', port: 3306, user: 'u', tls: 'off' }),
      getDriver: () => driver,
      getDialect,
      emit: () => {},
      now: () => 1,
    });
    await my.open('x', 'my');
    const r = await my.run('x', { sql: 'SELECT 1', scope: 'all', cursor: 0, maxRows: 10 });
    expect(r.results[0]!.error).toBeUndefined();
  });
});

describe('formatBytes', () => {
  it('uses binary units in both languages', () => {
    const pt = createFormat('pt-BR');
    const en = createFormat('en');
    expect(pt.formatBytes(0)).toBe('0 B');
    expect(pt.formatBytes(512)).toBe('512 B');
    expect(pt.formatBytes(1024)).toBe('1 KiB');
    expect(pt.formatBytes(5 * 1024 ** 2)).toBe('5 MiB');
    expect(pt.formatBytes(1.5 * GIB)).toBe('1,5 GiB');
    expect(en.formatBytes(1.5 * GIB)).toBe('1.5 GiB');
    expect(en.formatBytes(2 * 1024 ** 4)).toBe('2 TiB');
    expect(en.formatBytes(1024 ** 3 - 1)).toBe('1 GiB');
  });
});

describe('Trail: BigQuery lines', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync('/tmp/cais-bytes-');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps jobId and bytes on the line, chained, and old lines keep their format', async () => {
    const clock = new FakeClock();
    clock.now = Date.UTC(2026, 10, 12, 12);
    const seal = new Seal(dir, new FakeVault());
    await seal.load();
    const trail = new Trail(join(dir, 'trail'), { now: () => clock.now, scheduler: clock, newId: (() => { let n = 0; return () => `t${++n}`; })(), mac: (t) => seal.mac(t) });
    const base = { actor: 'person' as const, environment: 'p/bq', production: false, mode: 'read-only', event: 'statement', sql: 'SELECT 1', state: 'ok' };
    trail.append({ ...base });
    trail.append({ ...base, jobId: 'job_9', bytesEstimated: 1234, bytesBilled: 10_485_760, detail: 'x' });
    const page = trail.list({ days: 1, limit: 10 });
    expect(page.tampered).toEqual([]);
    expect(page.verified).toBe(true);
    const [newer, older] = page.entries;
    expect(newer).toMatchObject({ jobId: 'job_9', bytesEstimated: 1234, bytesBilled: 10_485_760 });
    expect(older).not.toHaveProperty('jobId');
    const raw = readFileSync(join(dir, 'trail', '2026-11-12.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(raw[0]).not.toContain('bytes');
    expect(raw[1]).toContain('"jobId":"job_9"');
  });
});
