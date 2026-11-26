import { getDialect } from '@shared/dialects/registry';
import type { MysqlEnvironment as Environment, Project, SavedScript } from '@shared/model';
import type { SchemaTree, StatementResult } from '@shared/results';
import { AgentBroker } from '@main/agents/broker';
import type { AuditEntry } from '@main/agents/audit';
import type { AgentExecutor, PreparedStatement, RunArgs, RunOutcome, Scheduler, WriteRun } from '@main/agents/sessions';

/** Manual clock + scheduler: `advance` runs the timers that fall due, in order. */
export class FakeClock implements Scheduler {
  now = 1_000_000;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].fn();
      await flush();
    }
    this.now = target;
    await flush();
  }
  get pendingTimers(): number {
    return this.timers.size;
  }
}

/** Lets promise continuations run. */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

export const result = (over: Partial<StatementResult> = {}): StatementResult => ({
  index: 0, sql: 'x', kind: 'read', verb: 'SELECT', durationMs: 3, ...over,
});

export class FakeExecutor implements AgentExecutor {
  reads: RunArgs[] = [];
  writes: RunArgs[] = [];
  commits = 0;
  rollbacks = 0;
  closeAllCalls = 0;
  changed: string[] = [];
  readOutcome: RunOutcome | (() => Promise<RunOutcome>) = {
    results: [result({ columns: [{ name: 'id', type: 'int' }, { name: 'email', type: 'varchar' }], rows: [[1, 'ana@x.com'], [2, 'bia@x.com']] })],
  };
  rollbackIncomplete = false;
  writeOutcome: { results: StatementResult[]; open: boolean; error?: RunOutcome['error'] } = {
    results: [result({ kind: 'write', verb: 'UPDATE', affectedRows: 2 })],
    open: true,
  };
  tree: SchemaTree = {
    foreignKeysComplete: true,
    databases: [
      { name: 'app', tables: [{ name: 'cards', type: 'table', columns: [{ name: 'id', type: 'int', nullable: false, key: 'PRI' }] }] },
      { name: 'other', tables: [] },
    ],
  };
  /** The dry run's answer (BigQuery only; the broker never asks for it on MySQL). */
  prepared: PreparedStatement[] | ((n: number) => PreparedStatement[]) | undefined;
  prepareCalls: RunArgs['statements'][] = [];
  async prepare(_env: Environment, args: { statements: RunArgs['statements'] }): Promise<PreparedStatement[] | undefined> {
    this.prepareCalls.push(args.statements);
    if (typeof this.prepared === 'function') return this.prepared(args.statements.length);
    return this.prepared;
  }
  async schema(): Promise<SchemaTree> {
    return this.tree;
  }
  async runRead(_env: Environment, args: RunArgs): Promise<RunOutcome> {
    this.reads.push(args);
    return typeof this.readOutcome === 'function' ? this.readOutcome() : this.readOutcome;
  }
  async runWrite(_env: Environment, args: RunArgs): Promise<WriteRun> {
    this.writes.push(args);
    const o = this.writeOutcome;
    return {
      results: o.results,
      ...(o.error ? { error: o.error } : {}),
      open: o.open,
      commit: async () => void this.commits++,
      rollback: async () => {
        this.rollbacks++;
        return { incomplete: this.rollbackIncomplete };
      },
      close: async () => undefined,
    };
  }
  async environmentChanged(id: string): Promise<void> {
    this.changed.push(id);
  }
  async closeAll(): Promise<void> {
    this.closeAllCalls++;
  }
}

export const projects: Project[] = [{ id: 'p-api', name: 'api', order: 0 }];
export const dev: Environment = {
  id: 'e-dev', projectId: 'p-api', name: 'dev', engine: 'mysql', host: 'db.internal.example', port: 3306,
  defaultDatabase: 'app', credentialId: 'cred-secret-id', production: false,
};
export const pro: Environment = { ...dev, id: 'e-pro', name: 'pro', production: true };

export function makeBroker(overrides: { executor?: FakeExecutor } = {}) {
  const clock = new FakeClock();
  const executor = overrides.executor ?? new FakeExecutor();
  const audit: AuditEntry[] = [];
  const scripts: SavedScript[] = [];
  const events = { changes: 0, newPending: [] as string[], scriptsChanged: 0 };
  const envs: Environment[] = [{ ...dev }, { ...pro }];
  /** This broker's own copy: a test may rename a project. */
  const projectList: Project[] = projects.map((p) => ({ ...p }));
  /** Set ok = false to make the trail fail (append returns false, healthy() is false). */
  const trail = { ok: true };
  let seq = 0;
  const broker = new AgentBroker({
    now: () => clock.now,
    scheduler: clock,
    newId: () => `req_${++seq}`,
    catalog: { projects: () => projectList.map((p) => ({ ...p })), environments: () => envs.map((e) => ({ ...e })) },
    scripts: {
      list: () => scripts,
      get: (id) => scripts.find((s) => s.id === id),
      save: async (input, by) => {
        if (scripts.some((s) => s.projectId === input.projectId && s.name.toLowerCase() === input.name.toLowerCase())) {
          const { CaisError } = await import('@main/errors');
          throw new CaisError('A script with this name already exists in api.', 'duplicate-name');
        }
        const s: SavedScript = {
          id: `s${scripts.length + 1}`, projectId: input.projectId, name: input.name, sql: input.sql,
          ...(input.database ? { database: input.database } : {}), createdAt: clock.now, updatedAt: clock.now, createdBy: by,
        };
        scripts.push(s);
        return s;
      },
    },
    executor,
    audit: {
      append: (e) => {
        if (!trail.ok) return false;
        audit.push(e);
        return true;
      },
      healthy: () => trail.ok,
    },
    getDialect,
    onChange: () => void events.changes++,
    onNewPending: (v) => void events.newPending.push(v.id),
    onScriptsChanged: () => void events.scriptsChanged++,
  });
  broker.setEnabled(true);
  return { broker, clock, executor, audit, scripts, events, envs, projects: projectList, trail };
}
