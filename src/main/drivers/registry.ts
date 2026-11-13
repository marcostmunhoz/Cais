import type { Engine } from '@shared/model';
import type { Driver } from './types';
import { mysqlDriver } from './mysql';
import { createBigqueryDriver, type BigqueryDriverOptions } from './bigquery';

let drivers: Record<Engine, Driver> = {
  mysql: mysqlDriver,
  bigquery: createBigqueryDriver(),
};

/** Called once at start by the app: BigQuery goes out through Electron's `net.fetch`, and a test hook may point it at a fake server. */
export function configureDrivers(options: { bigquery?: BigqueryDriverOptions }): void {
  drivers = { ...drivers, bigquery: createBigqueryDriver(options.bigquery) };
}

export function getDriver(engine: Engine): Driver {
  return drivers[engine];
}
