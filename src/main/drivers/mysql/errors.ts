import { m, ref, render, type MessageRef } from '@shared/i18n';
import type { DbSessionError } from '../types';

export interface ErrorContext {
  iam: boolean;
  host: string;
  port: number;
  cancelled: boolean;
}

const NETWORK_CODES = new Set(['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED']);
const LOST_CODES = new Set(['ECONNRESET', 'EPIPE', 'PROTOCOL_CONNECTION_LOST']);

interface RawError {
  code?: string;
  errno?: number;
  sqlState?: string;
  sqlMessage?: string;
  message?: string;
  fatal?: boolean;
}

/**
 * Translates mysql2 errors into friendly messages in the app locale, keeping the original code and message
 * (the server's own text is never translated). A friendly message carries its `ref`, so agents get it in English.
 */
export function mapMysqlError(error: unknown, ctx: ErrorContext): DbSessionError {
  const raw = (error ?? {}) as RawError;
  const original = String(raw.sqlMessage ?? raw.message ?? m().mainMisc.driver.unknown);
  const base: DbSessionError = {
    message: original,
    ...(raw.code ? { code: raw.code } : {}),
    ...(typeof raw.errno === 'number' ? { errno: raw.errno } : {}),
    ...(raw.sqlState ? { sqlState: raw.sqlState } : {}),
    ...(raw.fatal ? { fatal: true } : {}),
  };
  const friendly = (reference: MessageRef, extra: Partial<DbSessionError> = {}): DbSessionError => ({
    ...base,
    message: render(reference),
    ref: reference,
    detail: original,
    ...extra,
  });

  if (raw.code && NETWORK_CODES.has(raw.code)) {
    return friendly(ref('mainMisc.driver.noResponse', { host: ctx.host, port: ctx.port }));
  }
  if (raw.errno === 1045) {
    return friendly(ctx.iam ? ref('mainMisc.driver.iamRefused') : ref('mainMisc.driver.passwordRefused'));
  }
  if (raw.errno === 1792) return friendly(ref('mainMisc.driver.readOnly'));
  if (raw.errno === 1317 && ctx.cancelled) return friendly(ref('mainMisc.driver.cancelled'), { code: 'CANCELLED' });
  if (raw.fatal || (raw.code && LOST_CODES.has(raw.code))) {
    return friendly(ref('mainMisc.driver.lost'), { fatal: true });
  }
  return base;
}
