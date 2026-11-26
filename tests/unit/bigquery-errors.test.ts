import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_LOCALE, ref, renderRef, setLocale } from '@shared/i18n';
import { CaisError } from '@main/errors';
import { DriverError } from '@main/drivers/types';
import { BigqueryApiError, BigqueryNetworkError, mapBigqueryError } from '@main/drivers/bigquery/errors';

afterEach(() => setLocale('pt-BR'));

const api = (status: number, reason: string, message = 'original text') => mapBigqueryError(new BigqueryApiError(status, reason, message), { cancelled: false });

describe('BigQuery errors', () => {
  it('turns each reason into a catalog message, keeping the original text and the reason as code', () => {
    const cases: [number, string, RegExp][] = [
      [403, 'accessDenied', /roles\/bigquery\.jobUser/],
      [404, 'notFound', /não encontrou/],
      [400, 'bytesBilledLimitExceeded', /nada foi cobrado/],
      [403, 'quotaExceeded', /cota/],
      [403, 'rateLimitExceeded', /ritmo/],
      [403, 'responseTooLarge', /grande demais/],
      [500, 'backendError', /falhou do lado dele/],
      [503, 'internalError', /falhou do lado dele/],
      [400, 'timeout', /tempo limite/],
      [400, 'stopped', /interrompeu/],
      [401, 'authError', /token/],
    ];
    for (const [status, reason, text] of cases) {
      const info = api(status, reason, 'original text');
      expect(info.message, reason).toMatch(text);
      expect(info.detail, reason).toBe('original text');
      expect(info.ref, reason).toBeDefined();
      expect(info.code, reason).toBe(reason);
    }
  });

  it('quota and rate limit keep their reason even on a 403', () => {
    expect(api(403, 'quotaExceeded').message).not.toMatch(/negou o acesso/);
    expect(api(403, 'rateLimitExceeded').message).not.toMatch(/negou o acesso/);
  });

  it('access denied carries the role hints', () => {
    const info = api(403, 'accessDenied');
    expect(info.hint).toContain('roles/bigquery.jobUser');
    expect(info.hint).toContain('roles/bigquery.dataViewer');
  });

  it('a gcloud failure while renewing the token keeps its code and the reference agents read in English', () => {
    setLocale('en');
    const info = mapBigqueryError(CaisError.of(ref('mainMisc.gcloud.reauth', { account: 'a@b.c' }), 'gcloud-reauth'), { cancelled: false });
    expect(info.code).toBe('gcloud-reauth');
    expect(info.ref).toEqual(ref('mainMisc.gcloud.reauth', { account: 'a@b.c' }));
    expect(info.message).toMatch(/sign in again/);
    expect(renderRef(info.ref!, AGENT_LOCALE)).toMatch(/sign in again/);
    expect(renderRef(info.ref!, 'pt-BR')).toMatch(/precisa entrar de novo/);
  });

  it('what quotes the server text is marked, so an agent is not given it without the result being shared', () => {
    expect(api(400, 'invalidQuery', 'Bad int64 value: segredo').serverText).toBe(true);
    expect(api(400, 'somethingNew', 'Bad value: segredo').serverText).toBe(true);
    expect(api(403, 'accessDenied').serverText).toBeUndefined();
    expect(api(400, 'bytesBilledLimitExceeded').serverText).toBeUndefined();
  });

  it('an invalid query shows what BigQuery said', () => {
    const info = api(400, 'invalidQuery', 'Syntax error: Unexpected end of script at [1:8]');
    expect(info.message).toContain('Syntax error: Unexpected end of script at [1:8]');
    expect(info.code).toBe('invalidQuery');
  });

  it('an unknown reason keeps BigQuery text as it is', () => {
    const info = api(409, 'duplicate', 'Already Exists');
    expect(info.message).toBe('Already Exists');
    expect(info.code).toBe('duplicate');
  });

  it('stopped after a Cancel is a cancellation', () => {
    const info = mapBigqueryError(new BigqueryApiError(400, 'stopped', 'Job execution was cancelled'), { cancelled: true });
    expect(info.code).toBe('CANCELLED');
    expect(info.message).toBe('Query cancelada.');
  });

  it('a network failure says no response from bigquery.googleapis.com, with the VPN and proxy hint', () => {
    const info = mapBigqueryError(new BigqueryNetworkError(), { cancelled: false });
    expect(info.message).toContain('Sem resposta de bigquery.googleapis.com');
    expect(info.message).toMatch(/VPN/);
    expect(info.message).toMatch(/proxy/);
  });

  it('an aborted request is a cancellation', () => {
    const info = mapBigqueryError(Object.assign(new Error('x'), { name: 'AbortError' }), { cancelled: false });
    expect(info.code).toBe('CANCELLED');
  });

  it('a DriverError passes through as it is', () => {
    const inner = { message: 'm', code: 'X' };
    expect(mapBigqueryError(new DriverError('m', inner), { cancelled: false })).toBe(inner);
  });

  it('follows the app locale, and agents read English through the ref', () => {
    setLocale('en');
    const info = api(403, 'accessDenied');
    expect(info.message).toContain('BigQuery denied access');
    expect(renderRef(info.ref!, AGENT_LOCALE)).toContain('BigQuery denied access');
    expect(renderRef(info.ref!, 'pt-BR')).toContain('O BigQuery negou o acesso');
    expect(mapBigqueryError(new BigqueryNetworkError(), { cancelled: false }).message).toContain('No response from bigquery.googleapis.com');
  });
});
