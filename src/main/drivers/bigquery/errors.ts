import { m, ref, render, type MessageRef } from '@shared/i18n';
import type { DbSessionError } from '../types';
import { CaisError } from '../../errors';
import { DriverError } from '../types';

/** The API answered with an error body: HTTP status, the first `reason` and BigQuery's own message. */
export class BigqueryApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly apiMessage: string,
  ) {
    super(apiMessage);
    this.name = 'BigqueryApiError';
  }
}

/** The request never got an answer (no route, proxy, DNS, TLS). */
export class BigqueryNetworkError extends Error {
  constructor() {
    super('network');
    this.name = 'BigqueryNetworkError';
  }
}

export interface ErrorContext {
  /** The person or the cut pressed Cancelar: a stop is a cancellation, not a failure. */
  cancelled: boolean;
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

const unauthenticatedReasons = new Set(['authError', 'unauthenticated']);
const accessReasons = new Set(['accessDenied', 'forbidden', 'billingNotEnabled', 'permissionDenied']);
const invalidReasons = new Set(['invalidQuery', 'invalid', 'badRequest']);
const backendReasons = new Set(['backendError', 'internalError']);

function friendly(reference: MessageRef, base: DbSessionError, original: string, extra: Partial<DbSessionError> = {}): DbSessionError {
  const { serverText: _quoted, ...own } = base;
  return { ...own, message: render(reference), ref: reference, detail: original, ...extra };
}

/**
 * Translates a BigQuery failure into a message of the catalogs (app locale, plus the reference agents render in
 * English), keeping BigQuery's own text as `detail`. The reason stays as the error code.
 */
export function mapBigqueryError(error: unknown, ctx: ErrorContext): DbSessionError {
  if (error instanceof DriverError) return error.info;
  const t = m().mainMisc.bigquery;
  if (error instanceof BigqueryNetworkError) {
    return friendly(ref('mainMisc.bigquery.noResponse'), { message: t.noResponse, code: 'NETWORK' }, 'network');
  }
  if (isAbort(error)) {
    return friendly(ref('mainMisc.driver.cancelled'), { message: m().mainMisc.driver.cancelled, code: 'CANCELLED' }, 'aborted');
  }
  if (error instanceof CaisError) {
    // gcloud could not give a new token (reauth...): keep the code and the reference agents read in English
    return { message: error.message, ...(error.code ? { code: error.code } : {}), ...(error.ref ? { ref: error.ref } : {}) };
  }
  if (!(error instanceof BigqueryApiError)) {
    const message = error instanceof Error ? error.message : m().mainMisc.driver.unknown;
    return { message };
  }
  const { reason, status, apiMessage } = error;
  const base: DbSessionError = { message: apiMessage, code: reason, serverText: true };
  if (reason === 'stopped' && ctx.cancelled) {
    return friendly(ref('mainMisc.driver.cancelled'), base, apiMessage, { code: 'CANCELLED' });
  }
  if (reason === 'bytesBilledLimitExceeded') return friendly(ref('mainMisc.bigquery.error.bytesBilledLimitExceeded'), base, apiMessage);
  if (reason === 'quotaExceeded') return friendly(ref('mainMisc.bigquery.error.quotaExceeded'), base, apiMessage);
  if (reason === 'rateLimitExceeded') return friendly(ref('mainMisc.bigquery.error.rateLimitExceeded'), base, apiMessage);
  if (reason === 'responseTooLarge') return friendly(ref('mainMisc.bigquery.error.responseTooLarge'), base, apiMessage);
  if (reason === 'stopped') return friendly(ref('mainMisc.bigquery.error.stopped'), base, apiMessage);
  if (reason === 'timeout') return friendly(ref('mainMisc.bigquery.error.timeout'), base, apiMessage);
  if (unauthenticatedReasons.has(reason) || status === 401) {
    return friendly(ref('mainMisc.bigquery.error.unauthenticated'), base, apiMessage);
  }
  if (accessReasons.has(reason) || status === 403) {
    return friendly(ref('mainMisc.bigquery.error.accessDenied'), base, apiMessage, { hint: `${t.hintJobUser} ${t.hintDataViewer}` });
  }
  if (reason === 'notFound' || status === 404) return friendly(ref('mainMisc.bigquery.error.notFound'), base, apiMessage);
  if (backendReasons.has(reason) || status >= 500) return friendly(ref('mainMisc.bigquery.error.backendError'), base, apiMessage);
  if (invalidReasons.has(reason) || status === 400) {
    // the message quotes BigQuery's own text, which can hold values of the rows
    return friendly(ref('mainMisc.bigquery.error.invalidQuery', { detail: apiMessage }), base, apiMessage, { serverText: true });
  }
  return base;
}

/** Throws the mapped error as a DriverError (connection-level failures: open, introspect, test). */
export function toDriverError(error: unknown): DriverError {
  if (error instanceof DriverError) return error;
  const info = mapBigqueryError(error, { cancelled: false });
  return new DriverError(info.message, info);
}
