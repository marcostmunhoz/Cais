import mysql from 'mysql2/promise';
import type { MysqlConnectParams } from '@main/drivers/types';

export interface MysqlFixture {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  name: string;
  rootPassword: string;
}

export function fixture(): MysqlFixture {
  const raw = process.env.CAIS_TEST_MYSQL;
  if (!raw) throw new Error('CAIS_TEST_MYSQL is not set: the MySQL container did not start');
  return JSON.parse(raw) as MysqlFixture;
}

export function params(overrides: Partial<MysqlConnectParams> = {}): MysqlConnectParams {
  const f = fixture();
  return { host: f.host, port: f.port, user: f.user, password: f.password, database: f.database, tls: 'off', ...overrides };
}

/** root connection, for setup that needs privileges (stored functions, global variables). */
export async function rootConnection(): Promise<mysql.Connection> {
  const f = fixture();
  return mysql.createConnection({ host: f.host, port: f.port, user: 'root', password: f.rootPassword, database: f.database });
}

/** An independent plain connection used to observe what other sessions did. */
export async function observer(): Promise<mysql.Connection> {
  const f = fixture();
  return mysql.createConnection({ host: f.host, port: f.port, user: f.user, password: f.password, database: f.database });
}
