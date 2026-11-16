import { isGcpProjectId } from '@shared/engines';
import { m, ref } from '@shared/i18n';
import type { BigqueryConnectParams, ConnectParams, Driver } from '../types';
import { DriverError } from '../types';
import { BIGQUERY_BASE_URL, BigqueryClient, anything, dryRunBody, dryRunResponse, type FetchLike } from './client';
import { toDriverError } from './errors';
import { readSchema } from './introspect';
import { BigquerySession } from './session';

export interface BigqueryDriverOptions {
  /** `net.fetch` in the app (system proxy and certificates); the global `fetch` otherwise. */
  fetch?: FetchLike;
  /** Only the tests' fake server changes it. */
  baseUrl?: string;
}

function bigqueryParams(params: ConnectParams): BigqueryConnectParams {
  if (params.engine !== 'bigquery') throw new Error('BigQuery driver received parameters of another engine');
  return params;
}

export function createBigqueryDriver(options: BigqueryDriverOptions = {}): Driver {
  const clientFor = (params: BigqueryConnectParams): BigqueryClient => {
    // the project goes into request paths: refuse anything that is not a project id before it gets there
    if (!isGcpProjectId(params.project)) {
      const message = m().mainCatalog.gcpProjectInvalid;
      throw new DriverError(message, { message, ref: ref('mainCatalog.gcpProjectInvalid'), code: 'invalid' });
    }
    return new BigqueryClient({
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      baseUrl: options.baseUrl ?? BIGQUERY_BASE_URL,
      project: params.project,
      token: params.accessToken,
      ...(params.refresh ? { refresh: params.refresh } : {}),
    });
  };

  /** A short-lived client for one call that does not need a session; it never outlives the call. */
  async function withClient<T>(raw: ConnectParams, fn: (client: BigqueryClient, params: BigqueryConnectParams) => Promise<T>): Promise<T> {
    const params = bigqueryParams(raw);
    const client = clientFor(params);
    try {
      return await fn(client, params);
    } catch (error) {
      throw toDriverError(error);
    } finally {
      client.abortAll();
    }
  }

  return {
    engine: 'bigquery',
    lazyColumns: true,
    async open(raw) {
      const params = bigqueryParams(raw);
      return new BigquerySession(clientFor(params), params);
    },
    introspect: (raw, scope) => withClient(raw, (client, params) => readSchema(client, params.project, scope)),
    test: (raw) =>
      withClient(raw, async (client, params) => {
        if (!params.accessToken) throw new Error('no token');
        // lists one dataset (the account sees the project) and dry-runs SELECT 1 (it may create jobs there)
        await listDatasets1(client, params.project);
        await client.call(dryRunResponse, 'POST', `/projects/${encodeURIComponent(params.project)}/jobs`, {
          body: dryRunBody('SELECT 1'),
        });
        return { serverVersion: 'BigQuery' };
      }),
  };
}

async function listDatasets1(client: BigqueryClient, project: string): Promise<void> {
  await client.call(anything, 'GET', `/projects/${encodeURIComponent(project)}/datasets`, { query: { maxResults: 1 } });
}

export const bigqueryDriver: Driver = createBigqueryDriver();
