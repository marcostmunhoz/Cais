import { z } from 'zod';
import { m, ref } from '@shared/i18n';
import { DriverError } from '../types';
import { BigqueryApiError, BigqueryNetworkError, isAbort } from './errors';
import type { SchemaField } from './values';

export const BIGQUERY_BASE_URL = 'https://bigquery.googleapis.com/bigquery/v2';

/** The part of `fetch` the client uses: the app passes `net.fetch` (system proxy and certificates), tests a fake. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// --- responses, validated with zod: int64 fields come as text (or numbers), unknown fields are ignored ---

const int64 = z.union([z.string(), z.number()]).transform((v) => Number(v));

const fieldSchema: z.ZodType<SchemaField> = z.lazy(() =>
  z.object({
    name: z.string().optional(),
    type: z.string(),
    mode: z.string().optional(),
    fields: z.array(fieldSchema).optional(),
    maxLength: z.string().optional(),
    precision: z.string().optional(),
    scale: z.string().optional(),
    rangeElementType: z.object({ type: z.string() }).optional(),
  }),
);

const tableSchema = z.object({ fields: z.array(fieldSchema).optional() });
const jobReference = z.object({ projectId: z.string().optional(), jobId: z.string(), location: z.string().optional() });

export const queryResponse = z.object({
  jobComplete: z.boolean().optional(),
  jobReference: jobReference.optional(),
  location: z.string().optional(),
  schema: tableSchema.optional(),
  rows: z.array(z.object({ f: z.array(z.object({ v: z.unknown().optional() })).optional() })).optional(),
  pageToken: z.string().optional(),
  totalRows: int64.optional(),
  totalBytesProcessed: int64.optional(),
  totalBytesBilled: int64.optional(),
  cacheHit: z.boolean().optional(),
  statementType: z.string().optional(),
});
export type QueryResponse = z.infer<typeof queryResponse>;

/** jobs.get: only the query statistics, where the billed bytes live (getQueryResults does not carry them). */
export const jobGet = z.object({
  statistics: z
    .object({
      query: z
        .object({ totalBytesBilled: int64.optional(), totalBytesProcessed: int64.optional(), cacheHit: z.boolean().optional() })
        .optional(),
    })
    .optional(),
});

export const datasetList = z.object({
  datasets: z.array(z.object({ datasetReference: z.object({ datasetId: z.string() }) })).optional(),
  nextPageToken: z.string().optional(),
});

export const tableList = z.object({
  tables: z.array(z.object({ tableReference: z.object({ tableId: z.string() }), type: z.string().optional() })).optional(),
  nextPageToken: z.string().optional(),
});

export const tableGet = z.object({ type: z.string().optional(), schema: tableSchema.optional() });
export const datasetGet = z.object({ datasetReference: z.object({ datasetId: z.string() }).optional() });
export const anything = z.unknown();

const errorBody = z.object({
  error: z
    .object({
      code: z.number().optional(),
      message: z.string().optional(),
      status: z.string().optional(),
      errors: z.array(z.object({ reason: z.string().optional(), message: z.string().optional() })).optional(),
    })
    .optional(),
});

function reasonFor(status: number, reason: string | undefined, googleStatus: string | undefined): string {
  if (reason) return reason;
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'accessDenied';
  if (status === 404) return 'notFound';
  if (googleStatus) return googleStatus;
  return 'unknown';
}

export interface ClientOptions {
  fetch: FetchLike;
  baseUrl: string;
  project: string;
  token: string;
  /** A new access token, asked once when the server answers 401. */
  refresh?: () => Promise<string>;
}

export interface CallOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Stops this call only. */
  signal?: AbortSignal;
  /** Not tied to the client's lifetime: a cancel that must still go out while the client is being closed. */
  detached?: boolean;
}

/** The BigQuery REST API of one project. Tokens stay inside; nothing here logs a header or a body. */
export class BigqueryClient {
  private token: string;
  private readonly life = new AbortController();

  constructor(private readonly options: ClientOptions) {
    this.token = options.token;
  }

  get project(): string {
    return this.options.project;
  }

  /** Aborts every call in flight and refuses new ones. */
  abortAll(): void {
    this.life.abort();
  }

  get aborted(): boolean {
    return this.life.signal.aborted;
  }

  /** One token exchange at a time: calls that meet a 401 together wait for the same one. */
  private refreshing: Promise<void> | null = null;

  private newToken(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const refresh = this.options.refresh!;
    const run = refresh()
      .then((token) => {
        this.token = token;
      })
      .finally(() => {
        if (this.refreshing === run) this.refreshing = null;
      });
    this.refreshing = run;
    return run;
  }

  async call<T>(schema: z.ZodType<T>, method: 'GET' | 'POST', path: string, opts: CallOptions = {}): Promise<T> {
    let retried = false;
    for (;;) {
      const used = this.token;
      const response = await this.send(method, path, opts);
      if (response.status === 401 && !retried && this.options.refresh) {
        retried = true;
        await response.body?.cancel().catch(() => undefined);
        // another call may have changed the token since this one left: then there is nothing to exchange
        if (this.token === used) await this.newToken();
        continue;
      }
      return this.read(schema, response);
    }
  }

  private async send(method: string, path: string, opts: CallOptions): Promise<Response> {
    const url = new URL(`${this.options.baseUrl}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const signals = [opts.signal, opts.detached ? undefined : this.life.signal].filter((s): s is AbortSignal => !!s);
    const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    try {
      return await this.options.fetch(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (isAbort(error) || signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      throw new BigqueryNetworkError();
    }
  }

  private async read<T>(schema: z.ZodType<T>, response: Response): Promise<T> {
    let body: unknown;
    try {
      const text = await response.text();
      body = text ? JSON.parse(text) : {};
    } catch (error) {
      if (isAbort(error)) throw error;
      body = undefined;
    }
    if (!response.ok) {
      const parsed = errorBody.safeParse(body);
      const detail = parsed.success ? parsed.data.error : undefined;
      const reason = reasonFor(response.status, detail?.errors?.[0]?.reason, detail?.status);
      throw new BigqueryApiError(response.status, reason, detail?.message ?? detail?.errors?.[0]?.message ?? `HTTP ${response.status}`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new DriverError(m().mainMisc.bigquery.unexpectedResponse, {
        message: m().mainMisc.bigquery.unexpectedResponse,
        ref: ref('mainMisc.bigquery.unexpectedResponse'),
        code: 'UNEXPECTED_RESPONSE',
      });
    }
    return parsed.data;
  }
}
