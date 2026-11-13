import type { ConnectParams, Driver } from '../types';
import { DriverError } from '../types';
import { closeQuietly, connect, query } from './connection';
import { mapMysqlError } from './errors';
import { readSchema } from './introspect';
import { openMysqlSession } from './session';

async function withShortConnection<T>(
  params: ConnectParams,
  fn: (conn: Awaited<ReturnType<typeof connect>>) => Promise<T>,
): Promise<T> {
  const ctx = {
    iam: params.authPlugin === 'mysql_clear_password',
    host: params.host,
    port: params.port,
    cancelled: false,
  };
  let conn: Awaited<ReturnType<typeof connect>>;
  try {
    conn = await connect(params);
  } catch (error) {
    const info = mapMysqlError(error, ctx);
    throw new DriverError(info.message, info);
  }
  try {
    return await fn(conn);
  } catch (error) {
    const info = mapMysqlError(error, ctx);
    throw new DriverError(info.message, info);
  } finally {
    await closeQuietly(conn);
  }
}

export const mysqlDriver: Driver = {
  engine: 'mysql',
  open: (params) => openMysqlSession(params),
  introspect: (params) => withShortConnection(params, readSchema),
  test: (params) =>
    withShortConnection(params, async (conn) => {
      const { rows } = await query(conn, 'SELECT VERSION()');
      return { serverVersion: String((rows[0] as unknown[])[0]) };
    }),
};
