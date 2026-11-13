import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';

export interface TestMysql {
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  rootPassword: string;
  stop(): void;
}

const IMAGE = 'mysql:8.4';
const PREFIX = 'cais-test-';

const docker = (...args: string[]): string =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Removes leftovers from crashed runs. Only touches containers named cais-test-*. */
export function removeLeftovers(): void {
  const ids = docker('ps', '-aq', '--filter', `name=${PREFIX}`);
  if (ids) docker('rm', '-f', ...ids.split('\n'));
}

async function waitReady(port: number, user: string, password: string, database: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const conn = await mysql.createConnection({ host: '127.0.0.1', port, user, password, database, connectTimeout: 2000 });
      await conn.query('SELECT 1');
      await conn.end();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`MySQL test container did not become ready: ${String(lastError)}`);
}

/** Starts a throwaway mysql:8.4 on a random host port (never 3306). */
export async function startMysql(): Promise<TestMysql> {
  removeLeftovers();
  const name = `${PREFIX}${randomBytes(4).toString('hex')}`;
  const password = randomBytes(9).toString('hex');
  const rootPassword = randomBytes(9).toString('hex');
  const user = 'cais';
  const database = 'cais_test';
  docker(
    'run', '-d', '--name', name,
    '-e', `MYSQL_ROOT_PASSWORD=${rootPassword}`,
    '-e', `MYSQL_USER=${user}`, '-e', `MYSQL_PASSWORD=${password}`, '-e', `MYSQL_DATABASE=${database}`,
    '-p', '127.0.0.1::3306',
    '--tmpfs', '/var/lib/mysql',
    IMAGE,
  );
  const stop = (): void => {
    try {
      docker('rm', '-f', name);
    } catch {
      // already gone
    }
  };
  try {
    const mapping = docker('port', name, '3306/tcp').split('\n')[0]!;
    const port = Number(mapping.slice(mapping.lastIndexOf(':') + 1));
    if (!port || port === 3306) throw new Error(`Unexpected published port: ${mapping}`);
    await waitReady(port, user, password, database);
    return { name, host: '127.0.0.1', port, user, password, database, rootPassword, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
