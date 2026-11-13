import mysql from 'mysql2';
import type { ConnectParams, MysqlConnectParams } from '../types';

/** The driver is picked by engine; parameters of another engine never get here. */
export function mysqlParams(params: ConnectParams): MysqlConnectParams {
  if (params.engine === 'bigquery') throw new Error('MySQL driver received BigQuery parameters');
  return params;
}

export function buildConnectionOptions(params: MysqlConnectParams): mysql.ConnectionOptions {
  const options: mysql.ConnectionOptions = {
    host: params.host,
    port: params.port,
    user: params.user,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    jsonStrings: true,
    multipleStatements: false,
    charset: 'utf8mb4',
    connectTimeout: 10000,
    rowsAsArray: true,
    // a silent drop (VPN) must surface as an error instead of a hang
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    ...(params.database ? { database: params.database } : {}),
    ...(params.password !== undefined ? { password: params.password } : {}),
  };
  if (params.tls === 'required') {
    // ssl-mode=REQUIRED: encrypt, do not verify the certificate (Cloud SQL uses its own CA).
    options.ssl = { rejectUnauthorized: false };
  }
  if (params.authPlugin === 'mysql_clear_password') {
    const token = params.password ?? '';
    options.authPlugins = {
      mysql_clear_password: () => () => Buffer.from(token + '\0'),
    };
  }
  return options;
}

export function connect(params: MysqlConnectParams): Promise<mysql.Connection> {
  return new Promise((resolve, reject) => {
    const conn = mysql.createConnection(buildConnectionOptions(params));
    conn.once('error', reject);
    conn.connect((error) => {
      conn.removeListener('error', reject);
      if (error) {
        conn.destroy();
        reject(error);
        return;
      }
      resolve(conn);
    });
  });
}

export function query(conn: mysql.Connection, sql: string): Promise<{ rows: unknown[]; fields: mysql.FieldPacket[] }> {
  return new Promise((resolve, reject) => {
    conn.query({ sql, rowsAsArray: true }, (error, result, fields) => {
      if (error) reject(error);
      else resolve({ rows: Array.isArray(result) ? (result as unknown[]) : [], fields: (fields ?? []) as mysql.FieldPacket[] });
    });
  });
}

export function closeQuietly(conn: mysql.Connection): Promise<void> {
  return new Promise((resolve) => {
    try {
      conn.end(() => resolve());
    } catch {
      conn.destroy();
      resolve();
    }
  });
}
