import { randomBytes } from 'node:crypto';
import type { Environment, SessionMode } from '@shared/model';
import type { Dialect } from '@shared/dialects/types';
import type { Classification } from '@shared/dialects/types';
import { noStatementMessage, statementAtCursor } from '@shared/dialects/registry';
import type { PendingTransaction, RunRequest, RunResponse, SetModeResponse } from '@shared/ipc';
import type { SessionState, StatementError, StatementResult, StatementStats } from '@shared/results';
import { GIB, capabilitiesOf, initialModeFor, type EngineCapabilities } from '@shared/engines';
import { fmt, m } from '@shared/i18n';
import { CaisError } from './errors';
import { realScheduler, type Scheduler } from './scheduler';
import type { ConnectParams, DbSession, DbSessionError, Driver, PrepareResult } from './drivers/types';
import { DriverError } from './drivers/types';

/** One line of the person's side of the trail. The trail adds who, when and the environment's name. */
export interface PersonTrailLine {
  /** Shared by the line written before a statement that may change something and the one written after it. */
  id?: string;
  environment: Environment;
  event: 'statement' | 'commit' | 'rollback' | 'mode' | 'connection_lost';
  mode: SessionMode;
  database?: string | null;
  sql: string;
  state: string;
  verb?: string;
  kind?: string;
  durationMs?: number;
  rows?: number;
  affectedRows?: number;
  errorCode?: string;
  errno?: number;
  inTransaction?: boolean;
  detail?: string;
  /** BigQuery: the job and what it cost. Never result data. */
  jobId?: string;
  bytesEstimated?: number;
  bytesBilled?: number;
}

/** Bytes rounded up to a whole GiB: what a confirmed estimate is allowed to bill. */
const ceilGib = (bytes: number): number => Math.ceil(bytes / GIB) * GIB;

/** The mode's name for trail details, in the app locale of the moment the line is written. */
function modeLabel(mode: SessionMode): string {
  const t = m().mainSessions.mode;
  return mode === 'read-only' ? t.readOnly : mode === 'transaction' ? t.transaction : t.autocommit;
}

export interface SessionDeps {
  getEnvironment(id: string): Environment | undefined;
  resolveConnectParams(environment: Environment): Promise<ConnectParams>;
  getDriver(engine: Environment['engine']): Driver;
  getDialect(engine: Environment['engine']): Dialect;
  /** What the engine accepts (modes, grid edit). The registry in `@shared/engines` when absent; tests inject restricted engines. */
  capabilitiesOf?(engine: Environment['engine']): EngineCapabilities;
  emit(state: SessionState): void;
  now(): number;
  /** The trail. Never throws into a run; absent in tests that do not look at it. */
  trail?: { append(line: PersonTrailLine): void };
  /** Timers for the idle disconnect. Real timers when absent. */
  scheduler?: Scheduler;
  /** How long a tab may stay without activity before it disconnects. Fixed in the product; only tests change it. */
  idleMs?: number;
}

/** A tab with no activity for 30 minutes disconnects (never with a transaction open or a statement running). */
export const IDLE_MS = 30 * 60 * 1000;

interface Entry {
  state: SessionState;
  environment: Environment;
  session?: DbSession;
  /** The environment was edited while a transaction was open: reconnect once it ends. */
  stale?: boolean;
  /** Cancelar was pressed during this run: no further statement starts. */
  cancelRequested?: boolean;
  /** The idle-disconnect timer, re-armed on every activity. */
  idleTimer?: unknown;
}

const lostWithTransaction = (statements: number): string => m().mainSessions.lostWithTransaction({ count: statements });

function idleTransaction(): SessionState['transaction'] {
  return { open: false, statements: 0 };
}

/** A statement the server counts as part of a transaction (it holds locks, even a plain SELECT). */
function opensTransaction(c: Classification): boolean {
  if (c.implicitCommit) return false;
  return c.kind === 'read' || c.kind === 'write' || c.kind === 'other';
}

/**
 * Engine-agnostic session policies: one tab = one session = one connection.
 * Everything here runs in the main process; the renderer is never trusted.
 */
export class SessionManager {
  private readonly entries = new Map<string, Entry>();
  private readonly scheduler: Scheduler;
  private readonly idleMs: number;

  constructor(private readonly deps: SessionDeps) {
    this.scheduler = deps.scheduler ?? realScheduler;
    this.idleMs = deps.idleMs ?? IDLE_MS;
  }

  /** Read-only in production; elsewhere Auto-commit when the engine takes it, else the engine's first mode. */
  static initialMode(environment: Pick<Environment, 'production' | 'engine'>, caps: EngineCapabilities = capabilitiesOf(environment.engine)): SessionMode {
    return initialModeFor(caps, environment.production);
  }

  private initialModeOf(environment: Environment): SessionMode {
    return SessionManager.initialMode(environment, this.capabilities(environment.engine));
  }

  private capabilities(engine: Environment['engine']): EngineCapabilities {
    return (this.deps.capabilitiesOf ?? capabilitiesOf)(engine);
  }

  private assertModeSupported(engine: Environment['engine'], mode: SessionMode): void {
    if (!this.capabilities(engine).modes.includes(mode)) {
      throw new CaisError(m().mainSessions.modeNotSupported({ mode: modeLabel(mode), engine: this.deps.getDialect(engine).displayName }), 'mode-not-supported');
    }
  }

  private record(entry: Entry, line: Omit<PersonTrailLine, 'environment' | 'mode'> & { mode?: SessionMode }): void {
    try {
      this.deps.trail?.append({ environment: entry.environment, mode: entry.state.mode, ...line });
    } catch {
      // the trail never takes a run down
    }
  }

  private recordResult(entry: Entry, result: StatementResult, database: string | null, extra: { id?: string; detail?: string } = {}): void {
    const cancelled = result.error?.code === 'CANCELLED';
    this.record(entry, {
      ...(extra.id ? { id: extra.id } : {}),
      event: 'statement',
      database,
      sql: result.sql,
      state: result.error ? (cancelled ? 'cancelled' : result.error.code === 'REFUSED' ? 'refused' : 'error') : 'ok',
      verb: result.verb,
      kind: result.kind,
      durationMs: result.durationMs,
      ...(result.columns ? { rows: result.rows?.length ?? 0 } : {}),
      ...(!result.columns && result.affectedRows !== undefined ? { affectedRows: result.affectedRows } : {}),
      ...(result.error?.code ? { errorCode: result.error.code } : {}),
      ...(result.error?.errno !== undefined ? { errno: result.error.errno } : {}),
      ...(result.inTransaction !== undefined ? { inTransaction: result.inTransaction } : {}),
      ...(result.stats?.jobId ? { jobId: result.stats.jobId } : {}),
      // a re-read of a job that already ran points at the job, with no bytes: it was billed once
      ...(result.stats?.bytesEstimated !== undefined && !result.stats.reread ? { bytesEstimated: result.stats.bytesEstimated } : {}),
      ...(result.stats?.bytesBilled !== undefined && !result.stats.reread ? { bytesBilled: result.stats.bytesBilled } : {}),
      ...(result.error?.code === 'REFUSED'
        ? { detail: result.error.message }
        : result.notice || extra.detail
          ? { detail: [extra.detail, result.notice].filter(Boolean).join(' · ') }
          : {}),
    });
  }

  private publish(entry: Entry): SessionState {
    const copy = structuredClone(entry.state);
    this.deps.emit(copy);
    return copy;
  }

  private clearIdle(entry: Entry): void {
    if (entry.idleTimer !== undefined) this.scheduler.clear(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  /** Activity on the tab (connect, run, commit, rollback, mode, database): the idle clock starts over. */
  private touch(entry: Entry): void {
    this.clearIdle(entry);
    if (!entry.session) return;
    entry.idleTimer = this.scheduler.set(() => this.idleElapsed(entry), this.idleMs);
  }

  private idleElapsed(entry: Entry): void {
    entry.idleTimer = undefined;
    if (this.entries.get(entry.state.tabId) !== entry || !entry.session) return;
    // never a silent rollback, never under a running statement: look again later
    if (entry.state.status !== 'idle' || entry.state.transaction.open) {
      this.touch(entry);
      return;
    }
    void this.recycle(entry, 'idle');
  }

  private require(tabId: string): Entry {
    const entry = this.entries.get(tabId);
    if (!entry) throw new CaisError(m().mainSessions.noSession);
    return entry;
  }

  private requireConnected(tabId: string): Entry & { session: DbSession } {
    const entry = this.require(tabId);
    if (!entry.session || entry.state.status === 'disconnected' || entry.state.status === 'error') {
      throw new CaisError(m().mainSessions.notConnected, 'not-connected');
    }
    if (entry.state.status === 'connecting') throw new CaisError(m().mainSessions.connecting);
    return entry as Entry & { session: DbSession };
  }

  state(tabId: string): SessionState {
    const entry = this.entries.get(tabId);
    if (!entry) {
      return {
        tabId,
        environmentId: '',
        status: 'disconnected',
        mode: 'autocommit',
        database: null,
        transaction: idleTransaction(),
      };
    }
    return structuredClone(entry.state);
  }

  pendingTransactions(): PendingTransaction[] {
    return [...this.entries.values()]
      .filter((e) => e.state.transaction.open)
      .map((e) => ({ tabId: e.state.tabId, statements: e.state.transaction.statements }));
  }

  async open(
    tabId: string,
    environmentId: string,
    opts: { mode?: SessionMode; confirmed?: boolean } = {},
  ): Promise<SessionState> {
    const environment = this.deps.getEnvironment(environmentId);
    if (!environment) throw new CaisError(m().mainSessions.environmentNotFound);

    const existing = this.entries.get(tabId);
    let previousMode: SessionMode | undefined;
    let notice: string | undefined;
    let oldSession: DbSession | undefined;
    if (existing) {
      if (existing.state.status === 'connecting') throw new CaisError(m().mainSessions.connecting);
      if (existing.state.status === 'running') throw new CaisError(m().mainSessions.runningInTab);
      if (existing.session && existing.state.status === 'idle' && existing.state.environmentId === environmentId) {
        this.touch(existing);
        return structuredClone(existing.state);
      }
      if (existing.state.transaction.open) {
        throw new CaisError(m().mainSessions.switchEnvironmentTransaction, 'transaction-open');
      }
      if (existing.state.environmentId === environmentId) {
        previousMode = existing.state.mode;
        // an Auto-commit chosen before the environment became production was never confirmed for production
        if (previousMode === 'autocommit' && environment.production && !existing.environment.production) {
          previousMode = undefined;
          if (!opts.mode) notice = m().mainSessions.nowProduction;
        }
      }
      this.clearIdle(existing);
      // closed only after the new entry is registered: a close(tab) or environmentChanged during that wait
      // must find the connecting entry (and its guards), not the old one
      oldSession = existing.session;
      existing.session = undefined;
    }

    // The mode belongs to the tab: it survives reconnects. A newly requested production
    // autocommit needs the confirmation; one the tab already had does not.
    const mode = opts.mode ?? previousMode ?? this.initialModeOf(environment);
    this.assertModeSupported(environment.engine, mode);
    if (mode === 'autocommit' && environment.production && mode !== previousMode && !opts.confirmed) {
      throw new CaisError(m().mainSessions.autocommitNeedsConfirmation, 'confirmation-required');
    }
    const entry: Entry = {
      environment,
      state: {
        tabId,
        environmentId,
        status: 'connecting',
        mode,
        database: null,
        transaction: idleTransaction(),
        ...(notice ? { notice } : {}),
      },
    };
    this.entries.set(tabId, entry);
    this.publish(entry);
    await oldSession?.close().catch(() => undefined);

    let session: DbSession | undefined;
    try {
      const params = await this.deps.resolveConnectParams(environment);
      session = await this.deps.getDriver(environment.engine).open(params);
      await session.applyMode(mode);
      entry.state.database = await session.currentDatabase();
    } catch (error) {
      await session?.close().catch(() => undefined);
      // the tab was closed (or the app is quitting) while connecting: nobody shows this error
      if (this.entries.get(tabId) !== entry) throw new CaisError(m().mainSessions.noSession);
      const message = error instanceof Error ? error.message : String(error);
      entry.session = undefined;
      // a failed open is a connection error with its message, not a plain "disconnected"
      entry.state.status = 'error';
      entry.state.error = message;
      this.publish(entry);
      throw error instanceof DriverError ? new CaisError(message, error.info.code) : error;
    }

    if (this.entries.get(tabId) !== entry) {
      // the tab was closed (or the app is quitting) while connecting: drop the new connection, publish nothing
      await session.close().catch(() => undefined);
      throw new CaisError(m().mainSessions.noSession);
    }
    if (entry.stale) {
      // the environment was edited while connecting: this connection used the old host, credential and
      // production flag. Drop it; the next open reads the new settings (and applies the production downgrade).
      entry.session = session;
      await this.recycle(entry);
      throw new CaisError(m().mainSessions.changedWhileConnecting, 'not-connected');
    }
    entry.session = session;
    entry.state.status = 'idle';
    entry.state.serverVersion = session.serverVersion;
    delete entry.state.error;
    if (mode === 'autocommit' && environment.production && mode !== previousMode) {
      this.record(entry, { event: 'mode', sql: '', state: 'ok', detail: m().mainSessions.trail.openedAutocommitProduction });
    } else if (mode !== (previousMode ?? this.initialModeOf(environment))) {
      this.record(entry, { event: 'mode', sql: '', state: 'ok', detail: m().mainSessions.trail.openedIn({ mode: modeLabel(mode) }) });
    }
    const current = session;
    session.onFatalError((info) => this.handleFatal(entry, current, info));
    this.touch(entry);
    return this.publish(entry);
  }

  /** The environment was edited: idle sessions are dropped (they reconnect with the new settings). */
  async environmentChanged(environmentId: string): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.state.environmentId !== environmentId) continue;
      if (entry.state.status === 'connecting') {
        // `open` holds the old settings: it drops the connection when it lands
        entry.stale = true;
        continue;
      }
      if (!entry.session) continue;
      if (entry.state.transaction.open || entry.state.status === 'running') {
        entry.stale = true;
        entry.state.notice = m().mainSessions.environmentChanged;
        this.publish(entry);
      } else {
        await this.recycle(entry);
      }
    }
  }

  /** Drops the connection but keeps the entry: the tab keeps its mode and reconnects through `open`. */
  private async recycle(entry: Entry, reason?: 'idle' | 'manual'): Promise<void> {
    const session = entry.session;
    entry.session = undefined;
    entry.stale = false;
    this.clearIdle(entry);
    delete entry.state.notice;
    delete entry.state.error;
    delete entry.state.serverVersion;
    entry.state.status = 'disconnected';
    entry.state.transaction = idleTransaction();
    if (reason) entry.state.disconnectReason = reason;
    else delete entry.state.disconnectReason;
    this.publish(entry);
    await session?.close().catch(() => undefined);
  }

  private async recycleIfStale(entry: Entry): Promise<void> {
    if (entry.stale && entry.session && !entry.state.transaction.open && entry.state.status === 'idle') {
      await this.recycle(entry);
    }
  }

  private handleFatal(entry: Entry, session: DbSession, info: DbSessionError): void {
    if (entry.session !== session) return;
    const hadTransaction = entry.state.transaction.open;
    const lostStatements = entry.state.transaction.statements;
    entry.session = undefined;
    this.clearIdle(entry);
    entry.state.status = 'error';
    entry.state.transaction = idleTransaction();
    entry.state.error = hadTransaction ? lostWithTransaction(lostStatements) : info.message;
    if (hadTransaction) {
      entry.state.notice = lostWithTransaction(lostStatements);
      this.record(entry, { event: 'connection_lost', sql: '', state: 'rolled_back', detail: lostWithTransaction(lostStatements) });
    }
    session.close().catch(() => undefined);
    this.publish(entry);
  }

  async setMode(tabId: string, mode: SessionMode, opts: { confirmed?: boolean } = {}): Promise<SetModeResponse> {
    const entry = this.requireConnected(tabId);
    if (entry.state.status === 'running') throw new CaisError(m().mainSessions.setModeRunning);
    if (mode === entry.state.mode) return { session: structuredClone(entry.state) };
    this.assertModeSupported(entry.environment.engine, mode);
    if (entry.state.transaction.open) {
      throw new CaisError(m().mainSessions.setModeTransaction, 'transaction-open');
    }
    if (mode === 'autocommit' && entry.environment.production && !opts.confirmed) {
      return { session: structuredClone(entry.state), needsConfirmation: { reason: 'production-autocommit' } };
    }
    const session = entry.session;
    try {
      await session.applyMode(mode);
    } catch (error) {
      throw toCaisError(error);
    }
    // dropped meanwhile (idle timer, Desconectar, environment edited): the mode was not applied to any live session
    if (entry.session !== session) throw new CaisError(m().mainSessions.notConnected, 'not-connected');
    const from = entry.state.mode;
    entry.state.mode = mode;
    this.record(entry, {
      event: 'mode',
      sql: '',
      state: 'ok',
      detail:
        mode === 'autocommit' && entry.environment.production
          ? m().mainSessions.trail.modeChangedProduction({ from: modeLabel(from), to: modeLabel(mode) })
          : m().mainSessions.trail.modeChanged({ from: modeLabel(from), to: modeLabel(mode) }),
    });
    this.touch(entry);
    return { session: this.publish(entry) };
  }

  /** The engine's dry run failed, or read the statement as something other than a query: the error to show, or null. */
  private prepareFailure(prep: PrepareResult): StatementError | null {
    if (prep.error) return prep.error;
    const t = m().mainSessions;
    if (!prep.serverKind) return { message: t.serverRefusedUnknown, code: 'REFUSED' };
    if (prep.serverKind !== 'SELECT') return { message: t.serverRefusedType({ type: prep.serverKind }), code: 'REFUSED' };
    return null;
  }

  /** Why the statement cannot run in the current mode, or null. */
  private refusal(mode: SessionMode, c: Classification): string | null {
    if (c.alwaysRefuse) return c.alwaysRefuse;
    if (c.transactionControl === 'begin' && mode !== 'transaction') {
      return m().mainSessions.beginNeedsTransactionMode;
    }
    if (mode === 'read-only' && !c.allowedInReadOnly) {
      return c.reason ?? m().mainSessions.readOnlyRefused;
    }
    return null;
  }

  async run(tabId: string, req: RunRequest): Promise<RunResponse> {
    const entry = this.requireConnected(tabId);
    if (entry.state.status === 'running') throw new CaisError(m().mainSessions.alreadyRunning);
    const dialect = this.deps.getDialect(entry.environment.engine);

    let statements: { text: string }[];
    if (req.selection && req.selection.to > req.selection.from) {
      statements = dialect.splitStatements(req.sql.slice(req.selection.from, req.selection.to));
    } else {
      const all = dialect.splitStatements(req.sql);
      if (req.scope === 'all') statements = all;
      else {
        const index = statementAtCursor(all, req.cursor, req.sql);
        if (index === -1) throw new CaisError(noStatementMessage(), 'no-statement');
        statements = [all[index]!];
      }
    }
    if (statements.length === 0) throw new CaisError(m().mainSessions.nothingToRun);

    const plan = statements.map((s) => ({ text: s.text, c: dialect.classify(s.text) }));
    const mode = entry.state.mode;
    if (req.refetch && (plan.length !== 1 || plan[0]!.c.kind !== 'read' || !plan[0]!.c.allowedInReadOnly)) {
      // fetching more rows runs the statement again: only for a plain read
      throw new CaisError(m().mainSessions.refetchNotRead, 'refetch-not-read');
    }
    if (req.origin === 'grid' && (req.refetch || plan.some(({ c }) => c.kind !== 'write' || (c.verb !== 'UPDATE' && c.verb !== 'DELETE')))) {
      // the label "Edição na grade" on the trail is only for the UPDATEs and DELETEs the grid generates
      throw new CaisError(m().mainSessions.gridNotEdit, 'grid-not-edit');
    }

    // 1. refuse before anything leaves the app
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i]!;
      const reason = this.refusal(mode, item.c);
      if (reason) {
        const refused: StatementResult = {
          index: i,
          sql: item.text,
          kind: item.c.kind,
          verb: item.c.verb,
          durationMs: 0,
          error: { message: reason, code: 'REFUSED' },
        };
        this.recordResult(entry, refused, entry.state.database);
        return { results: [refused], session: structuredClone(entry.state) };
      }
    }

    // 1b. the engine's own look (BigQuery dry run): second layer of read-only, and the cost of each statement
    const session = entry.session;
    const prepared: (PrepareResult | undefined)[] = [];
    const limit = entry.environment.engine === 'bigquery' ? entry.environment.maxBytesBilled : undefined;
    /** Per statement: the most bytes the job may bill, and the confirmation text for the trail. */
    const bounds: ({ maxBytesBilled: number; detail?: string } | undefined)[] = [];
    if (session.prepare && !req.refetch) {
      entry.state.status = 'running';
      entry.cancelRequested = false;
      this.publish(entry);
      try {
        for (let i = 0; i < plan.length; i++) {
          const item = plan[i]!;
          let prep: PrepareResult;
          try {
            prep = await session.prepare(item.text);
          } catch (error) {
            prep = { error: error instanceof DriverError ? error.info : { message: toCaisError(error).message } };
          }
          prepared.push(prep);
          const failure = this.prepareFailure(prep);
          if (failure || entry.cancelRequested) {
            const result: StatementResult = {
              index: i,
              sql: item.text,
              kind: item.c.kind,
              verb: item.c.verb,
              durationMs: 0,
              error: failure ?? { message: m().mainMisc.driver.cancelled, code: 'CANCELLED' },
            };
            this.recordResult(entry, result, entry.state.database);
            // the dry-run phase is over: the state the reply and the event carry is the idle one, not "running"
            entry.state.status = 'idle';
            await this.recycleIfStale(entry);
            this.touch(entry);
            return { results: [result], session: this.publish(entry) };
          }
        }
        if (entry.stale && !entry.state.transaction.open) {
          // the limit (or anything else) was edited during the dry run: nothing runs under the old settings
          entry.state.status = 'idle';
          await this.recycleIfStale(entry);
          this.publish(entry);
          throw new CaisError(m().mainSessions.changedWhilePreparing, 'not-connected');
        }
        if (limit !== undefined) {
          const over: { index: number; sql: string; bytesEstimated: number }[] = [];
          for (let i = 0; i < plan.length; i++) {
            const estimate = prepared[i]?.bytesEstimated ?? 0;
            // a confirmation counts only for the very text it was asked about
            const accepted = req.confirmedBytes?.filter((c) => c.sql === plan[i]!.text).map((c) => c.bytes) ?? [];
            const confirmed = accepted.length > 0 ? Math.max(...accepted) : undefined;
            if (estimate > limit && (confirmed === undefined || estimate > confirmed)) {
              over.push({ index: i, sql: plan[i]!.text, bytesEstimated: estimate });
            } else {
              bounds[i] = {
                maxBytesBilled: Math.max(limit, confirmed === undefined ? 0 : ceilGib(confirmed)),
                ...(estimate > limit ? { detail: m().mainSessions.trail.overLimitConfirmed({ limit: fmt().formatBytes(limit), bytes: fmt().formatBytes(estimate) }) } : {}),
              };
            }
          }
          if (over.length > 0) {
            // nothing runs: every statement over the limit is asked about together
            entry.state.status = 'idle';
            this.touch(entry);
            this.publish(entry);
            return { results: [], session: structuredClone(entry.state), needsConfirmation: { reason: 'bytes', statements: over, limit } };
          }
        }
      } finally {
        if (entry.state.status === 'running') entry.state.status = 'idle';
      }
    }

    // 2. confirmations are asked before any statement runs
    if (mode === 'transaction' && !req.confirmed) {
      let open = entry.state.transaction.open;
      const needs: string[] = [];
      for (const { text, c } of plan) {
        if (c.transactionControl === 'commit' || c.transactionControl === 'rollback') {
          open = false;
        } else if (c.transactionControl === 'begin') {
          if (open) needs.push(text);
          open = true;
        } else if (c.implicitCommit) {
          if (open) needs.push(text);
          open = false;
        } else if (opensTransaction(c)) {
          open = true;
        }
      }
      if (needs.length > 0) {
        return {
          results: [],
          session: structuredClone(entry.state),
          needsConfirmation: { reason: 'implicit-commit', statements: needs },
        };
      }
    }

    // 3. execute in sequence, stop at the first error
    entry.state.status = 'running';
    entry.cancelRequested = false;
    this.publish(entry);
    const results: StatementResult[] = [];
    try {
      for (let i = 0; i < plan.length; i++) {
        const { text, c } = plan[i]!;
        if (entry.cancelRequested) {
          // Cancelar between statements: the rest never starts
          const cancelled: StatementResult = { index: i, sql: text, kind: c.kind, verb: c.verb, durationMs: 0, error: { message: m().mainMisc.driver.cancelled, code: 'CANCELLED' } };
          results.push(cancelled);
          this.recordResult(entry, cancelled, entry.state.database);
          if (entry.state.mode === 'transaction') {
            // an engine with no probe keeps the state it had
            const open = await entry.session.transactionProbe?.().catch(() => undefined);
            if (open === false) entry.state.transaction = idleTransaction();
          }
          this.publish(entry);
          break;
        }
        const transactionWasOpen = entry.state.transaction.open;
        const statementsBefore = entry.state.transaction.statements;
        const databaseBefore = entry.state.database;
        // whatever may change something is on the trail before it leaves: a crash in the middle still shows it
        // (a "read" that is not a plain one, such as INTO OUTFILE or FOR UPDATE, counts as one that may change something)
        const lineId = c.kind === 'read' && c.allowedInReadOnly ? undefined : `p_${randomBytes(6).toString('hex')}`;
        if (lineId) {
          this.record(entry, { id: lineId, event: 'statement', database: databaseBefore, sql: text, state: 'running', verb: c.verb, kind: c.kind });
        }
        let result: StatementResult;
        try {
          result = await entry.session.execute(text, {
            maxRows: req.maxRows,
            stopAtCap: c.kind === 'read',
            ...(req.refetch ? { refetch: true } : {}),
            ...(bounds[i] ? { maxBytesBilled: bounds[i]!.maxBytesBilled } : {}),
          });
        } catch (error) {
          const info = error instanceof DriverError ? error.info : { message: toCaisError(error).message };
          result = { index: i, sql: text, kind: c.kind, verb: c.verb, durationMs: 0, error: info };
        }
        result = { ...result, index: i, sql: text, kind: c.kind, verb: c.verb };
        const estimated = prepared[i]?.bytesEstimated;
        if (estimated !== undefined && result.stats?.bytesEstimated === undefined && (result.stats || !result.error)) {
          result.stats = { ...result.stats, bytesEstimated: estimated } satisfies StatementStats;
        }
        if (result.error?.fatal && transactionWasOpen) {
          // the driver's ref (if any) described the old message: drop it with the rewrite
          const { ref: _ref, ...rest } = result.error as typeof result.error & { ref?: unknown };
          result.error = { ...rest, message: lostWithTransaction(statementsBefore) };
        }
        results.push(result);
        this.recordResult(entry, result, databaseBefore, {
          ...(lineId ? { id: lineId } : {}),
          ...(req.refetch
            ? { detail: m().mainSessions.trail.refetch({ n: 50_000 }) }
            : req.origin === 'grid'
              ? { detail: m().mainSessions.gridEdit }
              : bounds[i]?.detail
                ? { detail: bounds[i]!.detail }
                : {}),
        });
        if (!result.error?.fatal) this.applyTransactionState(entry, c, result);
        if (result.error) {
          this.publish(entry);
          break;
        }
        if (c.changesDatabase) {
          entry.state.database = await entry.session.currentDatabase().catch(() => entry.state.database);
        }
        this.publish(entry);
      }
    } finally {
      if (entry.state.status === 'running') entry.state.status = 'idle';
    }
    await this.recycleIfStale(entry);
    this.touch(entry);
    return { results, session: this.publish(entry) };
  }

  /**
   * Transaction state comes from the server (SERVER_STATUS_IN_TRANS) after every statement, whether it
   * succeeded, failed or was cancelled. Drivers that do not report it fall back to classification.
   */
  private applyTransactionState(entry: Entry, c: Classification, result: StatementResult): void {
    if (entry.state.mode !== 'transaction') return;
    if (result.inTransaction === undefined) {
      if (!result.error) this.afterSuccess(entry, c);
      return;
    }
    const tx = entry.state.transaction;
    if (!result.inTransaction) {
      entry.state.transaction = idleTransaction();
      return;
    }
    const control = c.transactionControl === 'begin' || c.transactionControl === 'commit' || c.transactionControl === 'rollback';
    entry.state.transaction = tx.open
      ? { ...tx, statements: tx.statements + (control ? 0 : 1) }
      : { open: true, statements: control ? 0 : 1, startedAt: this.deps.now() };
  }

  private afterSuccess(entry: Entry, c: Classification): void {
    if (entry.state.mode !== 'transaction') return;
    const tx = entry.state.transaction;
    if (c.transactionControl === 'commit' || c.transactionControl === 'rollback') {
      entry.state.transaction = idleTransaction();
    } else if (c.transactionControl === 'begin') {
      entry.state.transaction = { open: true, statements: 1, startedAt: this.deps.now() };
    } else if (c.implicitCommit) {
      entry.state.transaction = idleTransaction();
    } else if (opensTransaction(c)) {
      entry.state.transaction = tx.open
        ? { ...tx, statements: tx.statements + 1 }
        : { open: true, statements: 1, startedAt: this.deps.now() };
    }
  }

  async cancel(tabId: string): Promise<void> {
    const entry = this.require(tabId);
    if (!entry.session || entry.state.status !== 'running') return;
    entry.cancelRequested = true;
    try {
      await entry.session.cancel();
    } catch (error) {
      throw toCaisError(error);
    }
  }

  /** The Commit and Rollback buttons (and the choice when closing a tab), on the trail. */
  private async endTransaction(entry: Entry & { session: DbSession }, how: 'commit' | 'rollback', detail?: string): Promise<void> {
    const statements = entry.state.transaction.statements;
    const line = {
      event: how,
      database: entry.state.database,
      sql: how === 'commit' ? 'COMMIT' : 'ROLLBACK',
      verb: how === 'commit' ? 'COMMIT' : 'ROLLBACK',
      detail: [m().mainSessions.trail.transactionStatements({ count: statements }), detail].filter(Boolean).join(' · '),
    } as const;
    const started = this.deps.now();
    const id = `p_${randomBytes(6).toString('hex')}`;
    this.record(entry, { ...line, id, state: 'running' });
    try {
      if (how === 'commit') await entry.session.commit();
      else await entry.session.rollback();
    } catch (error) {
      const info = error instanceof DriverError ? error.info : undefined;
      this.record(entry, { ...line, id, state: 'error', durationMs: this.deps.now() - started, ...(info?.code ? { errorCode: info.code } : {}) });
      throw toCaisError(error);
    }
    this.record(entry, { ...line, id, state: 'ok', durationMs: this.deps.now() - started });
  }

  async commit(tabId: string): Promise<SessionState> {
    const entry = this.requireConnected(tabId);
    if (entry.state.status === 'running') throw new CaisError(m().mainSessions.waitStatement);
    await this.endTransaction(entry, 'commit');
    entry.state.transaction = idleTransaction();
    await this.recycleIfStale(entry);
    this.touch(entry);
    return this.publish(entry);
  }

  async rollback(tabId: string): Promise<SessionState> {
    const entry = this.requireConnected(tabId);
    if (entry.state.status === 'running') throw new CaisError(m().mainSessions.waitStatement);
    await this.endTransaction(entry, 'rollback');
    entry.state.transaction = idleTransaction();
    await this.recycleIfStale(entry);
    this.touch(entry);
    return this.publish(entry);
  }

  async useDatabase(tabId: string, database: string): Promise<SessionState> {
    const entry = this.requireConnected(tabId);
    if (entry.state.status === 'running') throw new CaisError(m().mainSessions.waitStatement);
    const session = entry.session;
    const result = await session.useDatabase(database);
    // dropped meanwhile (idle timer, Desconectar, environment edited): nothing to update
    if (entry.session !== session) throw new CaisError(m().mainSessions.notConnected, 'not-connected');
    // the trail keeps the line of always: the driver's own text ("USE `db`"), verb USE, kind session
    this.recordResult(entry, { ...result, verb: result.verb || 'USE', kind: 'session' }, entry.state.database);
    if (result.error) throw new CaisError(result.error.message, result.error.code);
    const current = await session.currentDatabase().catch(() => database);
    if (entry.session !== session) throw new CaisError(m().mainSessions.notConnected, 'not-connected');
    entry.state.database = current;
    this.touch(entry);
    return this.publish(entry);
  }

  /**
   * Desconectar, by the person. Refused here (not only in the button) with a transaction open: dropping the
   * connection would be a silent rollback. The entry stays, so the tab keeps its mode and reconnects through `open`.
   */
  async disconnect(tabId: string): Promise<SessionState> {
    const entry = this.entries.get(tabId);
    if (!entry) return this.state(tabId);
    if (entry.state.status === 'running') throw new CaisError(m().mainSessions.disconnect.running, 'running');
    if (entry.state.status === 'connecting') throw new CaisError(m().mainSessions.disconnect.connecting, 'connecting');
    if (entry.state.transaction.open) throw new CaisError(m().mainSessions.disconnect.transactionOpen, 'transaction-open');
    if (entry.state.status === 'disconnected') return structuredClone(entry.state);
    await this.recycle(entry, 'manual');
    return structuredClone(entry.state);
  }

  async close(tabId: string, opts: { resolve?: 'commit' | 'rollback' } = {}): Promise<void> {
    const entry = this.entries.get(tabId);
    if (!entry) return;
    if (entry.state.status === 'running') {
      throw new CaisError(m().mainSessions.closeRunning);
    }
    if (entry.state.transaction.open && entry.session) {
      if (!opts.resolve) {
        throw new CaisError(m().mainSessions.closeTransaction, 'transaction-open');
      }
      await this.endTransaction(entry as Entry & { session: DbSession }, opts.resolve, m().mainSessions.trail.onCloseTab);
    }
    this.entries.delete(tabId);
    this.clearIdle(entry);
    await entry.session?.close().catch(() => undefined);
    entry.session = undefined;
    entry.state.status = 'disconnected';
    entry.state.transaction = idleTransaction();
    this.publish(entry);
  }

  /** Drops every connection (the server rolls back whatever is left). Used when quitting. */
  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    entries.forEach((e) => this.clearIdle(e));
    await Promise.all(entries.map((e) => e.session?.close().catch(() => undefined)));
  }
}

function toCaisError(error: unknown): CaisError {
  if (error instanceof CaisError) return error;
  if (error instanceof DriverError) return new CaisError(error.message, error.info.code);
  return new CaisError(error instanceof Error ? error.message : String(error));
}
