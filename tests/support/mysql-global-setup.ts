import { startMysql, type TestMysql } from './mysql-container';

let container: TestMysql | undefined;

export async function setup(): Promise<void> {
  container = await startMysql();
  process.env.CAIS_TEST_MYSQL = JSON.stringify({
    host: container.host,
    port: container.port,
    user: container.user,
    password: container.password,
    database: container.database,
    name: container.name,
    rootPassword: container.rootPassword,
  });
}

export async function teardown(): Promise<void> {
  container?.stop();
}
