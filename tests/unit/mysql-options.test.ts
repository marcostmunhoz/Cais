import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_LOCALE, renderRef, setLocale } from '@shared/i18n';
import { buildConnectionOptions } from '@main/drivers/mysql/connection';
import { mapMysqlError } from '@main/drivers/mysql/errors';
import { toCell } from '@main/drivers/mysql/values';

describe('buildConnectionOptions', () => {
  it('uses the fixed mysql2 options', () => {
    const o = buildConnectionOptions({ host: 'h', port: 3307, user: 'u', password: 'p', database: 'd', tls: 'off' });
    expect(o).toMatchObject({
      host: 'h', port: 3307, user: 'u', password: 'p', database: 'd',
      dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false,
      multipleStatements: false, charset: 'utf8mb4', connectTimeout: 10000, rowsAsArray: true,
    });
    expect(o.ssl).toBeUndefined();
    expect(o.authPlugins).toBeUndefined();
    expect(o.enableKeepAlive).toBe(true);
    expect(o.keepAliveInitialDelay).toBe(10000);
  });

  it('IAM: TLS without verification and the clear-text plugin sending token + NUL', () => {
    const o = buildConnectionOptions({
      host: 'h', port: 3306, user: 'maria', password: 'TOKEN', authPlugin: 'mysql_clear_password', tls: 'required',
    });
    expect(o.ssl).toEqual({ rejectUnauthorized: false });
    const factory = o.authPlugins!.mysql_clear_password!;
    const buf = factory({ connection: {} as never, command: {} as never })({} as Buffer) as Buffer;
    expect(buf.equals(Buffer.from('TOKEN\0'))).toBe(true);
  });
});

describe('mapMysqlError', () => {
  const ctx = { iam: false, host: '10.0.0.5', port: 3306, cancelled: false };
  it.each(['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED'])('%s asks about the VPN', (code) => {
    const e = mapMysqlError({ code, message: 'x' }, ctx);
    expect(e.message).toBe('Sem resposta de 10.0.0.5:3306. A VPN está ligada?');
    expect(e.code).toBe(code);
    expect(e.detail).toBe('x');
  });
  it('1045 differs for password and IAM', () => {
    expect(mapMysqlError({ errno: 1045, code: 'ER_ACCESS_DENIED_ERROR', message: 'Access denied' }, ctx).message).toBe(
      'Usuário ou senha recusados.',
    );
    expect(mapMysqlError({ errno: 1045, message: 'Access denied' }, { ...ctx, iam: true }).message).toContain(
      'Login IAM recusado',
    );
  });
  it('1792 and 1317', () => {
    expect(mapMysqlError({ errno: 1792, message: 'read only' }, ctx).message).toBe('A sessão está em somente leitura.');
    expect(mapMysqlError({ errno: 1317, message: 'interrupted' }, { ...ctx, cancelled: true }).message).toBe('Query cancelada.');
    expect(mapMysqlError({ errno: 1317, message: 'interrupted' }, ctx).message).toBe('interrupted');
  });
  it('keeps the original for anything else, with code, errno and sqlState', () => {
    const e = mapMysqlError({ errno: 1064, code: 'ER_PARSE_ERROR', sqlState: '42000', sqlMessage: 'syntax' }, ctx);
    expect(e).toEqual({ message: 'syntax', code: 'ER_PARSE_ERROR', errno: 1064, sqlState: '42000' });
  });
});

describe('toCell', () => {
  it('maps values', () => {
    expect(toCell(null)).toBeNull();
    expect(toCell('a')).toBe('a');
    expect(toCell(3)).toBe(3);
    expect(toCell(10n)).toBe('10');
    expect(toCell(Buffer.from([1, 2, 255]))).toEqual({ kind: 'binary', hex: '0102ff', length: 3 });
  });
  it('truncates binary hex at 256 bytes but keeps the real length', () => {
    const c = toCell(Buffer.alloc(1000, 1)) as { hex: string; length: number };
    expect(c.hex).toHaveLength(512);
    expect(c.length).toBe(1000);
  });
});

describe('mapMysqlError in English', () => {
  afterEach(() => setLocale('pt-BR'));
  const ctx = { iam: false, host: '10.0.0.5', port: 3306, cancelled: false };

  it('friendly messages follow the app locale, the server text never changes, the ref renders in pt-BR', () => {
    setLocale('en');
    const e = mapMysqlError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }, ctx);
    expect(e.message).toBe('No response from 10.0.0.5:3306. Is the VPN on?');
    expect(e.detail).toBe('connect ECONNREFUSED');
    expect(renderRef(e.ref!, AGENT_LOCALE)).toBe('Sem resposta de 10.0.0.5:3306. A VPN está ligada?');
    expect(mapMysqlError({ errno: 1317, message: 'interrupted' }, { ...ctx, cancelled: true }).message).toBe('Query cancelled.');
    expect(mapMysqlError({ errno: 1045, message: 'Access denied' }, ctx).message).toBe('User or password refused.');
    const raw = mapMysqlError({ code: 'ER_PARSE_ERROR', errno: 1064, sqlMessage: 'You have an error in your SQL syntax' }, ctx);
    expect(raw).toEqual({ message: 'You have an error in your SQL syntax', code: 'ER_PARSE_ERROR', errno: 1064 });
  });
});
