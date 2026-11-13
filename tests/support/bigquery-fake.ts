import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A schema field as the REST API writes it. */
export interface FakeField {
  name: string;
  type: string;
  mode?: string;
  fields?: FakeField[];
}

export interface FakeResult {
  schema: FakeField[];
  /** Each row is the list of raw `v` values of its cells (text, null, `{ f: [...] }` or `[{ v }]`). */
  rows: unknown[][];
}

export interface FakeError {
  status: number;
  reason: string;
  message: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  authorization: string | undefined;
}

interface Job {
  id: string;
  sql: string;
  result: FakeResult;
  state: 'running' | 'done' | 'cancelled';
  bytes: number;
  billed: number;
  cacheHit: boolean;
  expired: boolean;
}

const ROOT = '/bigquery/v2';

/**
 * A local stand-in for the parts of the BigQuery REST API that Cais uses: jobs.query (dry run and real),
 * jobs.getQueryResults with pages, jobs.cancel, datasets and tables. It listens on a random port on 127.0.0.1 and
 * never talks to anything else.
 */
export class FakeBigquery {
  private server: Server | undefined;
  url = '';
  readonly requests: RecordedRequest[] = [];
  readonly jobs = new Map<string, Job>();
  private seq = 0;
  private waiters = new Map<string, (() => void)[]>();

  /** Access tokens the server accepts; anything else gets a 401. */
  validTokens = new Set(['test-token']);
  /** What `statementType` the dry run reports for a statement (empty: none at all). */
  statementType: (sql: string) => string = (sql) => (/^\s*\(*\s*(SELECT|WITH|FROM)\b/i.test(sql) ? 'SELECT' : sql.trim().split(/\s+/)[0]!.toUpperCase());
  /** The result of a statement. */
  resultFor: (sql: string) => FakeResult = () => ({ schema: [{ name: 'n', type: 'INTEGER' }], rows: [['1']] });
  /** Bytes the dry run estimates. */
  bytesFor: (sql: string) => number = () => 1024;
  /** An error for a statement, at the dry run or at the real run. */
  dryRunError: (sql: string) => FakeError | undefined = () => undefined;
  runError: (sql: string) => FakeError | undefined = () => undefined;
  /** A statement the server never finishes by itself (only a cancel ends it). */
  slow: (sql: string) => boolean = (sql) => /\bSLOW\b/.test(sql);
  /** Datasets, and in each the tables with their kind and schema. */
  datasets = new Map<string, Map<string, { type: string; schema: FakeField[] }>>();
  /** Page size of the dataset and table lists (to exercise paging). */
  listPageSize = 1000;
  /** The server forgets finished jobs (result expired): getQueryResults answers 404. */
  expireJobs = false;
  /** A statement whose jobs.query answers `jobComplete: false` although the job is done (the result comes by polling). */
  incompleteFirst: (sql: string) => boolean = () => false;
  /** How long a real jobs.query takes to answer (the job already exists on the server meanwhile). */
  queryDelayMs = 0;
  /** An HTTP-level error for every request of a path substring. */
  failPath: { includes: string; error: FakeError } | undefined;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 500, message: String(error), errors: [{ reason: 'backendError' }] } }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}${ROOT}`;
  }

  async stop(): Promise<void> {
    for (const list of this.waiters.values()) list.forEach((wake) => wake());
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Back to a clean slate between tests (job numbering included); settings are set by the test. */
  reset(): void {
    this.requests.length = 0;
    this.jobs.clear();
    this.seq = 0;
  }

  addDataset(name: string, tables: Record<string, { type?: string; schema?: FakeField[] }> = {}): void {
    this.datasets.set(
      name,
      new Map(Object.entries(tables).map(([t, v]) => [t, { type: v.type ?? 'TABLE', schema: v.schema ?? [] }])),
    );
  }

  requestsTo(pathPart: string, method?: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path.includes(pathPart) && (!method || r.method === method));
  }

  /** Real (not dry run) jobs.query calls. */
  get realQueries(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/queries') && !r.body?.dryRun);
  }

  get dryRuns(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/queries') && r.body?.dryRun === true);
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private fail(res: ServerResponse, error: FakeError): void {
    this.json(res, error.status, { error: { code: error.status, message: error.message, errors: [{ reason: error.reason, message: error.message }] } });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const record: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname.slice(ROOT.length),
      query: Object.fromEntries(url.searchParams),
      body: raw ? JSON.parse(raw) : undefined,
      authorization: req.headers.authorization,
    };
    this.requests.push(record);

    const token = (record.authorization ?? '').replace(/^Bearer /, '');
    if (!this.validTokens.has(token)) {
      return this.fail(res, { status: 401, reason: 'authError', message: 'Invalid Credentials' });
    }
    if (this.failPath && record.path.includes(this.failPath.includes)) return this.fail(res, this.failPath.error);

    const parts = record.path.split('/').filter(Boolean); // projects, <p>, ...
    if (parts[0] !== 'projects' || parts.length < 3) return this.fail(res, { status: 404, reason: 'notFound', message: 'Not found' });
    const rest = parts.slice(2);

    if (rest[0] === 'queries' && rest.length === 1 && record.method === 'POST') return await this.query(record, res, parts[1]!);
    if (rest[0] === 'queries' && rest.length === 2 && record.method === 'GET') return this.results(record, res, parts[1]!, decodeURIComponent(rest[1]!));
    if (rest[0] === 'jobs' && rest[2] === 'cancel' && record.method === 'POST') {
      const job = this.jobs.get(decodeURIComponent(rest[1]!));
      if (!job) return this.fail(res, { status: 404, reason: 'notFound', message: 'Job not found' });
      if (job.state === 'running') job.state = 'cancelled';
      this.wake(job.id);
      return this.json(res, 200, { job: { jobReference: { jobId: job.id } } });
    }
    if (rest[0] === 'jobs' && rest.length === 2 && record.method === 'GET') {
      const job = this.jobs.get(decodeURIComponent(rest[1]!));
      if (!job) return this.fail(res, { status: 404, reason: 'notFound', message: 'Job not found' });
      return this.json(res, 200, {
        jobReference: { projectId: 'proj', jobId: job.id, location: 'US' },
        statistics: { query: { totalBytesProcessed: String(job.bytes), totalBytesBilled: String(job.billed), cacheHit: job.cacheHit } },
      });
    }
    if (rest[0] === 'datasets') return this.metadata(record, res, rest.slice(1));
    return this.fail(res, { status: 404, reason: 'notFound', message: 'Not found' });
  }

  private wake(jobId: string): void {
    for (const wake of this.waiters.get(jobId) ?? []) wake();
    this.waiters.delete(jobId);
  }

  /**
   * One page. Like the real API: TIMESTAMP cells are float seconds in E-notation unless the caller asked for
   * `useInt64Timestamp`, and only jobs.query (`billed`) carries the billed bytes, getQueryResults does not.
   */
  private page(job: Job, query: Record<string, string>, opts: { int64Timestamp: boolean; billed: boolean }): Record<string, unknown> {
    const size = Number(query.maxResults ?? 10_000);
    const start = query.pageToken ? Number(query.pageToken.replace('p:', '')) : Number(query.startIndex ?? 0);
    const asFloat = (v: unknown): unknown => (typeof v === 'string' && /^-?\d+$/.test(v) ? (Number(v) / 1e6).toExponential().toUpperCase().replace('E+', 'E') : v);
    const rows = job.result.rows.slice(start, start + size).map((cells) => ({
      f: cells.map((v, i) => ({ v: !opts.int64Timestamp && job.result.schema[i]?.type === 'TIMESTAMP' ? asFloat(v) : v })),
    }));
    const next = start + size;
    return {
      kind: 'bigquery#getQueryResultsResponse',
      jobComplete: true,
      jobReference: { projectId: 'proj', jobId: job.id, location: 'US' },
      location: 'US',
      schema: { fields: job.result.schema },
      totalRows: String(job.result.rows.length),
      rows,
      ...(next < job.result.rows.length ? { pageToken: `p:${next}` } : {}),
      totalBytesProcessed: String(job.bytes),
      ...(opts.billed ? { totalBytesBilled: String(job.billed) } : {}),
      cacheHit: job.cacheHit,
      statementType: 'SELECT',
    };
  }

  private async query(req: RecordedRequest, res: ServerResponse, _project: string): Promise<void> {
    const body = req.body ?? {};
    const sql = String(body.query ?? '');
    if (body.dryRun === true) {
      const error = this.dryRunError(sql);
      if (error) return this.fail(res, error);
      return this.json(res, 200, {
        kind: 'bigquery#queryResponse',
        jobComplete: true,
        ...(this.statementType(sql) ? { statementType: this.statementType(sql) } : {}),
        totalBytesProcessed: String(this.bytesFor(sql)),
      });
    }
    const error = this.runError(sql);
    if (error) return this.fail(res, error);
    const bytes = this.bytesFor(sql);
    if (body.maximumBytesBilled !== undefined && bytes > Number(body.maximumBytesBilled)) {
      return this.fail(res, {
        status: 400,
        reason: 'bytesBilledLimitExceeded',
        message: `Query exceeded limit for bytes billed: ${body.maximumBytesBilled}. ${bytes} or higher required.`,
      });
    }
    const job: Job = {
      id: `job_${++this.seq}`,
      sql,
      result: this.resultFor(sql),
      state: this.slow(sql) ? 'running' : 'done',
      bytes,
      billed: Math.ceil(bytes / 10_485_760) * 10_485_760,
      cacheHit: false,
      expired: false,
    };
    this.jobs.set(job.id, job);
    if (this.queryDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.queryDelayMs));
    if (job.state === 'running' || this.incompleteFirst(sql)) {
      return this.json(res, 200, {
        kind: 'bigquery#queryResponse',
        jobComplete: false,
        jobReference: { projectId: 'proj', jobId: job.id, location: 'US' },
      });
    }
    this.json(res, 200, this.page(job, { maxResults: String(body.maxResults ?? 10_000) }, { int64Timestamp: body.formatOptions?.useInt64Timestamp === true, billed: true }));
  }

  private async results(req: RecordedRequest, res: ServerResponse, _project: string, jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || (this.expireJobs && job.state === 'done')) {
      return this.fail(res, { status: 404, reason: 'notFound', message: `Not found: Job ${jobId}` });
    }
    if (job.state === 'running') {
      await new Promise<void>((resolve) => {
        const list = this.waiters.get(job.id) ?? [];
        list.push(resolve);
        this.waiters.set(job.id, list);
        setTimeout(resolve, 100);
      });
    }
    if (job.state === 'cancelled') {
      return this.fail(res, { status: 400, reason: 'stopped', message: 'Job execution was cancelled: User requested cancellation' });
    }
    if (job.state === 'running') {
      return this.json(res, 200, { kind: 'bigquery#getQueryResultsResponse', jobComplete: false, jobReference: { projectId: 'proj', jobId: job.id, location: 'US' } });
    }
    this.json(res, 200, this.page(job, req.query, { int64Timestamp: req.query['formatOptions.useInt64Timestamp'] === 'true', billed: false }));
  }

  private metadata(req: RecordedRequest, res: ServerResponse, parts: string[]): void {
    const dataset = parts[0] ? decodeURIComponent(parts[0]) : undefined;
    const paged = <T>(items: T[]): { items: T[]; next?: string } => {
      const start = Number(req.query.pageToken ?? 0);
      const size = Math.min(this.listPageSize, Number(req.query.maxResults ?? this.listPageSize));
      return { items: items.slice(start, start + size), ...(start + size < items.length ? { next: String(start + size) } : {}) };
    };
    if (!dataset) {
      const names = [...this.datasets.keys()];
      const p = paged(names);
      return this.json(res, 200, {
        kind: 'bigquery#datasetList',
        datasets: p.items.map((d) => ({ datasetReference: { projectId: 'proj', datasetId: d } })),
        ...(p.next ? { nextPageToken: p.next } : {}),
      });
    }
    const tables = this.datasets.get(dataset);
    if (!tables) return this.fail(res, { status: 404, reason: 'notFound', message: `Not found: Dataset proj:${dataset}` });
    if (parts.length === 1) return this.json(res, 200, { datasetReference: { projectId: 'proj', datasetId: dataset } });
    if (parts[1] === 'tables' && parts.length === 2) {
      const p = paged([...tables.entries()]);
      return this.json(res, 200, {
        kind: 'bigquery#tableList',
        tables: p.items.map(([id, t]) => ({ tableReference: { projectId: 'proj', datasetId: dataset, tableId: id }, type: t.type })),
        ...(p.next ? { nextPageToken: p.next } : {}),
      });
    }
    if (parts[1] === 'tables' && parts.length === 3) {
      const table = tables.get(decodeURIComponent(parts[2]!));
      if (!table) return this.fail(res, { status: 404, reason: 'notFound', message: 'Not found: Table' });
      return this.json(res, 200, { type: table.type, schema: { fields: table.schema } });
    }
    this.fail(res, { status: 404, reason: 'notFound', message: 'Not found' });
  }
}
