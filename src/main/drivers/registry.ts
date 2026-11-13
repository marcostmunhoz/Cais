import type { Engine } from '@shared/model';
import type { Driver } from './types';
import { mysqlDriver } from './mysql';

const drivers: Record<Engine, Driver> = {
  mysql: mysqlDriver,
};

export function getDriver(engine: Engine): Driver {
  return drivers[engine];
}
