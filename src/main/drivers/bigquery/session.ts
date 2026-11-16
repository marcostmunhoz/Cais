import { randomUUID } from 'node:crypto';
import type { SessionMode } from '@shared/model';
import { isBigqueryDatasetId } from '@shared/engines';
import type { CellValue, ColumnMeta, StatementResult, StatementStats } from '@shared/results';
import { m, ref } from '@shared/i18n';
import { quoteIdent } from '@shared/dialects/bigquery';
import type { BigqueryConnectParams, DbSession, DbSessionError, ExecuteOptions, PrepareResult } from '../types';
import { DriverError } from '../types';
import { anything, datasetGet, jobGet, queryResponse, type BigqueryClient, type QueryResponse } from './client';
import { mapBigqueryError } from './errors';
import { columnMeta, decodeRow, type SchemaField } from './values';

/** How long jobs.query waits for a quick answer before handing back a job to poll. */
const QUICK_WAIT_MS = 5_000;
/** How long one getQueryResults poll may wait on the server. */
const POLL_WAIT_MS = 10_000;
const MAX_PAGE_ROWS = 10_000;
const CANCEL_BOUND_MS = 10_000;
/** What jobs.query may take beyond its own wait before it is given up (it is not stopped by close, see `run`). */
const QUERY_CALL_SLACK_MS = 15_000;

const lostError = (): DbSessionError => ({ message: m().mainMisc.driver.lost, ref: ref('mainMisc.driver.lost'), fatal: true });
const cancelledError = (): DbSessionError => ({
  message: m().mainMisc.driver.cancelled,
  ref: ref('mainMisc.driver.cancelled'),
  code: 'CANCELLED',
});

interface JobRef {
  jobId: string;
  location?: string;
}

/** The last finished read, kept so "Buscar até 50.000" can read more pages of the same job instead of running again. */
interface LastJob {
  sql: string;
  dataset: string | null;
  job: JobRef;
  stats: StatementStats;
}

interface Active {
  controller: AbortController;
  job?: JobRef;
  cancelRequested: boolean;
}

/**
 * One BigQuery "session": no state on the server. The current dataset lives here, and every statement is a job.
 * Read-only is enforced twice: the app's classifier before the call, and the dry run here, which must read the
 * statement as SELECT.
 */
export class BigquerySession implements DbSession {
  readonly serverVersion = 'BigQuery';
  private dataset: string | null;
  private jobTimeoutMs: number | undefined;
  private fatalCallbacks: ((err: DbSessionError) => void)[] = [];
  private fatalSent = false;
  private dead: DbSessionError | null = null;
  private closing = false;
  private active: Active | null = null;
  private last: LastJob | null = null;

  constructor(
    private readonly client: BigqueryClient,
    private readonly params: BigqueryConnectParams,
  ) {
    this.dataset = params.defaultDataset ?? null;
  }

  private get projectPath(): string {
    return `/projects/${encodeURIComponent(this.params.project)}`;
  }

  private reportFatal(info: DbSessionError): void {
    if (this.fatalSent) return;
    this.fatalSent = true;
    for (const cb of this.fatalCallbacks) cb({ ...info, fatal: true });
  }

  onFatalError(cb: (err: DbSessionError) => void): void {
    this.fatalCallbacks.push(cb);
  }

  isAlive(): boolean {
    return !this.dead && !this.closing;
  }

  async applyMode(mode: SessionMode): Promise<void> {
    if (mode !== 'read-only') {
      const message = m().mainMisc.bigquery.modeNotSupported;
      throw new DriverError(message, { message, ref: ref('mainMisc.bigquery.modeNotSupported'), code: 'MODE_NOT_SUPPORTED' });
    }
  }

  async applyLimits(limits: { maxExecutionMs?: number }): Promise<void> {
    if (limits.maxExecutionMs !== undefined) this.jobTimeoutMs = Math.max(1, Math.floor(limits.maxExecutionMs));
  }

  async reset(): Promise<void> {
    // nothing to clear: the server keeps no session for us
  }

  async currentDatabase(): Promise<string | null> {
    return this.dataset;
  }

  async commit(): Promise<void> {
    // no transactions here
  }

  async rollback(): Promise<void> {
    // no transactions here
  }

  /** Checks the dataset exists (a 404 is an error) and makes it the default for unqualified names. */
  async useDatabase(name: string): Promise<StatementResult> {
    const started = performance.now();
    const base: StatementResult = { index: 0, sql: `DATASET ${quoteIdent(name)}`, kind: 'session', verb: 'DATASET', durationMs: 0 };
    const elapsed = (): number => Math.round(performance.now() - started);
    if (this.dead) return { ...base, durationMs: elapsed(), error: this.dead };
    if (!isBigqueryDatasetId(name)) {
      return { ...base, durationMs: elapsed(), error: { message: m().mainMisc.bigquery.datasetInvalid, ref: ref('mainMisc.bigquery.datasetInvalid'), code: 'invalid' } };
    }
    try {
      await this.client.call(datasetGet, 'GET', `${this.projectPath}/datasets/${encodeURIComponent(name)}`);
    } catch (error) {
      const info = mapBigqueryError(error, { cancelled: false });
      if (info.code === 'notFound') {
        return {
          ...base,
          durationMs: elapsed(),
          error: { ...info, message: m().mainMisc.bigquery.datasetNotFound({ name }), ref: ref('mainMisc.bigquery.datasetNotFound', { name }) },
        };
      }
      return { ...base, durationMs: elapsed(), error: info };
    }
    this.dataset = name;
    this.last = null;
    return { ...base, durationMs: elapsed() };
  }

  private defaultDataset(): { projectId: string; datasetId: string } | undefined {
    return this.dataset ? { projectId: this.params.project, datasetId: this.dataset } : undefined;
  }

  /** The dry run: what BigQuery reads the statement as, and how many bytes it would read. */
  async prepare(sql: string): Promise<PrepareResult> {
    try {
      const response = await this.dryRun(sql, undefined);
      return {
        ...(response.statementType ? { serverKind: response.statementType } : {}),
        ...(response.totalBytesProcessed !== undefined ? { bytesEstimated: response.totalBytesProcessed } : {}),
      };
    } catch (error) {
      return { error: mapBigqueryError(error, { cancelled: false }) };
    }
  }

  private dryRun(sql: string, signal: AbortSignal | undefined): Promise<QueryResponse> {
    return this.client.call(queryResponse, 'POST', `${this.projectPath}/queries`, {
      body: { query: sql, dryRun: true, useLegacySql: false, ...(this.defaultDataset() ? { defaultDataset: this.defaultDataset() } : {}) },
      ...(signal ? { signal } : {}),
    });
  }

  async execute(sql: string, opts: ExecuteOptions): Promise<StatementResult> {
    const started = performance.now();
    const base: StatementResult = { index: 0, sql, kind: 'other', verb: '', durationMs: 0 };
    const elapsed = (): number => Math.round(performance.now() - started);
    if (this.dead) return { ...base, durationMs: elapsed(), error: this.dead };
    if (this.active) return { ...base, durationMs: elapsed(), error: { message: m().mainSessions.alreadyRunning } };
    const active: Active = { controller: new AbortController(), cancelRequested: false };
    this.active = active;
    try {
      if (opts.refetch) {
        // never a new job: it would bill again with no estimate and no question in main
        const again = this.last && this.last.sql === sql && this.last.dataset === this.dataset ? await this.refetch(this.last, opts, active).catch(() => undefined) : undefined;
        if (active.cancelRequested) return { ...base, durationMs: elapsed(), error: cancelledError() };
        if (!again) {
          const message = m().mainMisc.bigquery.resultExpired;
          return { ...base, durationMs: elapsed(), error: { message, ref: ref('mainMisc.bigquery.resultExpired'), code: 'RESULT_EXPIRED' } };
        }
        return { ...base, durationMs: elapsed(), ...again };
      }
      const dry = await this.dryRun(sql, active.controller.signal);
      if (active.cancelRequested) return { ...base, durationMs: elapsed(), error: cancelledError() };
      const refusal = this.refusal(dry);
      if (refusal) return { ...base, durationMs: elapsed(), error: refusal };
      if (opts.estimateCeiling !== undefined && dry.totalBytesProcessed !== undefined && dry.totalBytesProcessed > opts.estimateCeiling) {
        const params = { bytes: dry.totalBytesProcessed, ceiling: opts.estimateCeiling };
        return {
          ...base,
          durationMs: elapsed(),
          error: { message: m().agentsUi.error.bytesOverApproved(params), ref: ref('agentsUi.error.bytesOverApproved', params), code: 'bytes_over_approved' },
        };
      }
      const stats: StatementStats = { ...(dry.totalBytesProcessed !== undefined ? { bytesEstimated: dry.totalBytesProcessed } : {}) };
      const read = await this.run(sql, opts, active, stats);
      return { ...base, durationMs: elapsed(), ...read };
    } catch (error) {
      // a stop by Cancelar is a cancellation whatever the server or the aborted request said
      if (active.cancelRequested && !this.dead) return { ...base, durationMs: elapsed(), error: cancelledError() };
      if (this.closing) return { ...base, durationMs: elapsed(), error: this.dead ?? lostError() };
      return { ...base, durationMs: elapsed(), error: mapBigqueryError(error, { cancelled: false }) };
    } finally {
      this.active = null;
    }
  }

  /** The statement must be a SELECT to the server's eyes: anything else (or no answer on it) is refused. */
  private refusal(dry: QueryResponse): DbSessionError | null {
    const type = dry.statementType;
    if (type === 'SELECT') return null;
    const t = m().mainMisc.bigquery;
    return type
      ? { message: t.refusedType({ type }), ref: ref('mainMisc.bigquery.refusedType', { type }), code: 'REFUSED' }
      : { message: t.refusedUnknown, ref: ref('mainMisc.bigquery.refusedUnknown'), code: 'REFUSED' };
  }

  private maxBytes(opts: ExecuteOptions): number | undefined {
    return opts.maxBytesBilled ?? this.params.maxBytesBilled;
  }

  /** jobs.query for real, then the pages up to the row cap. */
  private async run(sql: string, opts: ExecuteOptions, active: Active, stats: StatementStats): Promise<Partial<StatementResult>> {
    const maxBytes = this.maxBytes(opts);
    const pageSize = Math.min(opts.maxRows + 1, MAX_PAGE_ROWS);
    let response = await this.client.call(queryResponse, 'POST', `${this.projectPath}/queries`, {
      // Not tied to the client's life: close and destroy abort every call, and an aborted jobs.query would lose the
      // job id of a job the server already created (it would run and bill with nobody to cancel it). It waits for
      // the answer, bounded, and the check below stops the job when close or Cancelar came meanwhile.
      detached: true,
      signal: AbortSignal.any([active.controller.signal, AbortSignal.timeout(QUICK_WAIT_MS + QUERY_CALL_SLACK_MS)]),
      body: {
        query: sql,
        useLegacySql: false,
        ...(this.defaultDataset() ? { defaultDataset: this.defaultDataset() } : {}),
        ...(maxBytes !== undefined ? { maximumBytesBilled: String(maxBytes) } : {}),
        ...(this.jobTimeoutMs !== undefined ? { jobTimeoutMs: String(this.jobTimeoutMs) } : {}),
        requestId: randomUUID(),
        labels: { cais: this.params.origin },
        formatOptions: { useInt64Timestamp: true },
        timeoutMs: QUICK_WAIT_MS,
        maxResults: pageSize,
        // always a job: the id feeds the stats, the paging, the refetch and the cancel
        jobCreationMode: 'JOB_CREATION_REQUIRED',
      },
    });
    const location = response.jobReference?.location ?? response.location;
    if (response.jobReference?.jobId) {
      active.job = { jobId: response.jobReference.jobId, ...(location ? { location } : {}) };
      // Cancelar came before the job had an id: stop it now
      if (active.cancelRequested) {
        await this.stopJob(active.job);
        return { error: cancelledError() };
      }
    }
    const job = active.job;
    while (response.jobComplete === false) {
      if (!job) throw new DriverError(m().mainMisc.bigquery.unexpectedResponse, { message: m().mainMisc.bigquery.unexpectedResponse, code: 'UNEXPECTED_RESPONSE' });
      response = await this.pollResults(job, { timeoutMs: POLL_WAIT_MS, maxResults: pageSize }, active);
    }
    return this.collect(sql, response, job, opts, active, stats);
  }

  private pollResults(job: JobRef, query: Record<string, string | number | undefined>, active: Active): Promise<QueryResponse> {
    return this.client.call(queryResponse, 'GET', `${this.projectPath}/queries/${encodeURIComponent(job.jobId)}`, {
      signal: active.controller.signal,
      // getQueryResults defaults to float seconds for TIMESTAMP; the decoder reads integer microseconds
      query: { ...query, 'formatOptions.useInt64Timestamp': 'true', ...(job.location ? { location: job.location } : {}) },
    });
  }

  /** Reads the first page's rows and the following pages until the cap (plus one row, to know it was cut). */
  private async collect(
    sql: string,
    first: QueryResponse,
    job: JobRef | undefined,
    opts: ExecuteOptions,
    active: Active,
    stats: StatementStats,
  ): Promise<Partial<StatementResult>> {
    const fields: SchemaField[] = first.schema?.fields ?? [];
    const columns: ColumnMeta[] = fields.map(columnMeta);
    const rows: CellValue[][] = [];
    const pageSize = Math.min(opts.maxRows + 1, MAX_PAGE_ROWS);
    let page = first;
    let latest: QueryResponse = first;
    for (;;) {
      for (const row of page.rows ?? []) {
        if (rows.length > opts.maxRows) break;
        rows.push(decodeRow(row, fields));
      }
      latest = { ...latest, ...definedStats(page) };
      if (rows.length > opts.maxRows || !page.pageToken) break;
      if (!job) break;
      page = await this.pollResults(job, { pageToken: page.pageToken, maxResults: pageSize }, active);
    }
    const truncated = rows.length > opts.maxRows;
    if (truncated) rows.length = opts.maxRows;
    // getQueryResults has no billed bytes (a job that was polled ends there): jobs.get has them
    if (job && latest.totalBytesBilled === undefined && stats.bytesBilled === undefined) {
      const done = await this.client
        .call(jobGet, 'GET', `${this.projectPath}/jobs/${encodeURIComponent(job.jobId)}`, {
          signal: active.controller.signal,
          query: job.location ? { location: job.location } : {},
        })
        .catch(() => undefined);
      const q = done?.statistics?.query;
      if (q) {
        latest = {
          ...latest,
          ...(q.totalBytesBilled !== undefined ? { totalBytesBilled: q.totalBytesBilled } : {}),
          ...(latest.totalBytesProcessed === undefined && q.totalBytesProcessed !== undefined ? { totalBytesProcessed: q.totalBytesProcessed } : {}),
          ...(latest.cacheHit === undefined && q.cacheHit !== undefined ? { cacheHit: q.cacheHit } : {}),
        };
      }
    }
    const final: StatementStats = {
      ...stats,
      ...(latest.totalBytesProcessed !== undefined ? { bytesProcessed: latest.totalBytesProcessed } : {}),
      ...(latest.totalBytesBilled !== undefined ? { bytesBilled: latest.totalBytesBilled } : {}),
      ...(latest.cacheHit !== undefined ? { cacheHit: latest.cacheHit } : {}),
      ...(job ? { jobId: job.jobId } : {}),
    };
    if (job) this.last = { sql, dataset: this.dataset, job, stats: final };
    return { columns, rows, ...(truncated ? { truncated: true } : {}), stats: final };
  }

  /** Reads the result of the last job again, from the first row, with the new cap. Undefined when it cannot. */
  private async refetch(last: LastJob, opts: ExecuteOptions, active: Active): Promise<Partial<StatementResult> | undefined> {
    active.job = last.job;
    const pageSize = Math.min(opts.maxRows + 1, MAX_PAGE_ROWS);
    const first = await this.pollResults(last.job, { maxResults: pageSize, startIndex: 0 }, active);
    if (first.jobComplete === false) return undefined;
    const read = await this.collect(last.sql, first, last.job, opts, active, last.stats);
    return { ...read, ...(read.stats ? { stats: { ...read.stats, reread: true } } : {}) };
  }

  /** jobs.cancel, bounded. A token that expired is exchanged by the client on the 401, not before every cancel. */
  private async stopJob(job: JobRef): Promise<void> {
    await this.client
      .call(anything, 'POST', `${this.projectPath}/jobs/${encodeURIComponent(job.jobId)}/cancel`, {
        query: job.location ? { location: job.location } : {},
        detached: true,
        signal: AbortSignal.timeout(CANCEL_BOUND_MS),
      })
      .catch(() => undefined);
  }

  async cancel(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.cancelRequested = true;
    if (active.job) {
      const stopping = this.stopJob(active.job);
      // what is waiting on the job ends now instead of at the next poll (the cancel is detached, so it still goes out)
      active.controller.abort();
      await stopping;
    }
    // no job id yet (the dry run or the jobs.query call is still in flight): the run stops as soon as it has one
  }

  async close(): Promise<void> {
    this.closing = true;
    const active = this.active;
    if (active) {
      active.cancelRequested = true;
      if (active.job) await this.stopJob(active.job);
    }
    this.client.abortAll();
  }

  destroy(): void {
    this.dead ??= lostError();
    this.closing = true;
    const active = this.active;
    if (active) {
      active.cancelRequested = true;
      if (active.job) void this.stopJob(active.job);
    }
    this.reportFatal(this.dead);
    // the cancel above is detached from the client's lifetime, so aborting everything does not stop it
    this.client.abortAll();
  }
}

function definedStats(r: QueryResponse): Partial<QueryResponse> {
  return {
    ...(r.totalBytesProcessed !== undefined ? { totalBytesProcessed: r.totalBytesProcessed } : {}),
    ...(r.totalBytesBilled !== undefined ? { totalBytesBilled: r.totalBytesBilled } : {}),
    ...(r.cacheHit !== undefined ? { cacheHit: r.cacheHit } : {}),
  };
}
