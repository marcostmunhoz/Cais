import type { Engine, Environment } from '@shared/model';
import type { SchemaTree, StatementResult } from '@shared/results';
import {
  MAX_READ_SESSIONS,
  READ_HARD_CUT_MS,
  READ_MAX_EXECUTION_MS,
  READ_REQUEST_MAX_MS,
  READ_SESSION_IDLE_MS,
  SCHEMA_CACHE_MS,
  WRITE_LOCK_WAIT_S,
  WRITE_RUN_MAX_MS,
} from '@shared/agents';
import { CaisError } from '../errors';
import type { ConnectParams, DbSession, Driver, MysqlConnectParams } from '../drivers/types';
import { DriverError, withDatabase } from '../drivers/types';
import { capabilitiesOf } from '@shared/engines';
import { AGENT_LOCALE, getLocale, m, ref, renderRef, type MessageRef } from '@shared/i18n';
import { AgentError, agentText, bothWays } from './errors';
import { realScheduler, type Scheduler } from '../scheduler';
import { redactForAgent } from './redact';
import type { PrepareResult } from '../drivers/types';

export interface PlannedStatement {
  text: string;
  /** From the dialect's classification, so results carry the verb and kind the person saw. */
  verb?: string;
  kind?: StatementResult['kind'];
  /** USE: the session's current database may have changed. */
  changesDatabase?: boolean;
  /**
   * Engines that bill by bytes read: the most this statement's job may bill. A read whose estimate has grown past it
   * by the time it runs does not run (`bytes_over_approved`). Absent: no ceiling (MySQL).
   */
  maxBytesBilled?: number;
  /** The request was decided without a routine in sight: the driver refuses a run whose own dry run finds one. */
  refuseRoutines?: boolean;
}

/** What a dry run said about one statement of a request, before anything is decided. */
export interface PreparedStatement {
  /** The kind of statement as the server reads it ("SELECT"). */
  serverKind?: string;
  bytesEstimated?: number;
  /** Routines the statement reaches, as "datasetId.routineId" (no project). */
  routines?: string[];
  /** The dry run could not be done (connection, bad dataset, invalid text): the run itself reports the error. */
  failed?: boolean;
}

export interface RunArgs {
  database?: string;
  statements: PlannedStatement[];
  maxRows: number;
}

export interface RunOutcome {
  results: StatementResult[];
  /** Safe-to-show failure that stopped the run (already redacted). `message`: app locale; `ref`: what the agent reads. */
  error?: { message: string; code?: string; ref?: MessageRef };
}

/** A write that ran inside a transaction. `open` means the server still holds it, waiting for the person. */
export interface WriteRun extends RunOutcome {
  open: boolean;
  /** The failed run's automatic Rollback could not undo non-transactional tables. */
  rollbackIncomplete?: boolean;
  commit(): Promise<void>;
  rollback(): Promise<{ incomplete: boolean }>;
  /** Closes the connection; whatever is still open is rolled back by the server. */
  close(): Promise<void>;
}

/** What the broker needs from the agents' own connections (a fake in unit tests). */
export interface AgentExecutor {
  /** `fresh`: metadata read now, never from the 60 s cache (what a write decision relies on). */
  schema(environment: Environment, opts?: { fresh?: boolean; database?: string }): Promise<SchemaTree>;
  /**
   * A dry run of every statement of a read (type and estimated bytes), on the agents' own read connection. Undefined
   * when the engine has no dry run (MySQL): nothing is opened for it. Never throws for a failed dry run.
   */
  prepare?(environment: Environment, args: { database?: string; statements: PlannedStatement[] }): Promise<PreparedStatement[] | undefined>;
  runRead(environment: Environment, args: RunArgs): Promise<RunOutcome>;
  runWrite(environment: Environment, args: RunArgs): Promise<WriteRun>;
  environmentChanged(environmentId: string): Promise<void>;
  closeAll(): Promise<void>;
}

export { realScheduler, type Scheduler } from '../scheduler';

export interface AgentSessionsDeps {
  getDriver(engine: Engine): Driver;
  resolveConnectParams(environment: Environment): Promise<ConnectParams>;
  scheduler?: Scheduler;
  now?: () => number;
  readIdleMs?: number;
}

interface ReadEntry {
  session: DbSession;
  database: string | undefined;
  timer?: unknown;
  closed: boolean;
  busy: boolean;
}

interface Pool {
  entries: ReadEntry[];
  waiters: (() => void)[];
  opening: number;
  /** Bumped when the pool is closed (access off, quit, environment changed): work that started before stops. */
  epoch: number;
}

const ACCESS_CLOSED = (): AgentError => new AgentError(ref('agentsUi.error.accessClosed'), 'agent_access_off');

/** The agent's time limit ran out: for the run and for the statement it cut. */
const timeoutError = (): { message: string; code: string; ref: MessageRef } => ({ ...bothWays(ref('agentsUi.error.timeout')), code: 'agent_timeout' });
/** Trees kept per agent session manager (one per environment, plus one per dataset asked for). */
const SCHEMA_CACHE_MAX_ENTRIES = 64;
/** A dry run that does not answer in this time is given up and its connection dropped. */
const PREPARE_MAX_MS = 15_000;
const WRITE_VERBS = new Set(['INSERT', 'REPLACE', 'UPDATE', 'DELETE']);

function label(result: StatementResult, statement: PlannedStatement, index: number): StatementResult {
  return { ...result, index, sql: statement.text, ...(statement.kind ? { kind: statement.kind } : {}), ...(statement.verb ? { verb: statement.verb } : {}) };
}

/** Why a connection could not be opened, without host, login or token. */
function connectionFailure(error: unknown, environment: Environment): AgentError {
  if (error instanceof AgentError) return error;
  if (error instanceof DriverError) {
    const code = error.info.code && /^[A-Za-z0-9_]+$/.test(error.info.code) ? error.info.code : undefined;
    // the person reads it in the app locale, the agent in pt-BR: each with its own redaction placeholders
    const login = error.info.errno === 1045;
    const forPerson = login ? m().agentsUi.error.loginRefused : redactForAgent(error.message, environment, getLocale());
    const forAgent = login ? renderRef(ref('agentsUi.error.loginRefused'), AGENT_LOCALE) : redactForAgent(agentText(error), environment);
    return new AgentError(
      m().agentsUi.error.connectFailedDetail({ detail: forPerson }),
      'connection_failed',
      code ? { db_code: code } : undefined,
      ref('agentsUi.error.connectFailedDetail', { detail: forAgent }),
    );
  }
  if (error instanceof CaisError) return new AgentError(ref('agentsUi.error.credentialUnavailable'), 'credential_unavailable');
  return new AgentError(ref('agentsUi.error.connectFailed'), 'connection_failed');
}

/** Statement-level error as the agent sees it: no driver detail, no address, no login. */
function safeError(result: StatementResult, environment: Environment): { message: string; code?: string; ref: MessageRef; serverText?: true } {
  const error = result.error!;
  const code = error.code && /^[A-Za-z0-9_]+$/.test(error.code) ? error.code : undefined;
  return {
    message: redactForAgent(error.message, environment, getLocale()),
    ...(code ? { code } : {}),
    ref: ref('agentsUi.verbatim', { text: redactForAgent(agentText(error), environment) }),
    ...(error.serverText ? { serverText: true as const } : {}),
  };
}

/**
 * A statement result as it is stored and may reach the agent: a failed one carries the redacted error (no login,
 * client address or host), never the driver's raw message, detail or hint.
 */
function redactedResult(result: StatementResult, environment: Environment): StatementResult {
  if (!result.error) return result;
  const { fatal, errno, sqlState } = result.error;
  return {
    ...result,
    error: {
      ...safeError(result, environment),
      ...(fatal ? { fatal } : {}),
      ...(errno !== undefined ? { errno } : {}),
      ...(sqlState ? { sqlState } : {}),
    },
  };
}

/**
 * The agents' own connections. They never share a connection with the person's tabs.
 * Reads: up to 3 read-only sessions per environment (so one stuck query does not block the rest), each dropped
 * after 5 idle minutes, with a 30 s server limit and a 60 s hard cut. Writes: a new session in Transaction mode
 * for every approved request, with a 10 s lock wait.
 */
export class AgentSessions implements AgentExecutor {
  private readonly pools = new Map<string, Pool>();
  private readonly writes = new Set<{ environmentId: string; session: DbSession }>();
  /** Bumped by closeAll(): reads and writes that were opening a connection at that moment give up. */
  private epoch = 0;
  private readonly schemaCache = new Map<string, { at: number; tree?: SchemaTree; promise?: Promise<SchemaTree> }>();
  private readonly scheduler: Scheduler;
  private readonly readIdleMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: AgentSessionsDeps) {
    this.scheduler = deps.scheduler ?? realScheduler;
    this.readIdleMs = deps.readIdleMs ?? READ_SESSION_IDLE_MS;
    this.now = deps.now ?? Date.now;
  }

  private async params(environment: Environment, database?: string): Promise<ConnectParams> {
    try {
      const params = await this.deps.resolveConnectParams(environment);
      // BigQuery asks for its own new token (the params carry the function); MySQL re-resolves everything
      if (params.engine === 'bigquery') return withDatabase(params, database);
      // KILL QUERY opens its own connection later: it must not reuse a token that may have expired
      const refresh = (): Promise<MysqlConnectParams> =>
        this.deps.resolveConnectParams(environment).then((fresh) => {
          if (fresh.engine === 'bigquery') throw new Error('engine changed');
          return fresh;
        });
      return { ...(withDatabase(params, database) as MysqlConnectParams), refresh };
    } catch (error) {
      throw connectionFailure(error, environment);
    }
  }

  /** Metadata: one short connection, cached for 60 s per environment, one query at a time. */
  async schema(environment: Environment, opts: { fresh?: boolean; database?: string } = {}): Promise<SchemaTree> {
    const driver = this.deps.getDriver(environment.engine);
    // an engine that reads columns on demand caches one tree per dataset asked for; the others read everything at once
    let scope = driver.lazyColumns && opts.database ? { database: opts.database } : undefined;
    if (scope) {
      // a name that is not a dataset must not open a read (nor a cache entry) of its own: the names come from an agent
      const all = await this.schema(environment, { ...(opts.fresh ? { fresh: true } : {}) });
      const known = all.databases.find((d) => d.name.toLowerCase() === scope!.database.toLowerCase());
      if (!known) return all;
      scope = { database: known.name };
    }
    const cacheKey = scope ? `${environment.id}\u0000${scope.database.toLowerCase()}` : environment.id;
    const cached = this.schemaCache.get(cacheKey);
    // a fresh read never reuses a tree, nor a read that started before this request
    if (!opts.fresh) {
      if (cached?.promise) return cached.promise;
      if (cached?.tree && this.now() - cached.at < SCHEMA_CACHE_MS) return cached.tree;
    }
    const promise = (async (): Promise<SchemaTree> => {
      const params = await this.params(environment);
      try {
        return await driver.introspect(params, scope);
      } catch (error) {
        throw connectionFailure(error, environment);
      }
    })();
    this.prune();
    this.schemaCache.set(cacheKey, { at: this.now(), promise });
    try {
      const tree = await promise;
      this.schemaCache.set(cacheKey, { at: this.now(), tree });
      return tree;
    } catch (error) {
      this.schemaCache.delete(cacheKey);
      throw error;
    }
  }

  /** Drops the trees past their time, and the oldest ones beyond the cap: the cache never grows with what an agent asks. */
  private prune(): void {
    for (const [key, entry] of this.schemaCache) {
      if (!entry.promise && this.now() - entry.at >= SCHEMA_CACHE_MS) this.schemaCache.delete(key);
    }
    while (this.schemaCache.size >= SCHEMA_CACHE_MAX_ENTRIES) {
      const oldest = this.schemaCache.keys().next().value;
      if (oldest === undefined) break;
      this.schemaCache.delete(oldest);
    }
  }

  private pool(environmentId: string): Pool {
    let pool = this.pools.get(environmentId);
    if (!pool) {
      pool = { entries: [], waiters: [], opening: 0, epoch: this.epoch };
      this.pools.set(environmentId, pool);
    }
    return pool;
  }

  private armIdle(environmentId: string, entry: ReadEntry): void {
    if (entry.timer !== undefined) this.scheduler.clear(entry.timer);
    entry.timer = this.scheduler.set(() => {
      if (!entry.busy) void this.dropRead(environmentId, entry);
    }, this.readIdleMs);
  }

  private async dropRead(environmentId: string, entry: ReadEntry): Promise<void> {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.timer !== undefined) this.scheduler.clear(entry.timer);
    const pool = this.pools.get(environmentId);
    if (pool) {
      pool.entries = pool.entries.filter((e) => e !== entry);
      pool.waiters.shift()?.(); // capacity was freed
    }
    await entry.session.close().catch(() => undefined);
  }

  private async openRead(environment: Environment): Promise<ReadEntry> {
    const params = await this.params(environment);
    let opened: DbSession | undefined;
    let database: string | undefined;
    try {
      opened = await this.deps.getDriver(environment.engine).open(params);
      await opened.applyMode('read-only', { strict: true });
      await opened.applyLimits?.({ maxExecutionMs: READ_MAX_EXECUTION_MS });
      // where the server put the connection, not where the catalog says it should be: a request for another
      // database must always switch (USE) before running
      database = (await opened.currentDatabase()) ?? undefined;
    } catch (error) {
      await opened?.close().catch(() => undefined);
      throw connectionFailure(error, environment);
    }
    const session = opened;
    const entry: ReadEntry = { session, database, closed: false, busy: false };
    session.onFatalError(() => void this.dropRead(environment.id, entry));
    return entry;
  }

  /** An idle connection already in `target` first; with no target, only a connection that never left the default. */
  private async acquire(environment: Environment, target: string | undefined): Promise<ReadEntry> {
    const pool = this.pool(environment.id);
    const epoch = pool.epoch;
    for (;;) {
      if (pool.epoch !== epoch || this.pools.get(environment.id) !== pool) throw ACCESS_CLOSED();
      const idle = pool.entries.filter((e) => !e.closed && !e.busy);
      let pick = idle.find((e) => e.database === target);
      if (!pick && target !== undefined) pick = idle[0];
      if (!pick && target === undefined) {
        // nothing to switch back to: connections left in another database are replaced, never reused
        for (const stale of idle) await this.dropRead(environment.id, stale);
      }
      if (pick) {
        pick.busy = true;
        if (pick.timer !== undefined) this.scheduler.clear(pick.timer);
        return pick;
      }
      if (pool.entries.length + pool.opening < MAX_READ_SESSIONS) {
        pool.opening++;
        try {
          const entry = await this.openRead(environment);
          if (pool.epoch !== epoch || this.pools.get(environment.id) !== pool) {
            // closed while this connection was opening: it must not run anything
            entry.closed = true;
            if (entry.session.destroy) entry.session.destroy();
            else await entry.session.close().catch(() => undefined);
            throw ACCESS_CLOSED();
          }
          entry.busy = true;
          pool.entries.push(entry);
          return entry;
        } finally {
          pool.opening--;
          pool.waiters.shift()?.();
        }
      }
      await new Promise<void>((resolve) => pool.waiters.push(resolve));
    }
  }

  private release(environmentId: string, entry: ReadEntry): void {
    entry.busy = false;
    if (entry.closed) return;
    this.armIdle(environmentId, entry);
    this.pool(environmentId).waiters.shift()?.();
  }

  /**
   * One statement with a client-side cut (it covers what max_execution_time does not: SET @x = (SELECT …),
   * SHOW … WHERE, DML): the query is killed and the connection is not reused.
   */
  private async executeWithCut(
    session: DbSession,
    text: string,
    maxRows: number,
    cutMs: number,
    ceiling?: number,
    refuseRoutines?: boolean,
  ): Promise<{ result: StatementResult; cut: boolean }> {
    let cut = false;
    let fallback: unknown;
    const timer = this.scheduler.set(() => {
      cut = true;
      session.cancel().catch(() => undefined);
      // if the KILL cannot reach the server, drop the connection itself
      fallback = this.scheduler.set(() => {
        if (session.destroy) session.destroy();
        else void session.close().catch(() => undefined);
      }, 5000);
    }, Math.max(1, cutMs));
    try {
      const result = await session.execute(text, { maxRows, ...(ceiling !== undefined ? { maxBytesBilled: ceiling, estimateCeiling: ceiling } : {}), ...(refuseRoutines ? { refuseRoutines: true } : {}) });
      return { result, cut };
    } finally {
      this.scheduler.clear(timer);
      if (fallback !== undefined) this.scheduler.clear(fallback);
    }
  }

  /** One dry run, given up after PREPARE_MAX_MS (the connection is then not trusted any more). */
  private async prepareOne(session: DbSession, text: string): Promise<PrepareResult | 'timeout'> {
    return new Promise<PrepareResult | 'timeout'>((resolve) => {
      const timer = this.scheduler.set(() => resolve('timeout'), PREPARE_MAX_MS);
      session.prepare!(text).then(
        (r) => {
          this.scheduler.clear(timer);
          resolve(r);
        },
        (error: unknown) => {
          this.scheduler.clear(timer);
          resolve({ error: { message: error instanceof Error ? error.message : String(error) } });
        },
      );
    });
  }

  async prepare(environment: Environment, args: { database?: string; statements: PlannedStatement[] }): Promise<PreparedStatement[] | undefined> {
    if (!capabilitiesOf(environment.engine).dryRun) return undefined;
    const failedAll = (): PreparedStatement[] => args.statements.map(() => ({ failed: true }));
    const target = args.database ?? environment.defaultDatabase;
    let entry: ReadEntry;
    try {
      entry = await this.acquire(environment, target);
    } catch (error) {
      // access went off: the request is over. Any other failure shows when the run itself tries to connect.
      if (error instanceof AgentError && error.code === 'agent_access_off') throw error;
      return failedAll();
    }
    if (!entry.session.prepare) {
      this.release(environment.id, entry);
      return undefined;
    }
    let recycle = false;
    try {
      if (target !== entry.database) {
        const use = await entry.session.useDatabase(target!);
        if (use.error) {
          recycle = true;
          return failedAll();
        }
        entry.database = target;
      }
      const out: PreparedStatement[] = [];
      for (const statement of args.statements) {
        const one = await this.prepareOne(entry.session, statement.text);
        if (one === 'timeout') {
          recycle = true;
          out.push({ failed: true });
        } else if (one.error) {
          out.push({ failed: true });
        } else {
          out.push({
            ...(one.serverKind ? { serverKind: one.serverKind } : {}),
            ...(one.bytesEstimated !== undefined ? { bytesEstimated: one.bytesEstimated } : {}),
            ...(one.routines && one.routines.length > 0 ? { routines: one.routines } : {}),
          });
        }
      }
      return out;
    } finally {
      if (recycle) await this.dropRead(environment.id, entry);
      this.release(environment.id, entry);
    }
  }

  async runRead(environment: Environment, args: RunArgs): Promise<RunOutcome> {
    const target = args.database ?? environment.defaultDatabase;
    const entry = await this.acquire(environment, target);
    const results: StatementResult[] = [];
    let recycle = false;
    // one budget for the whole request, and never more than the hard cut per statement
    const deadline = this.now() + READ_REQUEST_MAX_MS;
    try {
      if (target !== entry.database) {
        // target is defined here: acquire() never hands out a connection in the wrong database when there is none
        const use = await entry.session.useDatabase(target!);
        if (use.error) {
          recycle = true;
          return { results, error: safeError(use, environment) };
        }
        entry.database = target;
      }
      for (const [index, statement] of args.statements.entries()) {
        const remaining = deadline - this.now();
        if (remaining <= 0) {
          recycle = true;
          return { results, error: timeoutError() };
        }
        // the estimate may have grown since the person (or the policy) saw it: the ceiling is what was approved
        const ceiling = statement.maxBytesBilled;
        const refuseRoutines = statement.refuseRoutines === true;
        const { result: raw, cut } = await this.executeWithCut(entry.session, statement.text, args.maxRows, Math.min(READ_HARD_CUT_MS, remaining), ceiling, refuseRoutines);
        const result = label(raw, statement, index);
        if (cut) {
          recycle = true;
          results.push({ ...result, error: timeoutError() });
          return { results, error: timeoutError() };
        }
        results.push(redactedResult(result, environment));
        if (statement.changesDatabase) recycle = true;
        if (result.error) {
          if (result.error.fatal) recycle = true;
          return { results, error: safeError(result, environment) };
        }
      }
      return { results };
    } finally {
      if (!recycle && entry.session.reset) {
        // nothing a request leaves in the session (user variables, named locks, character set) reaches the next one
        try {
          await entry.session.reset();
        } catch {
          recycle = true;
        }
      }
      if (recycle) await this.dropRead(environment.id, entry);
      this.release(environment.id, entry);
    }
  }

  async runWrite(environment: Environment, args: RunArgs): Promise<WriteRun> {
    // the broker refuses first; this is the last door: an engine that has no transaction mode never opens a write
    if (!capabilitiesOf(environment.engine).modes.includes('transaction')) {
      throw new AgentError('Este motor só lê nesta versão: escrita de agente não é aceita.', 'engine_read_only');
    }
    const epoch = this.epoch;
    const params = await this.params(environment, args.database);
    let opened: DbSession | undefined;
    try {
      opened = await this.deps.getDriver(environment.engine).open(params);
      await opened.applyMode('transaction', { strict: true });
      await opened.applyLimits?.({ lockWaitSeconds: WRITE_LOCK_WAIT_S, maxExecutionMs: READ_MAX_EXECUTION_MS });
    } catch (error) {
      await opened?.close().catch(() => undefined);
      throw connectionFailure(error, environment);
    }
    const session = opened;
    if (this.epoch !== epoch) {
      // access went off (or the app is quitting) while this connection was opening
      if (session.destroy) session.destroy();
      else await session.close().catch(() => undefined);
      throw ACCESS_CLOSED();
    }
    const tracked = { environmentId: environment.id, session };
    this.writes.add(tracked);
    const closeSession = async (): Promise<void> => {
      this.writes.delete(tracked);
      await session.close().catch(() => undefined);
    };
    const results: StatementResult[] = [];
    const noop = { commit: async () => undefined, rollback: async () => ({ incomplete: false }), close: async () => undefined };
    const finish = async (error?: RunOutcome['error'], forceIncomplete = false): Promise<WriteRun> => {
      await session.rollback().catch(() => undefined);
      const rollbackIncomplete = forceIncomplete || session.lastRollbackIncomplete === true;
      await closeSession();
      return { results, ...(error ? { error } : {}), open: false, ...(rollbackIncomplete ? { rollbackIncomplete } : {}), ...noop };
    };
    let wasOpen = false;
    const deadline = this.now() + WRITE_RUN_MAX_MS;
    for (const [index, statement] of args.statements.entries()) {
      const remaining = deadline - this.now();
      if (remaining <= 0) return finish(timeoutError());
      const { result: raw, cut } = await this.executeWithCut(session, statement.text, args.maxRows, Math.min(READ_HARD_CUT_MS, remaining));
      const result = label(raw, statement, index);
      if (cut) {
        results.push({ ...result, error: timeoutError() });
        return finish(timeoutError());
      }
      results.push(redactedResult(result, environment));
      if (result.error) return finish(safeError(result, environment));
      if (wasOpen && result.inTransaction === false) {
        // something committed behind our back: stop, and never report this request as safe to review
        return finish({ ...bothWays(ref('agentsUi.error.unexpectedCommit')), code: 'unexpected_commit' }, true);
      }
      if (WRITE_VERBS.has((statement.verb ?? '').toUpperCase()) && result.inTransaction !== true) {
        // a write the server did not keep in a transaction: autocommit turned on by some path, or tables that
        // never join one (performance_schema). MyISAM under autocommit=0 still reports a transaction on 8.4, so
        // that case is covered by the warnings before approval and by rollback_incomplete after a Rollback.
        return finish(
          { ...bothWays(ref('agentsUi.error.nonTransactionalWrite')), code: 'non_transactional_write' },
          (result.affectedRows ?? 0) > 0,
        );
      }
      if (result.inTransaction) wasOpen = true;
    }
    if (!wasOpen) {
      await closeSession();
      return { results, open: false, ...noop };
    }
    return {
      results,
      open: true,
      commit: async () => {
        const sent = session.isAlive?.() ?? true;
        try {
          await session.commit();
        } catch (error) {
          // the connection fell after the COMMIT left: nobody knows whether the server applied it
          if (sent && error instanceof DriverError && error.info.fatal) {
            throw new AgentError(ref('agentsUi.error.commitUnknown'), 'commit_unknown');
          }
          throw error;
        } finally {
          await closeSession();
        }
      },
      rollback: async () => {
        try {
          await session.rollback();
          return { incomplete: session.lastRollbackIncomplete === true };
        } finally {
          await closeSession();
        }
      },
      close: closeSession,
    };
  }

  /** Running and open agent writes: stopped and dropped (the server rolls them back). */
  private async abortWrites(environmentId?: string): Promise<void> {
    const targets = [...this.writes].filter((w) => environmentId === undefined || w.environmentId === environmentId);
    await Promise.all(
      targets.map(async (w) => {
        this.writes.delete(w);
        await w.session.cancel().catch(() => undefined);
        if (w.session.destroy) w.session.destroy();
        else await w.session.close().catch(() => undefined);
      }),
    );
  }

  /** Closes a pool: running queries are killed, waiting requests give up, nothing new opens in it. */
  private async closePool(environmentId: string): Promise<void> {
    const pool = this.pools.get(environmentId);
    if (!pool) return;
    this.pools.delete(environmentId);
    pool.epoch++;
    for (const wake of pool.waiters.splice(0)) wake();
    await Promise.all(
      [...pool.entries].map(async (e) => {
        if (e.busy) await e.session.cancel().catch(() => undefined);
        await this.dropRead(environmentId, e);
      }),
    );
  }

  /** The environment changed or was removed: cached connections and metadata must not outlive it. */
  async environmentChanged(environmentId: string): Promise<void> {
    for (const key of [...this.schemaCache.keys()]) {
      if (key === environmentId || key.startsWith(`${environmentId}\u0000`)) this.schemaCache.delete(key);
    }
    await this.closePool(environmentId);
  }

  async closeAll(): Promise<void> {
    this.epoch++;
    this.schemaCache.clear();
    await this.abortWrites();
    await Promise.all([...this.pools.keys()].map((id) => this.closePool(id)));
  }
}
