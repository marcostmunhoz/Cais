// Agent access per environment, autonomous writes, the trail of every execution and the integrity seal.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import { agentLevelOf, agentLevelsFor, type MysqlEnvironment as Environment } from '@shared/model';
import type { StatementResult } from '@shared/results';
import { autoCommitBlocker } from '@main/agents/broker';
import { decide, type ClassifiedStatement } from '@main/agents/policy';
import type { DbSession, DbSessionError, Driver } from '@main/drivers/types';
import { SessionManager, type PersonTrailLine } from '@main/sessions';
import { CatalogStore } from '@main/store/catalog';
import { Seal } from '@main/store/seal';
import { SettingsStore } from '@main/store/settings';
import { FakeVault, type Vault } from '@main/store/vault';
import { Trail } from '@main/trail';
import { FakeClock, flush, makeBroker, result } from '../support/agent-fakes';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync('/tmp/cais-levels-');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const dialect = getDialect('mysql');
const plan = (sql: string): ClassifiedStatement[] =>
  dialect.splitStatements(sql).map((s) => ({ text: s.text, c: dialect.classify(s.text), ids: dialect.identifiers(s.text) }));
const base = { pendingCount: 0, grantActive: false, rules: dialect.agentRules };

describe('policy: the level of the environment', () => {
  const read = plan('SELECT 1');
  const write = plan('UPDATE t SET a = 1 WHERE id = 1');
  it('approve-all: reads and writes ask, outside production too', () => {
    expect(decide({ ...base, mode: 'read', production: false, level: 'approve-all', statements: read, reason: 'r' }).action).toBe('approve');
    expect(decide({ ...base, mode: 'read', production: false, level: 'approve-all', statements: read }).action).toBe('refuse'); // needs --reason
    expect(decide({ ...base, mode: 'write', production: false, level: 'approve-all', statements: write, reason: 'r' }).action).toBe('approve');
  });
  it('free-reads: reads run, writes ask (the default outside production, also without a level)', () => {
    for (const level of ['free-reads', undefined] as const) {
      expect(decide({ ...base, mode: 'read', production: false, ...(level ? { level } : {}), statements: read }).action).toBe('run');
      expect(decide({ ...base, mode: 'write', production: false, ...(level ? { level } : {}), statements: write, reason: 'r' }).action).toBe('approve');
    }
  });
  it('free-reads-writes: writes run, still with --reason', () => {
    expect(decide({ ...base, mode: 'write', production: false, level: 'free-reads-writes', statements: write, reason: 'r' }).action).toBe('run');
    const noReason = decide({ ...base, mode: 'write', production: false, level: 'free-reads-writes', statements: write });
    expect(noReason).toMatchObject({ action: 'refuse', code: 'reason_required' });
  });
  it('production: approve-all unless the person chose free reads; writes always ask; a grant frees reads only', () => {
    expect(decide({ ...base, mode: 'write', production: true, level: 'free-reads-writes', statements: write, reason: 'r' }).action).toBe('approve');
    expect(decide({ ...base, mode: 'read', production: true, level: 'free-reads-writes', statements: read, reason: 'r' }).action).toBe('approve');
    expect(decide({ ...base, mode: 'read', production: true, statements: read, reason: 'r' }).action).toBe('approve'); // no level: approve-all
    expect(decide({ ...base, grantActive: true, mode: 'read', production: true, statements: read }).action).toBe('run');
    expect(decide({ ...base, grantActive: true, mode: 'write', production: true, statements: write, reason: 'r' }).action).toBe('approve');
    // free reads in production, by the person's choice: reads run, writes still ask, and a trail down still stops reads
    expect(decide({ ...base, mode: 'read', production: true, level: 'free-reads', statements: read }).action).toBe('run');
    expect(decide({ ...base, mode: 'write', production: true, level: 'free-reads', statements: write, reason: 'r' }).action).toBe('approve');
    expect(decide({ ...base, mode: 'read', production: true, level: 'free-reads', trailOk: false, statements: read, reason: 'r' }).action).toBe('approve');
    expect(decide({ ...base, mode: 'read', production: true, level: 'free-reads', statements: plan('UPDATE cards SET a = 1 WHERE id = 1') }).action).toBe('refuse');
    expect(agentLevelOf({ production: true, agentLevel: 'free-reads-writes' })).toBe('approve-all');
    expect(agentLevelOf({ production: true })).toBe('approve-all');
    expect(agentLevelOf({ production: true, agentLevel: 'free-reads' })).toBe('free-reads');
    expect(agentLevelsFor(true)).toEqual(['approve-all', 'free-reads']);
    expect(agentLevelsFor(false)).toEqual(['approve-all', 'free-reads', 'free-reads-writes']);
  });
  it('the refusals do not change with the level: DDL, admin, system schemas', () => {
    for (const sql of ['DROP TABLE t', 'SET GLOBAL max_connections = 1', 'UPDATE mysql.user SET x = 1 WHERE 1 = 0', 'CALL p()', 'COMMIT']) {
      expect(decide({ ...base, mode: 'write', production: false, level: 'free-reads-writes', statements: plan(sql), reason: 'r' }).action).toBe('refuse');
    }
  });
  it('without the trail nothing runs without the person', () => {
    expect(decide({ ...base, mode: 'read', production: false, level: 'free-reads', trailOk: false, statements: read, reason: 'r' }).action).toBe('approve');
    expect(decide({ ...base, mode: 'write', production: false, level: 'free-reads-writes', trailOk: false, statements: write, reason: 'r' }).action).toBe('approve');
  });
});

describe('broker: autonomous writes', () => {
  const free = () => {
    const h = makeBroker();
    h.envs[0]!.agentLevel = 'free-reads-writes';
    return h;
  };

  it('run in a transaction and commit by themselves; the agent sees the result and auto_commit', async () => {
    const h = free();
    const res = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET blocked = 1 WHERE id = 7', write: true, reason: 'incidente 42', client: 'Claude Code' })) as any;
    expect(res).toMatchObject({ status: 'committed', auto_commit: true, decided_by: 'policy', mode: 'write' });
    // the field order is part of the reply: decided_by and auto_commit sit right after mode
    expect(Object.keys(res)).toEqual(['request_id', 'status', 'environment', 'production', 'mode', 'decided_by', 'auto_commit', 'results']);
    expect((h.broker.requests(5) as any).requests[0]).toMatchObject({ decided_by: 'policy', auto_commit: true });
    expect(res.results[0].affected_rows).toBe(2);
    expect(h.executor.writes).toHaveLength(1);
    expect(h.executor.commits).toBe(1);
    expect(h.events.newPending).toEqual([]);
    expect(h.audit.map((a) => a.state)).toEqual(['running', 'committed']);
    expect(h.audit[1]).toMatchObject({ decidedBy: 'policy', secondDecidedBy: 'policy', autoCommit: true, reason: 'incidente 42', statements: [{ verb: 'UPDATE', affectedRows: 2 }] });
    const view = h.broker.snapshot().recent[0]!;
    expect(view).toMatchObject({ autoCommit: true, secondDecidedBy: 'policy', decidedBy: 'policy', status: 'committed' });
  });

  it('a write with an alert (no WHERE) waits for the person, with the reason why', async () => {
    const h = free();
    const res = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET blocked = 1', write: true, reason: 'r' })) as any;
    expect(res.status).toBe('pending_approval');
    expect(res.approval_reason).toContain('has an alert');
    expect(h.executor.writes).toHaveLength(0);
    expect(h.broker.snapshot().pending[0]!.approvalReason).toContain('alerta');
    expect(h.broker.snapshot().pending[0]!.autoCommit).toBeUndefined();
    // approved by the person: the second decision stays with the person too
    h.broker.approve(res.request_id, { shareResult: true });
    await flush();
    expect(h.broker.snapshot().awaitingCommit).toHaveLength(1);
    expect(h.executor.commits).toBe(0);
  });

  it('a write to a table the Rollback cannot undo waits for the person', async () => {
    const h = free();
    h.executor.tree = { foreignKeysComplete: true, databases: [{ name: 'app', tables: [{ name: 'logs', type: 'table', engine: 'MyISAM', columns: [] }] }] };
    const res = (await h.broker.query({ env: 'api/dev', sql: 'DELETE FROM logs WHERE id = 1', write: true, reason: 'r' })) as any;
    expect(res.status).toBe('pending_approval');
    expect(h.executor.writes).toHaveLength(0);
  });

  it('without metadata (the schema fails) it waits for the person', async () => {
    const h = free();
    h.executor.schema = async () => {
      throw new Error('down');
    };
    const res = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    expect(res.status).toBe('pending_approval');
  });

  it('more than 1.000 affected rows: no automatic commit, the person decides, and is told', async () => {
    const h = free();
    h.executor.writeOutcome = { results: [result({ kind: 'write', verb: 'UPDATE', affectedRows: 600 }), result({ kind: 'write', verb: 'DELETE', affectedRows: 401 })], open: true };
    const res = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET a = 1 WHERE id > 0; DELETE FROM cards WHERE id < 0', write: true, reason: 'r' })) as any;
    expect(res.status).toBe('awaiting_commit');
    expect(res.commit_reason).toContain('1,001');
    expect(res.decided_by).toBe('policy');
    expect(res).not.toHaveProperty('auto_commit');
    expect(h.executor.commits).toBe(0);
    expect(h.events.newPending).toHaveLength(1);
    expect(h.broker.snapshot().awaitingCommit[0]!.commitReason).toContain('1.000');
    // and the usual 2-minute rollback still holds
    await h.clock.advance(120_000);
    expect(h.executor.rollbacks).toBe(1);
  });

  it('a warning from the server: no automatic commit', async () => {
    const h = free();
    h.executor.writeOutcome = { results: [result({ kind: 'write', verb: 'INSERT', affectedRows: 1, warnings: 1 })], open: true };
    const res = (await h.broker.query({ env: 'api/dev', sql: "INSERT INTO cards (id) VALUES (1)", write: true, reason: 'r' })) as any;
    expect(res.status).toBe('awaiting_commit');
    expect(res.commit_reason).toContain('warning');
  });

  it('a failed write rolls back as before and does not commit', async () => {
    const h = free();
    h.executor.writeOutcome = { results: [result({ kind: 'write', verb: 'UPDATE', error: { message: 'x', code: 'ER_DUP_ENTRY' } })], open: false, error: { message: 'x', code: 'ER_DUP_ENTRY' } };
    const res = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    expect(res.status).toBe('failed');
    expect(h.executor.commits).toBe(0);
  });

  it('production never writes by itself, even with the level set by hand', async () => {
    const h = makeBroker();
    h.envs[1]!.agentLevel = 'free-reads-writes';
    const res = (await h.broker.query({ env: 'api/pro', sql: 'UPDATE cards SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    expect(res.status).toBe('pending_approval');
    expect(h.executor.writes).toHaveLength(0);
  });

  it('production with free reads: a read runs by itself, on the trail; a write waits, runs nothing', async () => {
    const h = makeBroker();
    h.envs[1]!.agentLevel = 'free-reads';
    const read = (await h.broker.query({ env: 'api/pro', sql: 'SELECT 1' })) as any;
    expect(read.status).toBe('succeeded');
    expect(h.audit.find((e: any) => e.id === read.request_id && e.state === 'succeeded')).toMatchObject({ production: true, mode: 'read', decidedBy: 'policy' });
    expect(h.broker.envs().environments.find((e) => e.slug === 'api/pro')).toMatchObject({ agent_access: 'free-reads' });
    const res = (await h.broker.query({ env: 'api/pro', sql: 'UPDATE cards SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    expect(res.status).toBe('pending_approval');
    expect(h.executor.writes).toHaveLength(0);
  });

  it('the level is read again after the schema loads: a stricter level wins', async () => {
    const h = free();
    const original = h.executor.schema.bind(h.executor);
    h.executor.schema = async () => {
      h.envs[0]!.agentLevel = 'free-reads'; // the person changed it meanwhile
      return original();
    };
    const res = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    expect(res.status).toBe('pending_approval');
    expect(h.executor.writes).toHaveLength(0);
  });

  it('the level changed while the write ran: no automatic commit, the person decides', async () => {
    const h = free();
    const original = h.executor.runWrite.bind(h.executor);
    h.executor.runWrite = async (env, args) => {
      const run = await original(env, args);
      h.envs[0]!.agentLevel = 'approve-all';
      return run;
    };
    const res = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    expect(res.status).toBe('awaiting_commit');
    expect(res.commit_reason).toContain('changed');
    expect(h.executor.commits).toBe(0);
  });

  it('when the trail cannot be written, reads and writes wait for the person', async () => {
    const h = free();
    h.trail.ok = false;
    const r = (await h.broker.query({ env: 'api/dev', sql: 'SELECT 1', reason: 'r' })) as any;
    expect(r.status).toBe('pending_approval');
    const w = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    expect(w.status).toBe('pending_approval');
    expect(h.executor.reads).toHaveLength(0);
    expect(h.executor.writes).toHaveLength(0);
    // once the trail is back, the person approves and commits: it went through her, and the Commit was not automatic
    h.trail.ok = true;
    h.broker.approve(w.request_id, { shareResult: true });
    await flush();
    await h.broker.commit(w.request_id);
    expect(await h.broker.status({ id: w.request_id })).toMatchObject({ status: 'committed', decided_by: 'person', auto_commit: false });
  });

  it('stopped by the limits, then committed by the person: decided_by policy, auto_commit false', async () => {
    const h = free();
    h.executor.writeOutcome = { results: [result({ kind: 'write', verb: 'UPDATE', affectedRows: 1001 })], open: true };
    const res = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET a = 1 WHERE id > 0', write: true, reason: 'r' })) as any;
    expect(res).toMatchObject({ status: 'awaiting_commit', decided_by: 'policy' });
    await h.broker.commit(res.request_id);
    const done = (await h.broker.status({ id: res.request_id })) as any;
    expect(done).toMatchObject({ status: 'committed', decided_by: 'policy', auto_commit: false });
    expect(done.commit_reason).toContain('1,001');
    // the trail keeps its own format: autoCommit still means "eligible", secondDecidedBy says who committed
    expect(h.audit.at(-1)).toMatchObject({ state: 'committed', decidedBy: 'policy', secondDecidedBy: 'user', autoCommit: true });
  });

  it('what the Cais cannot count or bound goes to the person: triggers, cascading FKs, views, stored functions, other verbs, partial metadata', async () => {
    const cases: { tree: any; sql: string; reason: RegExp }[] = [
      { tree: { foreignKeysComplete: true, databases: [{ name: 'app', tables: [{ name: 'cards', type: 'table', engine: 'InnoDB', columns: [], triggers: ['DELETE FROM app.logs'] }] }] }, sql: 'UPDATE cards SET a = 1 WHERE id = 1', reason: /trigger/ },
      { tree: { foreignKeysComplete: true, databases: [{ name: 'app', tables: [{ name: 'cards', type: 'table', engine: 'InnoDB', columns: [], cascadedBy: ['app.items'] }] }] }, sql: 'DELETE FROM cards WHERE id = 1', reason: /cascading/ },
      { tree: { foreignKeysComplete: true, databases: [{ name: 'app', tables: [{ name: 'v_cards', type: 'view', columns: [], uses: ['app.cards'] }, { name: 'cards', type: 'table', engine: 'InnoDB', columns: [] }] }] }, sql: 'UPDATE v_cards SET a = 1 WHERE id = 1', reason: /view/ },
      { tree: { foreignKeysComplete: true, databases: [{ name: 'app', tables: [{ name: 'cards', type: 'table', engine: 'InnoDB', columns: [] }], routines: [{ name: 'purge', body: 'DELETE FROM cards' }] }] }, sql: 'UPDATE cards SET a = app.purge() WHERE id = 1', reason: /database function purge/i },
      { tree: { foreignKeysComplete: true, databases: [{ name: 'app', tables: [{ name: 'cards', type: 'table', engine: 'InnoDB', columns: [] }], routines: [{ name: 'purge', body: 'DELETE FROM cards' }] }] }, sql: 'SELECT purge()', reason: /only INSERT, REPLACE, UPDATE and DELETE/ },
      { tree: { foreignKeysComplete: true, databases: [{ name: 'app', tables: [{ name: 'cards', type: 'table', engine: 'InnoDB', columns: [] }] }] }, sql: 'SET @x = 1; UPDATE cards SET a = @x WHERE id = 1', reason: /only INSERT/ },
      { tree: { foreignKeysComplete: true, databases: [{ name: 'app', partial: true, tables: [{ name: 'cards', type: 'table', engine: 'InnoDB', columns: [] }] }] }, sql: 'UPDATE cards SET a = 1 WHERE id = 1', reason: /metadata/ },
      { tree: { foreignKeysComplete: false, databases: [{ name: 'app', tables: [{ name: 'cards', type: 'table', engine: 'InnoDB', columns: [] }] }] }, sql: 'DELETE FROM cards WHERE id = 1', reason: /cannot see every foreign key/ },
      { tree: { databases: [{ name: 'app', tables: [{ name: 'cards', type: 'table', engine: 'InnoDB', columns: [] }] }] }, sql: "INSERT INTO cards (id) VALUES (1) ON DUPLICATE KEY UPDATE id = 2", reason: /cannot see every foreign key/ },
      { tree: { foreignKeysComplete: true, databases: [{ name: 'app', triggersVisible: false, tables: [{ name: 'cards', type: 'table', engine: 'InnoDB', columns: [] }] }] }, sql: 'UPDATE cards SET a = 1 WHERE id = 1', reason: /TRIGGER/ },
    ];
    for (const c of cases) {
      const h = free();
      h.executor.tree = c.tree;
      const res = (await h.broker.query({ env: 'api/dev', sql: c.sql, write: true, reason: 'r' })) as any;
      expect(res.status, c.sql).toBe('pending_approval');
      expect(res.approval_reason, c.sql).toMatch(c.reason);
      expect(h.executor.writes).toHaveLength(0);
    }
  });

  it('a trigger that writes to a table whose own trigger writes MyISAM is followed (two levels), and so is a view inside a trigger', async () => {
    const h = free();
    h.executor.tree = {
      foreignKeysComplete: true,
      databases: [{
        name: 'app',
        tables: [
          { name: 'a', type: 'table', engine: 'InnoDB', columns: [], triggers: ['INSERT INTO b VALUES (1)'] },
          { name: 'b', type: 'table', engine: 'InnoDB', columns: [], triggers: ['INSERT INTO v_c VALUES (1)'] },
          { name: 'v_c', type: 'view', columns: [], uses: ['app.c'] },
          { name: 'c', type: 'table', engine: 'MyISAM', columns: [] },
        ],
      }],
    };
    const res = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE a SET x = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    expect(res.status).toBe('pending_approval');
    expect(h.broker.snapshot().pending[0]!.warnings.join(' ')).toMatch(/app\.c|tabela c|c, que não é transacional/);
  });

  it('a plain INSERT never cascades: it commits by itself even when not every foreign key can be seen', async () => {
    const h = free();
    h.executor.tree = { databases: [{ name: 'app', tables: [{ name: 'cards', type: 'table', engine: 'InnoDB', columns: [] }] }] };
    h.executor.writeOutcome = { results: [result({ kind: 'write', verb: 'INSERT', affectedRows: 1 })], open: true };
    const res = (await h.broker.query({ env: 'api/dev', sql: 'INSERT INTO cards (id) VALUES (9)', write: true, reason: 'r' })) as any;
    expect(res.status).toBe('committed');
  });

  it('one automatic write at a time per environment; a second one waits for the person', async () => {
    const h = free();
    h.executor.writeOutcome = { results: [result({ kind: 'write', verb: 'UPDATE', affectedRows: 2000 })], open: true };
    const first = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET a = 1 WHERE id > 0', write: true, reason: 'r' })) as any;
    expect(first.status).toBe('awaiting_commit');
    const second = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET a = 2 WHERE id = 1', write: true, reason: 'r' })) as any;
    expect(second.status).toBe('pending_approval');
    expect(second.approval_reason).toContain('write is already open');
  });

  it('automatic commits stop at 5.000 rows per environment in 15 minutes: a loop of small deletes reaches the person', async () => {
    const h = free();
    h.executor.writeOutcome = { results: [result({ kind: 'write', verb: 'DELETE', affectedRows: 1000 })], open: true };
    const statuses: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = (await h.broker.query({ env: 'api/dev', sql: `DELETE FROM cards WHERE id > ${i}`, write: true, reason: 'r' })) as any;
      statuses.push(r.status);
      if (r.status === 'awaiting_commit') {
        expect(r.commit_reason).toContain('15 minutes');
        await h.broker.rollback(r.request_id);
      }
    }
    expect(statuses).toEqual(['committed', 'committed', 'committed', 'committed', 'committed', 'awaiting_commit']);
    await h.clock.advance(15 * 60_000 + 1);
    expect(((await h.broker.query({ env: 'api/dev', sql: 'DELETE FROM cards WHERE id > 9', write: true, reason: 'r' })) as any).status).toBe('committed');
  });

  it('an automatic commit whose outcome is unknown reaches the person', async () => {
    const h = free();
    const original = h.executor.runWrite.bind(h.executor);
    h.executor.runWrite = async (env, args) => {
      const run = await original(env, args);
      return { ...run, commit: async () => { const { AgentError } = await import('@main/agents/errors'); throw new AgentError('x', 'commit_unknown'); } };
    };
    const res = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    expect(res.status).toBe('failed');
    expect(res.error.code).toBe('commit_unknown');
    // the outcome of the Commit is unknown: no auto_commit either way
    expect(res.decided_by).toBe('policy');
    expect(res).not.toHaveProperty('auto_commit');
    expect(h.events.newPending).toEqual([res.request_id]);
  });

  it('marking the environment as production while the write runs: no automatic commit, and every view says production', async () => {
    const h = free();
    const original = h.executor.runWrite.bind(h.executor);
    h.executor.runWrite = async (env, args) => {
      const run = await original(env, args);
      h.envs[0]!.production = true;
      return run;
    };
    const res = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    expect(res).toMatchObject({ status: 'awaiting_commit', production: true });
    expect(h.broker.snapshot().awaitingCommit[0]!.production).toBe(true);
  });

  it('approving while the trail is down runs nothing and keeps the request pending', async () => {
    const h = makeBroker();
    const r = (await h.broker.query({ env: 'api/pro', sql: 'SELECT 1', reason: 'r' })) as any;
    h.trail.ok = false;
    expect(() => h.broker.approve(r.request_id, { shareResult: true })).toThrow('trilha');
    await flush();
    expect(h.executor.reads).toHaveLength(0);
    expect(h.broker.snapshot().pending.map((p) => p.id)).toEqual([r.request_id]);
    h.trail.ok = true;
    h.broker.approve(r.request_id, { shareResult: true });
    await flush();
    expect(h.executor.reads).toHaveLength(1);
  });

  it('autoCommitBlocker counts writes only, not rows read', () => {
    expect(autoCommitBlocker([result({ columns: [{ name: 'a', type: 'int' }], rows: Array.from({ length: 5000 }, () => [1]) })])).toBeNull();
    expect(autoCommitBlocker([result({ kind: 'write', verb: 'UPDATE', affectedRows: 1000 })])).toBeNull();
    expect(autoCommitBlocker([result({ kind: 'write', verb: 'UPDATE', affectedRows: 1001 })])).toContain('1.001');
  });
});

describe('broker: approve-all outside production', () => {
  it('reads ask; the 15-minute grant works there too, and envs tells the agent the level', async () => {
    const h = makeBroker();
    h.envs[0]!.agentLevel = 'approve-all';
    expect(h.broker.envs().environments[0]).toMatchObject({ slug: 'api/dev', agent_access: 'approve-all' });
    const noReason = h.broker.query({ env: 'api/dev', sql: 'SELECT 1' });
    await expect(noReason).rejects.toMatchObject({ code: 'reason_required' });
    const first = (await h.broker.query({ env: 'api/dev', sql: 'SELECT 1', reason: 'r' })) as any;
    expect(first.status).toBe('pending_approval');
    h.broker.approve(first.request_id, { shareResult: true, grantReads: true });
    await flush();
    const second = (await h.broker.query({ env: 'api/dev', sql: 'SELECT 2' })) as any;
    expect(second.status).toBe('succeeded');
    expect(h.broker.snapshot().recent[0]).toMatchObject({ decidedBy: 'grant' });
    expect(second.decided_by).toBe('policy');
    const grantLine = h.audit.find((a) => a.mode === 'grant')!;
    expect(grantLine).toMatchObject({ actor: 'person', production: false, environmentId: 'e-dev', state: 'created' });
  });
});

// --- the trail ---------------------------------------------------------------------------

const DAY = 86_400_000;
function makeTrail(opts: { vault?: Vault; days?: number } = {}) {
  const clock = new FakeClock();
  clock.now = Date.UTC(2026, 10, 12, 12, 0, 0);
  const seal = new Seal(dir, opts.vault ?? new FakeVault());
  let n = 0;
  const trail = new Trail(join(dir, 'trail'), { now: () => clock.now, scheduler: clock, newId: () => `t${++n}`, mac: (t) => seal.mac(t), ...(opts.days ? { retentionDays: opts.days } : {}) });
  return { clock, seal, trail };
}
const line = (over: Record<string, unknown> = {}) => ({ actor: 'person' as const, environment: 'api/dev', environmentId: 'e-dev', production: false, mode: 'autocommit', event: 'statement', sql: 'SELECT 1', state: 'ok', ...over });

describe('Trail', () => {
  it('one file per day, 0600 in a 0700 folder, newest first, agent requests in their last state', async () => {
    const { clock, seal, trail } = makeTrail();
    await seal.load();
    expect(trail.append(line({ sql: 'SELECT a' }))).toBe(true);
    clock.now += 1000;
    trail.append({ actor: 'agent', id: 'req_1', client: 'Claude Code', environment: 'api/dev', environmentId: 'e-dev', production: false, mode: 'write', sql: 'UPDATE x', state: 'running' });
    clock.now += 1000;
    trail.append({ actor: 'agent', id: 'req_1', client: 'Claude Code', environment: 'api/dev', environmentId: 'e-dev', production: false, mode: 'write', sql: 'UPDATE x', state: 'committed', autoCommit: true });
    expect(readdirSync(join(dir, 'trail'))).toEqual(['2026-11-12.jsonl']);
    expect(statSync(join(dir, 'trail', '2026-11-12.jsonl')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'trail')).mode & 0o777).toBe(0o700);
    const page = trail.list({ days: 1, limit: 50 });
    expect(page.verified).toBe(true);
    expect(page.tampered).toEqual([]);
    expect(page.entries.map((e) => [e.actor, e.state])).toEqual([['agent', 'committed'], ['person', 'ok']]);
  });

  it('a line edited, removed or added in the middle (or with its MAC stripped) shows as tampered', async () => {
    const { clock, seal, trail } = makeTrail();
    await seal.load();
    for (let i = 0; i < 4; i++) {
      trail.append(line({ sql: `SELECT ${i}` }));
      clock.now += 10;
    }
    const path = join(dir, 'trail', '2026-11-12.jsonl');
    const original = readFileSync(path, 'utf8');
    const lines = original.trim().split('\n');
    const cases = [
      original.replace('SELECT 1', 'SELECT 9'),
      [lines[0], lines[2], lines[3]].join('\n') + '\n',
      [lines[0], lines[1], lines[1], lines[2], lines[3]].join('\n') + '\n',
      original.replace(/,"mac":"[0-9a-f]{64}"/g, ''),
    ];
    for (const text of cases) {
      writeFileSync(path, text);
      expect(trail.list({ days: 1, limit: 50 }).tampered).toEqual(['2026-11-12']);
    }
    writeFileSync(path, original);
    expect(trail.list({ days: 1, limit: 50 }).tampered).toEqual([]);
    // a new Cais run appends to the same chain
    const again = makeTrail();
    await again.seal.load();
    again.clock.now = clock.now + 5;
    again.trail.append(line({ sql: 'SELECT 5' }));
    expect(again.trail.list({ days: 1, limit: 50 }).tampered).toEqual([]);
  });

  it('a different key (seal recreated) shows the old days as not matching', async () => {
    const { seal, trail } = makeTrail();
    await seal.load();
    trail.append(line());
    rmSync(join(dir, 'seal.json'));
    const fresh = makeTrail();
    await fresh.seal.load();
    expect(fresh.seal.status).toBe('missing');
    expect(fresh.trail.list({ days: 1, limit: 50 }).tampered).toEqual(['2026-11-12']);
  });

  it('filters by who, environment and text; pages back without splitting lines of the same time', async () => {
    const { clock, seal, trail } = makeTrail();
    await seal.load();
    trail.append(line({ sql: 'SELECT old' }));
    clock.now += 1000;
    for (let i = 0; i < 3; i++) trail.append(line({ sql: `SELECT same ${i}` })); // same ms
    clock.now += 1000;
    trail.append({ ...line({ sql: 'UPDATE cards', environment: 'api/pro', environmentId: 'e-pro', production: true }), actor: 'agent', client: 'Codex', mode: 'write', state: 'committed' });
    expect(trail.list({ days: 1, limit: 50, actor: 'agent' }).entries).toHaveLength(1);
    expect(trail.list({ days: 1, limit: 50, environmentId: 'e-pro' }).entries).toHaveLength(1);
    expect(trail.list({ days: 1, limit: 50, text: 'codex' }).entries).toHaveLength(1);
    expect(trail.list({ days: 1, limit: 50, text: 'same' }).entries).toHaveLength(3);
    const first = trail.list({ days: 1, limit: 2 });
    expect(first.entries.map((e) => e.sql)).toEqual(['UPDATE cards', 'SELECT same 2', 'SELECT same 1', 'SELECT same 0']);
    const second = trail.list({ days: 1, limit: 2, before: first.nextBefore! });
    expect(second.entries.map((e) => e.sql)).toEqual(['SELECT old']);
    expect(second.nextBefore).toBeUndefined();
  });

  it('keeps 90 days: older files go at start and every 24 hours', async () => {
    const { clock, seal, trail } = makeTrail();
    await seal.load();
    mkdirSync(join(dir, 'trail'), { recursive: true });
    writeFileSync(join(dir, 'trail', '2026-08-13.jsonl'), '{}\n'); // 91 days before
    writeFileSync(join(dir, 'trail', '2026-08-15.jsonl'), '{}\n');
    trail.start();
    expect(readdirSync(join(dir, 'trail')).sort()).toEqual(['2026-08-15.jsonl']);
    await clock.advance(3 * DAY);
    expect(readdirSync(join(dir, 'trail'))).toEqual([]);
    trail.stop();
  });

  it('moves the old agent trail in once, then removes it', async () => {
    const { clock, seal, trail } = makeTrail();
    await seal.load();
    const legacy = join(dir, 'agent-audit.jsonl');
    writeFileSync(legacy, [
      JSON.stringify({ ts: clock.now - 2 * DAY, time: 'x', id: 'req_a', client: 'c', environment: 'api/pro', production: true, mode: 'read', sql: 'SELECT 1', state: 'succeeded' }),
      JSON.stringify({ ts: clock.now - 200 * DAY, id: 'req_old', environment: 'x', production: false, mode: 'read', sql: '', state: 'succeeded' }),
      'garbage',
    ].join('\n') + '\n');
    trail.start(legacy);
    expect(() => statSync(legacy)).toThrow();
    const page = trail.list({ days: 7, limit: 50 });
    // ids of their own and marked: an imported line never stands in for a real one
    expect(page.entries.map((e) => [e.id, e.actor, e.imported])).toEqual([['legacy:req_a', 'agent', true]]);
    expect(page.tampered).toEqual([]);
    trail.stop();
    // a file dropped there later is never imported (the trail already has days): it is just removed
    writeFileSync(legacy, JSON.stringify({ ts: clock.now - DAY, id: 'forged', environment: 'api/pro', production: true, mode: 'write', sql: 'x', state: 'rejected' }) + '\n');
    trail.start(legacy);
    expect(() => statSync(legacy)).toThrow();
    expect(trail.list({ days: 7, limit: 50 }).entries.map((e) => e.id)).toEqual(['legacy:req_a']);
    trail.stop();
  });

  it('a write that fails returns false, marks the trail unhealthy and is reported', async () => {
    const { seal, trail } = makeTrail();
    await seal.load();
    writeFileSync(join(dir, 'trail'), 'not a folder');
    expect(trail.append(line())).toBe(false);
    expect(trail.healthy()).toBe(false);
    rmSync(join(dir, 'trail'));
    expect(trail.append(line())).toBe(true);
    expect(trail.healthy()).toBe(true);
    expect(trail.list({ days: 1, limit: 5 }).writeError).toContain('voltou a gravar');
  });

  it('without the vault the trail is written but not chained, and says so', async () => {
    const { seal, trail } = makeTrail({ vault: new FakeVault(false) });
    await seal.load();
    expect(seal.status).toBe('unavailable');
    trail.append(line());
    const page = trail.list({ days: 1, limit: 5 });
    expect(page.verified).toBe(false);
    expect(page.entries).toHaveLength(1);
    expect(readFileSync(join(dir, 'trail', '2026-11-12.jsonl'), 'utf8')).not.toContain('"mac"');
  });

  it('passwords typed in SQL never reach the trail', async () => {
    const { seal, trail } = makeTrail();
    await seal.load();
    for (const sql of [
      "ALTER USER 'app'@'%' IDENTIFIED BY 'S3gr3do'",
      "CREATE USER x IDENTIFIED WITH caching_sha2_password BY \"S3gr3do\"",
      "SET PASSWORD FOR 'app'@'%' = 'S3gr3do'",
      "CHANGE REPLICATION SOURCE TO SOURCE_USER = 'r', SOURCE_PASSWORD = 'S3gr3do'",
      "SELECT PASSWORD('S3gr3do')",
      "ALTER USER app IDENTIFIED BY 'novo' REPLACE 'S3gr3do'",
      "ALTER USER app IDENTIFIED BY/*x*/'S3gr3do'",
      "ALTER USER app IDENTIFIED BY 'a\\' , 'S3gr3do'",
      "CREATE SERVER s FOREIGN DATA WRAPPER mysql OPTIONS (USER 'u', PASSWORD 'S3gr3do')",
      "START REPLICA USER = 'r' PASSWORD = 'S3gr3do'",
    ]) trail.append(line({ sql }));
    const text = readFileSync(join(dir, 'trail', '2026-11-12.jsonl'), 'utf8');
    expect(text).not.toContain('S3gr3do');
    expect(text.match(/\*\*\*/g)).toHaveLength(10);
    // only the person's lines: an agent cannot hide its own SQL from the trail by writing PASSWORD in a comment
    trail.append({ ...line({ sql: "/* password */ DELETE FROM t WHERE a = 'x'" }), actor: 'agent' });
    expect(readFileSync(join(dir, 'trail', '2026-11-12.jsonl'), 'utf8')).toContain("DELETE FROM t WHERE a = 'x'");
  });

  it('a tampered older day shows even when the first page is full of newer lines', async () => {
    const { clock, seal, trail } = makeTrail();
    await seal.load();
    clock.now -= 7 * DAY;
    trail.append(line({ sql: 'SELECT velho' }));
    clock.now += 7 * DAY;
    for (let i = 0; i < 5; i++) {
      trail.append(line({ sql: `SELECT ${i}` }));
      clock.now += 10;
    }
    const old = join(dir, 'trail', '2026-11-05.jsonl');
    writeFileSync(old, readFileSync(old, 'utf8').replace('velho', 'outro'));
    expect(trail.list({ days: 30, limit: 3 }).tampered).toEqual(['2026-11-05']);
  });

  it('an agent cannot flood a day: lines are capped in bytes, agent lines stop at the day budget, the person keeps writing', async () => {
    const { seal, trail } = makeTrail();
    await seal.load();
    const { TRAIL_MAX_LINE_BYTES } = await import('@main/trail');
    // 4-byte characters: 100.000 of them would be 400 KB
    trail.append({ ...line({ sql: '😀'.repeat(100_000) }), actor: 'agent' });
    const first = readFileSync(join(dir, 'trail', '2026-11-12.jsonl'), 'utf8').trim().split('\n');
    expect(Buffer.byteLength(first[0]!, 'utf8')).toBeLessThanOrEqual(TRAIL_MAX_LINE_BYTES + 200);
    // pretend the day already holds the agents' budget
    (trail as any).agentBytes.set('2026-11-12', 64 * 1024 * 1024 - 10);
    expect(trail.append({ ...line({ sql: 'SELECT 1' }), actor: 'agent' })).toBe(false);
    expect(trail.healthyForAgents()).toBe(false);
    expect(trail.append(line({ sql: 'SELECT pessoa' }))).toBe(true);
    expect(trail.healthy()).toBe(true);
  });

  it('a day file that cannot be read is reported, not shown as empty', async () => {
    const { seal, trail } = makeTrail();
    await seal.load();
    trail.append(line());
    const path = join(dir, 'trail', '2026-11-12.jsonl');
    rmSync(path);
    mkdirSync(path); // EISDIR on read
    expect(trail.list({ days: 1, limit: 5 }).tampered).toEqual(['2026-11-12']);
  });

  it('cuts very long SQL and keeps its length', async () => {
    const { seal, trail } = makeTrail();
    await seal.load();
    trail.append(line({ sql: 'x'.repeat(250_000) }));
    const entry = trail.list({ days: 1, limit: 5 }).entries[0]!;
    expect(entry.sql).toHaveLength(100_000);
    expect(entry.sqlLength).toBe(250_000);
  });
});

// --- the seal ----------------------------------------------------------------------------

async function sealedStore(vault: Vault = new FakeVault()) {
  const seal = new Seal(dir, vault);
  await seal.load();
  const store = new CatalogStore(dir, vault, seal);
  await store.load();
  return { seal, store };
}

async function seedCatalog() {
  const { store } = await sealedStore();
  const project = await store.saveProject({ name: 'api' });
  const cred = await store.saveCredential({ name: 'root', kind: 'password', username: 'root' }, 'pw');
  const env = (name: string, production: boolean, agentLevel?: Environment['agentLevel']) =>
    store.saveEnvironment({ projectId: project.id, name, engine: 'mysql', host: 'h', port: 3306, credentialId: cred.id, production, ...(agentLevel ? { agentLevel } : {}) });
  const dev = await env('dev', false, 'free-reads-writes');
  const hml = await env('hml', false, 'free-reads');
  const pro = await env('pro', true, 'free-reads-writes');
  return { dev, hml, pro, cred, project, store };
}

const readCatalog = () => JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
const writeCatalog = (c: unknown) => writeFileSync(join(dir, 'catalog.json'), JSON.stringify(c));

describe('Seal of the catalog and of the switch', () => {
  it('a production environment is stored at most with free reads: free-reads-writes becomes approve-all', async () => {
    const { pro, project, cred, store } = await seedCatalog();
    expect(pro.agentLevel).toBe('approve-all');
    const pro2 = await store.saveEnvironment({ projectId: project.id, name: 'pro2', engine: 'mysql', host: 'h', port: 3306, credentialId: cred.id, production: true, agentLevel: 'free-reads' });
    expect(pro2.agentLevel).toBe('free-reads');
    const pro3 = await store.saveEnvironment({ projectId: project.id, name: 'pro3', engine: 'mysql', host: 'h', port: 3306, credentialId: cred.id, production: true });
    expect(agentLevelOf(pro3)).toBe('approve-all');
  });

  it('what the Cais saved opens as saved', async () => {
    await seedCatalog();
    const { store } = await sealedStore();
    expect((await store.snapshot()).notices).toEqual([]);
    expect(store.environments().map((e) => [e.name, e.production, e.agentLevel])).toEqual([
      ['dev', false, 'free-reads-writes'],
      ['hml', false, 'free-reads'],
      ['pro', true, 'approve-all'],
    ]);
  });

  it('an environment changed by hand becomes production with approve-all, is blocked until saved, and the person is told', async () => {
    const { pro, hml } = await seedCatalog();
    const c = readCatalog();
    c.environments.find((e: Environment) => e.id === pro.id).production = false;
    c.environments.find((e: Environment) => e.id === pro.id).agentLevel = 'free-reads-writes';
    writeCatalog(c);
    const { store } = await sealedStore();
    const after = store.getEnvironment(pro.id)!;
    expect(after.production).toBe(true);
    expect(agentLevelOf(after)).toBe('approve-all');
    expect(store.getEnvironment(hml.id)!.agentLevel).toBe('free-reads'); // the others are untouched
    expect((await store.snapshot()).notices.join(' ')).toContain('alterado fora do Cais (api · pro)');
    expect(store.integrityNotes).toHaveLength(1);
    // no connection goes to it (its host may be someone else's) until the person reviews and saves it
    expect(() => store.requireTrusted(pro.id)).toThrow('alterado fora do Cais');
    expect(() => store.requireTrusted(hml.id)).not.toThrow();
    expect((await store.snapshot()).blockedEnvironments).toEqual([pro.id]);
    // still blocked at the next start: the Cais never signs what nobody reviewed
    const next = await sealedStore();
    expect(next.store.isBlocked(pro.id)).toBe(true);
    // saved from the form: trusted and signed again, the start after that is quiet
    await next.store.saveEnvironment({ ...next.store.getEnvironment(pro.id)! });
    expect(next.store.isBlocked(pro.id)).toBe(false);
    const third = await sealedStore();
    expect((await third.store.snapshot()).notices).toEqual([]);
    expect(third.store.isBlocked(pro.id)).toBe(false);
  });

  it('a project renamed by hand is caught too (the approval modal and the slugs show the project name)', async () => {
    const { dev } = await seedCatalog();
    const c = readCatalog();
    c.projects[0].name = 'outro';
    writeCatalog(c);
    const { store } = await sealedStore();
    expect(store.isBlocked(dev.id)).toBe(true);
  });

  it('an environment added by hand, or pointed at another host, is not trusted either', async () => {
    const { dev } = await seedCatalog();
    const c = readCatalog();
    c.environments.find((e: Environment) => e.id === dev.id).host = 'outro';
    c.environments.push({ ...c.environments[0], id: 'e-new', name: 'novo', agentLevel: 'free-reads-writes' });
    writeCatalog(c);
    const { store } = await sealedStore();
    expect(store.getEnvironment(dev.id)!.production).toBe(true);
    expect(store.getEnvironment('e-new')!.production).toBe(true);
    expect(store.isBlocked(dev.id) && store.isBlocked('e-new')).toBe(true);
    expect(agentLevelOf(store.getEnvironment('e-new')!)).toBe('approve-all');
  });

  it('a credential or secret swapped by hand flags every environment that uses it', async () => {
    const { dev, cred } = await seedCatalog();
    const secrets = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'));
    secrets[cred.id] = new FakeVault().encrypt('outra');
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify(secrets));
    const { store } = await sealedStore();
    expect(store.environments().every((e) => e.production && agentLevelOf(e) === 'approve-all')).toBe(true);
    expect(store.getEnvironment(dev.id)!.production).toBe(true);
  });

  it('without a seal (removed, or a key the vault cannot open) every environment goes back to approve-all', async () => {
    await seedCatalog();
    rmSync(join(dir, 'seal.json'));
    const { store, seal } = await sealedStore();
    expect(seal.status).toBe('missing');
    expect(store.environments().map((e) => e.agentLevel)).toEqual(['approve-all', 'approve-all', 'approve-all']);
    // nobody knows what changed (production may have been unchecked): all production, all blocked until saved
    expect(store.environments().map((e) => e.production)).toEqual([true, true, true]);
    expect((await store.snapshot()).notices.join(' ')).toContain('proteção do cadastro foi criada agora');
    expect(store.environments().every((e) => store.isBlocked(e.id))).toBe(true);
    // a restart before reviewing them all: still blocked, but not "alterado fora do Cais"
    const restarted = await sealedStore();
    expect(restarted.store.environments().every((e) => restarted.store.isBlocked(e.id))).toBe(true);
    const notices = (await restarted.store.snapshot()).notices.join(' ');
    expect(notices).toContain('Faltam conferir');
    expect(notices).not.toContain('alterado fora do Cais');
    // the pending mark covers the id only: a hand edit while waiting (production off, free reads) does not survive a
    // start, so the person's save cannot carry it
    const c = readCatalog();
    c.environments[1].production = false;
    c.environments[1].agentLevel = 'free-reads';
    c.environments[2].agentLevel = 'free-reads';
    writeCatalog(c);
    const edited = await sealedStore();
    expect(edited.store.environments().map((e) => [e.production, e.agentLevel])).toEqual([[true, 'approve-all'], [true, 'approve-all'], [true, 'approve-all']]);
    expect(edited.store.environments().every((e) => edited.store.isBlocked(e.id))).toBe(true);
    // saving one releases that one only; the others keep waiting
    const first = restarted.store.environments()[0]!;
    await restarted.store.saveEnvironment({ ...first, production: false });
    const later = await sealedStore();
    expect(later.store.isBlocked(first.id)).toBe(false);
    expect(later.store.environments().filter((e) => later.store.isBlocked(e.id))).toHaveLength(2);
    expect(later.store.integrityNotes).toEqual([]);
    // a key from another vault cannot be opened: same outcome
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    await seedCatalog();
    const other: Vault = { isAvailable: () => true, encrypt: (p) => Buffer.from(p).toString('base64'), decrypt: () => { throw new Error('no'); } };
    const again = await sealedStore(other);
    expect(again.seal.status).toBe('missing');
  });

  it('without the vault nothing can be sealed: all approve-all, and a looser level cannot be saved', async () => {
    const { dev } = await seedCatalog();
    const { store } = await sealedStore(new FakeVault(false));
    expect(store.environments().every((e) => agentLevelOf(e) === 'approve-all')).toBe(true);
    // in memory only: the file still says what the Cais signed, so a later start with the vault is quiet
    expect(readCatalog().environments.find((e: Environment) => e.id === dev.id).agentLevel).toBe('free-reads-writes');
    expect((await store.snapshot()).agentLevelsLocked).toBe(true);
    // saving another environment does not write the in-memory approve-all of this one
    const { hml } = { hml: store.environments().find((e) => e.name === 'hml')! };
    await store.saveEnvironment({ ...hml, host: 'h' } as typeof hml & { host: string });
    expect(readCatalog().environments.find((e: Environment) => e.id === dev.id).agentLevel).toBe('free-reads-writes');
    // a looser level is stored as approve-all, without an error (the form shows the lock)
    expect((await store.saveEnvironment({ ...dev, agentLevel: 'free-reads' })).agentLevel).toBe('approve-all');
    const { agentLevel: _omit, ...noLevel } = dev;
    expect((await store.saveEnvironment(noLevel)).agentLevel).toBe('approve-all');
  });

  it('a project renamed inside the Cais is resealed: its environments stay trusted at the next start', async () => {
    const { project, store } = await seedCatalog();
    await store.renameProject(project.id, 'core');
    const next = await sealedStore();
    expect((await next.store.snapshot()).notices).toEqual([]);
    expect(next.store.environments().every((e) => !next.store.isBlocked(e.id))).toBe(true);
    expect(next.store.environments().map((e) => e.agentLevel)).toEqual(['free-reads-writes', 'free-reads', 'approve-all']);
  });

  it('renaming a project never releases a blocked environment, and its duplicate is refused (no laundering)', async () => {
    const { dev, hml, project } = await seedCatalog();
    const c = readCatalog();
    c.environments.find((e: Environment) => e.id === dev.id).host = 'someone-else.example';
    writeCatalog(c);
    const { store } = await sealedStore();
    expect(store.isBlocked(dev.id)).toBe(true);
    const before = readFileSync(join(dir, 'catalog.json'), 'utf8');
    await expect(store.duplicateProject(project.id, 'api (cópia)')).rejects.toMatchObject({ code: 'environment-untrusted' });
    expect(readFileSync(join(dir, 'catalog.json'), 'utf8')).toBe(before);
    expect((await store.snapshot()).projects).toHaveLength(1);
    await store.renameProject(project.id, 'core');
    expect(store.isBlocked(dev.id)).toBe(true);
    const next = await sealedStore();
    expect(next.store.isBlocked(dev.id)).toBe(true);
    expect(next.store.isBlocked(hml.id)).toBe(false);
    expect(next.store.getProject(project.id)!.name).toBe('core');
    // once the person reviews and saves it, the project can be duplicated
    await next.store.saveEnvironment({ ...next.store.getEnvironment(dev.id)! });
    const { copies } = await next.store.duplicateProject(project.id, 'core (cópia)');
    expect(copies).toHaveLength(3);
  });

  it('a duplicated project is signed: its copies open trusted, with the levels of the originals', async () => {
    const { project, store } = await seedCatalog();
    const { project: copy, copies } = await store.duplicateProject(project.id, 'api (cópia)');
    const next = await sealedStore();
    expect((await next.store.snapshot()).notices).toEqual([]);
    const copied = next.store.environments().filter((e) => e.projectId === copy.id);
    expect(copied.map((e) => e.id)).toEqual(copies.map((c) => c.copy.id));
    expect(copied.every((e) => !next.store.isBlocked(e.id))).toBe(true);
    expect(copied.map((e) => [e.name, e.production, e.agentLevel])).toEqual([
      ['dev', false, 'free-reads-writes'],
      ['hml', false, 'free-reads'],
      ['pro', true, 'approve-all'],
    ]);
  });

  it('without the vault a duplicated project stores approve-all copies and leaves the originals as signed', async () => {
    const { project, dev } = await seedCatalog();
    const { store } = await sealedStore(new FakeVault(false));
    const { copies } = await store.duplicateProject(project.id, 'api (cópia)');
    const file = readCatalog();
    for (const { copy } of copies) {
      expect(file.environments.find((e: Environment) => e.id === copy.id).agentLevel).toBe('approve-all');
    }
    expect(file.environments.find((e: Environment) => e.id === dev.id).agentLevel).toBe('free-reads-writes');
  });

  it('the agent-access switch turned on by hand counts as off; on through the Cais stays on', async () => {
    const seal = new Seal(dir, new FakeVault());
    await seal.load();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, agentAccess: true }));
    const byHand = new SettingsStore(dir, seal);
    await byHand.load();
    expect(byHand.agentAccess).toBe(false);
    expect(byHand.tampered).toBe(true);
    expect(byHand.notice).toContain('desligado');
    await byHand.setAgentAccess(true);
    const seal2 = new Seal(dir, new FakeVault());
    await seal2.load();
    const next = new SettingsStore(dir, seal2);
    await next.load();
    expect(next.agentAccess).toBe(true);
    expect(next.tampered).toBe(false);
  });
});

// --- the person's side of the trail ------------------------------------------------------

class FakeSession implements DbSession {
  serverVersion = '8.4.0-fake';
  database: string | null = 'app';
  inTx = false;
  async applyMode() {}
  useDatabase(name: string): Promise<StatementResult> {
    return this.execute(`USE ${'`' + name.replace(/`/g, '``') + '`'}`);
  }

  async transactionProbe(): Promise<boolean | undefined> {
    return (await this.execute('DO 0').catch(() => undefined))?.inTransaction;
  }

  async execute(sql: string): Promise<StatementResult> {
    if (/^\s*UPDATE/i.test(sql)) {
      this.inTx = true;
      return { index: 0, sql, kind: 'write', verb: 'UPDATE', durationMs: 4, affectedRows: 3, inTransaction: true };
    }
    if (/boom/.test(sql)) return { index: 0, sql, kind: 'read', verb: 'SELECT', durationMs: 1, error: { message: "Unknown column 'boom'", code: 'ER_BAD_FIELD_ERROR', errno: 1054 } };
    return { index: 0, sql, kind: 'read', verb: 'SELECT', durationMs: 2, columns: [{ name: 'a', type: 'int' }], rows: [[1], [2]], inTransaction: this.inTx };
  }
  async cancel() {}
  async commit() {
    this.inTx = false;
  }
  async rollback() {
    this.inTx = false;
  }
  async currentDatabase() {
    return this.database;
  }
  onFatalError(_cb: (e: DbSessionError) => void) {}
  async close() {}
  isClosed() {
    return false;
  }
}

describe('SessionManager: every execution of the person goes to the trail', () => {
  it('statements with counts and errors, refusals, mode changes, Commit and Rollback; never rows', async () => {
    const lines: PersonTrailLine[] = [];
    const env: Environment = { id: 'pro', projectId: 'p', name: 'pro', engine: 'mysql', host: 'h', port: 3306, credentialId: 'c', production: true };
    const driver: Driver = { engine: 'mysql', open: async () => new FakeSession(), introspect: async () => ({ databases: [] }), test: async () => ({ serverVersion: 'x' }) };
    let now = 1000;
    const manager = new SessionManager({
      getEnvironment: () => env,
      resolveConnectParams: async () => ({ host: 'h', port: 3306, user: 'u', tls: 'off' }),
      getDriver: () => driver,
      getDialect,
      emit: () => undefined,
      now: () => (now += 5),
      trail: { append: (l) => void lines.push(l) },
    });
    const run = (sql: string) => manager.run('t', { sql, scope: 'all', cursor: 0, maxRows: 1000 });
    await manager.open('t', 'pro');
    await run('SELECT a FROM t');
    await run('UPDATE t SET a = 1 WHERE id = 1'); // refused in read-only
    await run('SELECT boom');
    await manager.setMode('t', 'transaction');
    await run('UPDATE t SET a = 1 WHERE id = 1');
    await manager.commit('t');
    await run('UPDATE t SET a = 2 WHERE id = 1');
    await manager.rollback('t');
    const view = lines.map((l) => [l.event, l.mode, l.state, l.verb ?? '', l.rows ?? l.affectedRows ?? '']);
    expect(view).toEqual([
      ['statement', 'read-only', 'ok', 'SELECT', 2],
      ['statement', 'read-only', 'refused', 'UPDATE', ''],
      ['statement', 'read-only', 'error', 'SELECT', ''],
      ['mode', 'transaction', 'ok', '', ''],
      // a write is on the trail before it leaves (same id), so a crash in the middle still shows it
      ['statement', 'transaction', 'running', 'UPDATE', ''],
      ['statement', 'transaction', 'ok', 'UPDATE', 3],
      ['commit', 'transaction', 'running', 'COMMIT', ''],
      ['commit', 'transaction', 'ok', 'COMMIT', ''],
      ['statement', 'transaction', 'running', 'UPDATE', ''],
      ['statement', 'transaction', 'ok', 'UPDATE', 3],
      ['rollback', 'transaction', 'running', 'ROLLBACK', ''],
      ['rollback', 'transaction', 'ok', 'ROLLBACK', ''],
    ]);
    expect(lines[0]).toMatchObject({ database: 'app', sql: 'SELECT a FROM t' });
    expect(lines[0]!.id).toBeUndefined(); // reads get one line only
    expect(lines[4]!.id).toMatch(/^p_/);
    expect(lines[5]!.id).toBe(lines[4]!.id);
    expect(lines[1]!.detail).toContain('Somente leitura');
    expect(lines[2]).toMatchObject({ errorCode: 'ER_BAD_FIELD_ERROR', errno: 1054 });
    expect(lines[3]!.detail).toBe('Somente leitura → Transação');
    expect(lines[7]!.detail).toContain('1 comando');
    expect(lines[7]!.id).toBe(lines[6]!.id);
    expect(JSON.stringify(lines)).not.toMatch(/"rows":\[/);
  });

  it('a trail that throws never takes a run down', async () => {
    const env: Environment = { id: 'dev', projectId: 'p', name: 'dev', engine: 'mysql', host: 'h', port: 3306, credentialId: 'c', production: false };
    const driver: Driver = { engine: 'mysql', open: async () => new FakeSession(), introspect: async () => ({ databases: [] }), test: async () => ({ serverVersion: 'x' }) };
    const manager = new SessionManager({
      getEnvironment: () => env,
      resolveConnectParams: async () => ({ host: 'h', port: 3306, user: 'u', tls: 'off' }),
      getDriver: () => driver,
      getDialect,
      emit: () => undefined,
      now: () => 1,
      trail: {
        append: () => {
          throw new Error('disk full');
        },
      },
    });
    await manager.open('t', 'dev');
    const res = await manager.run('t', { sql: 'SELECT 1', scope: 'all', cursor: 0, maxRows: 10 });
    expect(res.results[0]!.rows).toHaveLength(2);
  });
});

describe('grantMatches: database grants as SCHEMA_PRIVILEGES shows them', () => {
  it('escaped wildcards are literal, unescaped ones match, case does not matter', async () => {
    const { grantMatches } = await import('@main/drivers/mysql/introspect');
    expect(grantMatches('cais\\_test', 'cais_test')).toBe(true);
    expect(grantMatches('cais\\_test', 'caisXtest')).toBe(false);
    expect(grantMatches('cais_test', 'caisXtest')).toBe(true);
    expect(grantMatches('app%', 'app_prod')).toBe(true);
    expect(grantMatches('APP\\%', 'app%')).toBe(true);
    expect(grantMatches('APP\\%', 'appx')).toBe(false);
    expect(grantMatches('a.b', 'aXb')).toBe(false);
  });
});
