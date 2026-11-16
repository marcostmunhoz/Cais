import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import type { MysqlEnvironment as Environment } from '@shared/model';
import { AgentBroker } from '@main/agents/broker';
import { AgentSessions } from '@main/agents/sessions';
import { mysqlDriver } from '@main/drivers/mysql';
import { CaisError } from '@main/errors';
import { FakeClock, projects } from '../support/agent-fakes';
import { fixture, params, rootConnection } from '../support/fixture';

let broker: AgentBroker;
let sessions: AgentSessions;
let root: any;
const audit: any[] = [];
const outputs: string[] = [];
const f = () => fixture();

const mkEnv = (id: string, name: string, over: Partial<Environment>): Environment => ({
  id, projectId: 'p-api', name, engine: 'mysql', host: f().host, port: f().port, defaultDatabase: f().database, credentialId: `SECRETCRED-${id}`, production: false, ...over,
});

const overrides: Record<string, any> = {
  'e-badpw': { password: 'WRONGPASSWORD-xyz' },
  'e-baduser': { user: 'nosuchuser_secret' },
  'e-credfail': 'cred-error',
};

beforeAll(async () => {
  root = await rootConnection();
  const envs = [
    mkEnv('e-ok', 'ok', {}), mkEnv('e-badpw', 'badpw', {}), mkEnv('e-dead', 'dead', { host: '127.0.0.1', port: 1 }),
    mkEnv('e-localhost-dead', 'ldead', { host: 'localhost', port: 1 }), mkEnv('e-nxdomain', 'nx', { host: 'db-secret-name.invalid' }),
    mkEnv('e-baduser', 'baduser', {}), mkEnv('e-credfail', 'credfail', {}),
  ];
  const clock = new FakeClock();
  sessions = new AgentSessions({
    getDriver: () => mysqlDriver, scheduler: clock,
    resolveConnectParams: async (e) => {
      const o = overrides[e.id];
      if (o === 'cred-error') throw new CaisError('Falha do gcloud: token ya29.SECRETTOKEN para conta x@y.com');
      return params({ host: (e as Environment).host, port: (e as Environment).port, ...(o ?? {}) });
    },
  });
  let n = 0;
  broker = new AgentBroker({
    now: () => clock.now, scheduler: clock, newId: () => `req_${++n}`,
    catalog: { projects: () => projects, environments: () => envs },
    scripts: { list: () => [], get: () => undefined, save: async () => { throw new Error('x'); } },
    executor: sessions, audit: { append: (e) => void audit.push(e) }, getDialect,
    onChange: () => undefined, onNewPending: () => undefined, onScriptsChanged: () => undefined,
  });
  broker.setEnabled(true);
  await root.query('DROP TABLE IF EXISTS sec_s');
  await root.query("CREATE TABLE sec_s (id INT PRIMARY KEY, email VARCHAR(60) UNIQUE, kind ENUM('vip-secret-value','std')) ENGINE=InnoDB");
  await root.query("INSERT INTO sec_s VALUES (1,'ana@secret.com','vip-secret-value')");
});
afterAll(async () => {
  await broker.shutdown();
  await sessions.closeAll();
  await root.end();
});

const run = async (_label: string, fn: () => Promise<any>) => {
  let out: any;
  try { out = await fn(); } catch (e: any) { out = { thrown: e.code, message: e.message, fields: e.fields }; }
  outputs.push(JSON.stringify(out));
  return out;
};
const settle = (id: string) => broker.waitForStatus(id, (s) => s !== 'running' && s !== 'pending_approval', 20000);

describe('error and status output carries no host, port, user, password, credential id, token', () => {
  it('connection failures (query, write, schema, envs, requests, status, audit)', async () => {
    await run('read badpw', () => broker.query({ env: 'e-badpw', sql: 'SELECT 1' }));
    await run('read dead', () => broker.query({ env: 'e-dead', sql: 'SELECT 1' }));
    await run('read localhost-dead', () => broker.query({ env: 'e-localhost-dead', sql: 'SELECT 1' }));
    await run('read nxdomain', () => broker.query({ env: 'e-nxdomain', sql: 'SELECT 1' }));
    await run('read baduser', () => broker.query({ env: 'e-baduser', sql: 'SELECT 1' }));
    await run('read credfail', () => broker.query({ env: 'e-credfail', sql: 'SELECT 1' }));
    for (const env of ['e-credfail', 'e-dead', 'e-nxdomain', 'e-badpw']) await run('schema ' + env, () => broker.schema({ env }));
    for (const env of ['e-dead', 'e-badpw', 'e-nxdomain', 'e-credfail', 'e-baduser']) {
      const w: any = await broker.query({ env, sql: "INSERT INTO sec_s VALUES (9,'z','std')", write: true, reason: 'x' });
      broker.approve(w.request_id, { shareResult: false });
      await settle(w.request_id);
      await run('write ' + env, () => broker.status({ id: w.request_id }));
    }
    await run('db with backtick/SQL', () => broker.query({ env: 'e-ok', sql: 'SELECT DATABASE()', database: 'x`; DROP TABLE sec_s; -- ' }));
    await run('db unknown write', async () => {
      const w2: any = await broker.query({ env: 'e-ok', sql: "INSERT INTO sec_s VALUES (9,'z','std')", write: true, reason: 'x', database: "nope'; DROP TABLE sec_s; --" });
      broker.approve(w2.request_id, { shareResult: true });
      await settle(w2.request_id);
      return broker.status({ id: w2.request_id });
    });
    await run('envs', async () => broker.envs());
    await run('requests', async () => broker.requests(100));
    await run('audit', async () => audit);
    const all = outputs.join('\n');
    const secrets = ['WRONGPASSWORD', 'SECRETCRED', 'SECRETTOKEN', 'ya29', 'x@y.com', 'nosuchuser_secret', 'db-secret-name', '127.0.0.1', 'cais@'];
    for (const s of secrets) expect(all, s).not.toContain(s);
    const [t] = await root.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_NAME='sec_s'");
    expect(Number((t as any)[0].n)).toBe(1);
  });

  it('result withheld: server errors carry no row values; counts only', async () => {
    const dup: any = await broker.query({ env: 'e-ok', sql: "INSERT INTO sec_s VALUES (2,'ana@secret.com','std')", write: true, reason: 'x' });
    broker.approve(dup.request_id, { shareResult: false });
    await settle(dup.request_id);
    const st = JSON.stringify(await broker.status({ id: dup.request_id }));
    expect(st).not.toContain('ana@secret.com');
    expect(st).toContain('ER_DUP_ENTRY');
  });

  it('what the SQL itself returns (CURRENT_USER, @@hostname) is queried data and is not hidden', async () => {
    const res: any = await broker.query({ env: 'e-ok', sql: 'SELECT CURRENT_USER(), @@port' });
    expect(res.status).toBe('succeeded');
    expect(res.results[0].rows[0].length).toBe(2);
  });
});
