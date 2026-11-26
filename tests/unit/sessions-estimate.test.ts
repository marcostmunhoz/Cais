// "Estimar ao digitar": the dry run of the statement being typed, in the SessionManager. What may leave the app is
// decided here (switch, one statement, the classifier), and nothing of it is on the trail.
import { beforeEach, describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import { capabilitiesOf } from '@shared/engines';
import { setLocale } from '@shared/i18n';
import type { BigqueryEnvironment, MysqlEnvironment } from '@shared/model';
import type { StatementResult } from '@shared/results';
import type { DbSession, DbSessionError, Driver, ExecuteOptions, PrepareResult } from '@main/drivers/types';
import { SessionManager, type PersonTrailLine } from '@main/sessions';

class DryRunSession implements DbSession {
  serverVersion = 'BigQuery';
  asked: string[] = [];
  signals: (AbortSignal | undefined)[] = [];
  executed: string[] = [];
  /** The dry run's answer per statement text; a promise the test settles by hand when `hold` is set. */
  answer = (_sql: string): PrepareResult => ({ serverKind: 'SELECT', bytesEstimated: 4096 });
  hold: { resolve(): void; promise: Promise<void> } | undefined;
  async applyMode() {}
  async prepare(sql: string, opts?: { signal?: AbortSignal }): Promise<PrepareResult> {
    this.asked.push(sql);
    this.signals.push(opts?.signal);
    if (this.hold) {
      const hold = this.hold;
      this.hold = undefined;
      await Promise.race([
        hold.promise,
        new Promise<void>((resolve) => opts?.signal?.addEventListener('abort', () => resolve())),
      ]);
      if (opts?.signal?.aborted) return { error: { message: 'cancelado', code: 'CANCELLED' } };
    }
    return this.answer(sql);
  }
  async execute(sql: string, _opts: ExecuteOptions): Promise<StatementResult> {
    this.executed.push(sql);
    return { index: 0, sql, kind: 'read', verb: 'SELECT', durationMs: 1, columns: [], rows: [] };
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

const bq: BigqueryEnvironment = { id: 'bq', projectId: 'p', name: 'dev', engine: 'bigquery', gcpProject: 'proj', credentialId: 'c', production: false };
const my: MysqlEnvironment = { id: 'my', projectId: 'p', name: 'dev', engine: 'mysql', host: 'h', port: 3306, credentialId: 'c', production: false };

let session: DryRunSession;
let on: boolean;
let lines: PersonTrailLine[];
let manager: SessionManager;

beforeEach(async () => {
  setLocale('pt-BR');
  session = new DryRunSession();
  on = true;
  lines = [];
  const driver: Driver = { engine: 'bigquery', open: async () => session, introspect: async () => ({ databases: [] }), test: async () => ({ serverVersion: 'x' }) };
  manager = new SessionManager({
    getEnvironment: (id) => (id === 'my' ? my : bq),
    resolveConnectParams: async () => ({ engine: 'bigquery', project: 'proj', accessToken: 't', origin: 'person' }),
    getDriver: () => driver,
    getDialect,
    estimateEnabled: () => on,
    emit: () => {},
    now: () => 1000,
    trail: { append: (l) => void lines.push(l) },
  });
  await manager.open('t', 'bq');
});

describe('SessionManager.estimate', () => {
  it('answers with the estimated bytes and runs nothing', async () => {
    expect(await manager.estimate('t', 'SELECT * FROM vendas.pedidos')).toEqual({ state: 'ok', bytes: 4096 });
    expect(session.asked).toEqual(['SELECT * FROM vendas.pedidos']);
    expect(session.executed).toEqual([]);
  });

  it('leaves no line on the trail and does not touch the tab state', async () => {
    const before = manager.state('t');
    await manager.estimate('t', 'SELECT 1');
    await manager.estimate('t', 'SELECT nope FROM');
    expect(lines).toEqual([]);
    expect(manager.state('t')).toEqual(before);
  });

  it('with the switch off nothing is asked, whatever the renderer sends', async () => {
    on = false;
    expect(await manager.estimate('t', 'SELECT 1')).toEqual({ state: 'skipped', reason: 'off' });
    expect(session.asked).toEqual([]);
  });

  it('with no switch wired at all (a manager that never heard of it) nothing is asked either', async () => {
    const bare = new SessionManager({
      getEnvironment: () => bq,
      resolveConnectParams: async () => ({ engine: 'bigquery', project: 'proj', accessToken: 't', origin: 'person' }),
      getDriver: () => ({ engine: 'bigquery', open: async () => session, introspect: async () => ({ databases: [] }), test: async () => ({ serverVersion: 'x' }) }),
      getDialect,
      emit: () => {},
      now: () => 1000,
    });
    await bare.open('t', 'bq');
    expect(await bare.estimate('t', 'SELECT 1')).toEqual({ state: 'skipped', reason: 'off' });
    expect(session.asked).toEqual([]);
  });

  it('refuses a statement the classifier does not let a read-only session run, and sends nothing', async () => {
    for (const sql of ['DELETE FROM vendas.pedidos WHERE id = 1', 'INSERT INTO vendas.pedidos VALUES (1)', 'CREATE TABLE vendas.x (a INT64)', 'CALL vendas.p()']) {
      const answer = await manager.estimate('t', sql);
      expect(answer.state, sql).toBe('refused');
    }
    expect(session.asked).toEqual([]);
  });

  it('asks about exactly one statement: more, or none, is skipped', async () => {
    expect(await manager.estimate('t', 'SELECT 1; SELECT 2')).toEqual({ state: 'skipped', reason: 'no-statement' });
    expect(await manager.estimate('t', '   ')).toEqual({ state: 'skipped', reason: 'no-statement' });
    expect(await manager.estimate('t', '-- só um comentário')).toEqual({ state: 'skipped', reason: 'no-statement' });
    expect(session.asked).toEqual([]);
    // a trailing semicolon is still one statement; what is sent is the statement without it
    expect((await manager.estimate('t', 'SELECT 1;')).state).toBe('ok');
    expect(session.asked).toEqual(['SELECT 1']);
  });

  it('the server reading another type than SELECT is a refusal, not an estimate', async () => {
    session.answer = () => ({ serverKind: 'INSERT', bytesEstimated: 10 });
    const answer = await manager.estimate('t', 'SELECT 1');
    expect(answer).toMatchObject({ state: 'refused' });
    expect(answer.state === 'refused' && answer.message).toContain('INSERT');
    session.answer = () => ({ bytesEstimated: 10 });
    expect((await manager.estimate('t', 'SELECT 2')).state).toBe('refused');
  });

  it('a fault in the text comes back as an error that belongs in the editor, with the server words in the detail', async () => {
    session.answer = () => ({
      error: { message: 'Consulta inválida: Syntax error at [1:8]', detail: 'Syntax error: Unexpected keyword FROM at [1:8]', code: 'invalidQuery', serverText: true, ref: { key: 'x' } as never },
      errorInStatement: true,
    });
    expect(await manager.estimate('t', 'SELECT FROM x')).toEqual({
      state: 'error',
      error: { message: 'Consulta inválida: Syntax error at [1:8]', detail: 'Syntax error: Unexpected keyword FROM at [1:8]', code: 'invalidQuery', inStatement: true },
    });
  });

  it('a failure to reach the server is an error that is not about the text', async () => {
    session.answer = () => ({ error: { message: 'Sem resposta', code: 'NETWORK' } });
    expect(await manager.estimate('t', 'SELECT 1')).toEqual({ state: 'error', error: { message: 'Sem resposta', code: 'NETWORK', inStatement: false } });
  });

  it('a newer request for the same tab ends the one in flight, which is skipped as cancelled', async () => {
    let release!: () => void;
    session.hold = { promise: new Promise<void>((resolve) => (release = resolve)), resolve: () => release() };
    const first = manager.estimate('t', 'SELECT 1');
    await Promise.resolve();
    await Promise.resolve();
    const second = await manager.estimate('t', 'SELECT 2');
    expect(second).toEqual({ state: 'ok', bytes: 4096 });
    expect(await first).toEqual({ state: 'skipped', reason: 'cancelled' });
    expect(session.signals[0]!.aborted).toBe(true);
    expect(session.signals[1]!.aborted).toBe(false);
    release();
  });

  it('a tab that is not connected, or does not exist, is skipped', async () => {
    await manager.disconnect('t');
    expect(await manager.estimate('t', 'SELECT 1')).toEqual({ state: 'skipped', reason: 'not-connected' });
    expect(await manager.estimate('nobody', 'SELECT 1')).toEqual({ state: 'skipped', reason: 'not-connected' });
    expect(session.asked).toEqual([]);
  });

  it('an engine with no dry run is skipped, with the switch on', async () => {
    const driver: Driver = { engine: 'mysql', open: async () => session, introspect: async () => ({ databases: [] }), test: async () => ({ serverVersion: 'x' }) };
    const mysql = new SessionManager({
      getEnvironment: () => my,
      resolveConnectParams: async () => ({ host: 'h', port: 3306, user: 'u', tls: 'off' }),
      getDriver: () => driver,
      getDialect,
      estimateEnabled: () => true,
      emit: () => {},
      now: () => 1000,
    });
    await mysql.open('m', 'my');
    expect(capabilitiesOf('mysql').dryRun).toBe(false);
    expect(await mysql.estimate('m', 'SELECT 1')).toEqual({ state: 'skipped', reason: 'unsupported' });
    expect(session.asked).toEqual([]);
  });
});
