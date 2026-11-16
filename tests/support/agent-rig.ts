import type mysql from 'mysql2/promise';
import mysqlP from 'mysql2/promise';
import { getDialect } from '@shared/dialects/registry';
import type { MysqlEnvironment as Environment } from '@shared/model';
import { AgentBroker } from '@main/agents/broker';
import { AgentSessions } from '@main/agents/sessions';
import { mysqlDriver } from '@main/drivers/mysql';
import { FakeClock, projects } from './agent-fakes';
import { fixture, observer, params, rootConnection } from './fixture';

export { fixture, observer, rootConnection, mysqlP };
export type { mysql };

export interface Rig {
  clock: FakeClock;
  broker: AgentBroker;
  sessions: AgentSessions;
  audit: any[];
  envs: Environment[];
  catalogProjects: typeof projects;
}

export function makeRig(opts: { envs?: Environment[]; user?: string; password?: string } = {}): Rig {
  const f = fixture();
  const base: Environment = { id: 'e-dev', projectId: 'p-api', name: 'dev', engine: 'mysql', host: f.host, port: f.port, defaultDatabase: f.database, credentialId: 'c', production: false };
  const envs = opts.envs ?? [base, { ...base, id: 'e-pro', name: 'pro', production: true }];
  const clock = new FakeClock();
  const sessions = new AgentSessions({
    getDriver: () => mysqlDriver,
    resolveConnectParams: async (e) => params({ host: (e as Environment).host, port: (e as Environment).port, ...(e.defaultDatabase ? { database: e.defaultDatabase } : {}), ...(opts.user ? { user: opts.user, password: opts.password ?? '' } : {}) }),
    scheduler: clock,
  });
  let seq = 0;
  const audit: any[] = [];
  const broker = new AgentBroker({
    now: () => clock.now, scheduler: clock, newId: () => `req_${++seq}`,
    catalog: { projects: () => projects, environments: () => envs },
    scripts: { list: () => [], get: () => undefined, save: async () => { throw new Error('unused'); } },
    executor: sessions, audit: { append: (e) => void audit.push(e) },
    getDialect, onChange: () => undefined, onNewPending: () => undefined, onScriptsChanged: () => undefined,
  });
  broker.setEnabled(true);
  return { clock, broker, sessions, audit, envs, catalogProjects: projects };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
