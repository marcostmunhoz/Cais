// With the app in English the person reads English; the agent keeps reading the same pt-BR text.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_LOCALE, setLocale } from '@shared/i18n';
import { getDialect, noStatementMessage } from '@shared/dialects/registry';
import { collapseBlankRuns, hiddenTextProblem } from '@shared/text';
import { AgentAccess } from '@main/agents/access';
import { AgentError, agentText } from '@main/agents/errors';
import { redactForAgent } from '@main/agents/redact';
import { AgentServer } from '@main/agents/server';
import { AgentSessions } from '@main/agents/sessions';
import { mapMysqlError } from '@main/drivers/mysql/errors';
import { DriverError, type DbSession, type Driver } from '@main/drivers/types';
import { ScriptStore } from '@main/store/scripts';
import type { StatementResult } from '@shared/results';
import { SettingsStore } from '@main/store/settings';
import { send } from '../../src/cli/client';
import { dev, FakeClock, flush, makeBroker, projects, result } from '../support/agent-fakes';

let dir: string;
let server: AgentServer | undefined;
beforeEach(() => {
  dir = mkdtempSync('/tmp/cais-i18n-');
  setLocale('en');
});
afterEach(async () => {
  setLocale('pt-BR');
  await server?.stop();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const free = () => {
  const h = makeBroker();
  h.envs[0]!.agentLevel = 'free-reads-writes';
  return h;
};

describe('broker in English', () => {
  it('approval reason and alerts: English in the modal, pt-BR for the agent', async () => {
    const h = free();
    const res = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET blocked = 1', write: true, reason: 'r' })) as any;
    expect(res.approval_reason).toBe('Este ambiente libera escrita, mas o pedido tem alerta: ele espera a sua aprovação.');
    const view = h.broker.snapshot().pending[0]!;
    expect(view.approvalReason).toBe('This environment allows writes, but the request has an alert: it waits for your approval.');
    expect(view.warnings).toEqual(['UPDATE without WHERE']);
  });

  it('commit reason: numbers formatted per audience', async () => {
    const h = free();
    h.executor.writeOutcome = { results: [result({ kind: 'write', verb: 'UPDATE', affectedRows: 1001 })], open: true };
    const res = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET a = 1 WHERE id > 0', write: true, reason: 'r' })) as any;
    expect(res.commit_reason).toBe('Afetou 1.001 linhas; o commit automático vai até 1.000. Confira e decida.');
    expect(h.broker.snapshot().awaitingCommit[0]!.commitReason).toBe('It affected 1,001 rows; automatic commit goes up to 1,000. Check and decide.');
  });

  it('an environment change: rejection in English for the person, "O ambiente mudou." for the agent', async () => {
    const h = makeBroker();
    const pending = (await h.broker.query({ env: 'api/pro', sql: 'SELECT 1', reason: 'r' })) as any;
    h.envs[1]!.host = 'elsewhere.example';
    await h.broker.environmentChanged('e-pro');
    expect(await h.broker.status({ id: pending.request_id })).toMatchObject({ status: 'expired', rejection_reason: 'O ambiente mudou.' });
    expect(h.broker.snapshot().recent[0]!.rejectionReason).toBe('The environment changed.');
  });

  it('person-side errors: message in English, agent text in pt-BR', async () => {
    const h = makeBroker();
    const err = (() => {
      try {
        h.broker.approve('nope', { shareResult: true });
      } catch (e) {
        return e as AgentError;
      }
      throw new Error('approve should throw');
    })();
    expect(err).toBeInstanceOf(AgentError);
    expect(err.message).toBe('Request not found.');
    expect(agentText(err)).toBe('Pedido não encontrado.');
  });

  it('a failed commit: English in the panel, pt-BR in the reply', async () => {
    const h = makeBroker();
    const r = (await h.broker.query({ env: 'api/dev', sql: 'UPDATE cards SET a = 1 WHERE id = 1', write: true, reason: 'r' })) as any;
    h.broker.approve(r.request_id, { shareResult: true });
    await flush();
    // the fake commits: make this one fail the way a driver error would
    const rec = h.broker.snapshot().awaitingCommit[0]!;
    const write = (h.broker as any).records.get(rec.id).write;
    write.commit = async () => {
      throw new Error('gone');
    };
    await h.broker.commit(rec.id);
    expect(h.broker.snapshot().recent[0]!.errorMessage).toBe('The commit failed and the server rolled the transaction back.');
    expect(await h.broker.status({ id: rec.id })).toMatchObject({
      status: 'failed',
      error: { message: 'O commit falhou e o servidor desfez a transação.', code: 'commit_failed' },
    });
    // the reply never carries the reference itself
    expect(JSON.stringify(await h.broker.status({ id: rec.id }))).not.toContain('agentsUi');
  });

  it('the socket replies in pt-BR whatever the app locale', async () => {
    const h = makeBroker();
    server = new AgentServer({ broker: h.broker, socketPath: join(dir, 'agent.sock'), endpointPath: join(dir, 'ep.json'), platform: process.platform, pid: process.pid, appVersion: 'x' });
    await server.start();
    h.broker.setEnabled(false);
    expect(await send(join(dir, 'agent.sock'), 'envs', {})).toMatchObject({ kind: 'error', code: 'agent_access_off', message: 'O acesso de agentes está desligado.' });
  });

  it('a socket that cannot open: the panel says why in English', async () => {
    const h = makeBroker();
    h.broker.setEnabled(false);
    const settings = new SettingsStore(dir);
    await settings.load();
    await settings.setAgentAccess(true);
    const failing = { start: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); }, stop: async () => undefined } as unknown as AgentServer;
    const a = new AgentAccess({ settings, broker: h.broker, server: failing, onChange: () => undefined });
    await a.init();
    expect(a.snapshot().startError).toBe('Could not open the agent socket: EACCES.');
  });
});

// --- errors produced by main code (store, driver) that reach an agent -------------------------------

const ctx = { iam: false, host: dev.host, port: dev.port, cancelled: false };

/** A driver whose sessions answer every statement with `onExecute`, or whose open fails with `openError`. */
function agentSessions(opts: { openError?: Error; onExecute?: (sql: string) => Partial<StatementResult> }): AgentSessions {
  const session: DbSession = {
    serverVersion: 'fake',
    applyMode: async () => undefined,
    applyLimits: async () => undefined,
    execute: async (sql) => ({ index: 0, sql, kind: 'read', verb: 'SELECT', durationMs: 1, ...(opts.onExecute?.(sql) ?? {}) }),
    useDatabase: async (name) => ({ index: 0, sql: `USE \`${name}\``, kind: 'session', verb: 'USE', durationMs: 1 }),
    cancel: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    currentDatabase: async () => 'app',
    onFatalError: () => undefined,
    close: async () => undefined,
  };
  const driver: Driver = {
    engine: 'mysql',
    open: async () => {
      if (opts.openError) throw opts.openError;
      return session;
    },
    introspect: async () => ({ databases: [] }),
    test: async () => ({ serverVersion: 'x' }),
  };
  return new AgentSessions({
    getDriver: () => driver,
    resolveConnectParams: async () => ({ host: dev.host, port: dev.port, database: 'app', user: 'u', password: 'secret-pw', tls: 'off' }),
    scheduler: new FakeClock(),
  });
}

describe('main errors that reach an agent, with the app in English', () => {
  it('a script name conflict: the store says it in English, the agent reads pt-BR', async () => {
    const store = new ScriptStore(dir, { getProject: (id) => projects.find((p) => p.id === id), getEnvironment: () => undefined, now: () => 1 });
    await store.save({ projectId: 'p-api', name: 'duplicados', sql: 'SELECT 1' }, 'user');
    const personSide = (await store.save({ projectId: 'p-api', name: 'Duplicados', sql: 'SELECT 2' }, 'user').catch((e) => e)) as Error;
    expect(personSide.message).toBe('A script with this name already exists in api.');

    const h = makeBroker();
    (h.broker as any).deps.scripts = store;
    const err = (await h.broker.scriptSave({ project: 'api', name: 'DUPLICADOS', sql: 'SELECT 3' }).catch((e) => e)) as AgentError;
    expect(err).toBeInstanceOf(AgentError);
    expect(err.code).toBe('duplicate_name');
    expect(err.message).toBe('A script with this name already exists in api.');
    expect(agentText(err)).toBe('Já existe um script com esse nome em api.');
  });

  it('a driver connection failure: English for the person, pt-BR for the agent, no address either way', async () => {
    const info = mapMysqlError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }, ctx);
    expect(info.message).toBe(`No response from ${dev.host}:${dev.port}. Is the VPN on?`);
    const sessions = agentSessions({ openError: new DriverError(info.message, info) });
    const err = (await sessions.runRead(dev, { statements: [{ text: 'SELECT 1' }], maxRows: 1 }).catch((e) => e)) as AgentError;
    expect(err).toBeInstanceOf(AgentError);
    expect(err.code).toBe('connection_failed');
    expect(err.message).toBe('Could not connect to the environment. No response from <server>. Is the VPN on?');
    expect(agentText(err)).toBe('Não foi possível conectar ao ambiente. Sem resposta de <servidor>. A VPN está ligada?');

    // and through the broker: the reply the CLI prints
    const h = makeBroker({ executor: sessions as any });
    h.envs[0]!.agentLevel = 'free-reads-writes';
    const reply = (await h.broker.query({ env: 'api/dev', sql: 'SELECT 1', reason: 'r' })) as any;
    expect(JSON.stringify(reply)).not.toContain(dev.host);
    expect(reply).toMatchObject({ status: 'failed', error: { code: 'connection_failed', message: 'Não foi possível conectar ao ambiente. Sem resposta de <servidor>. A VPN está ligada?' } });
    expect(h.broker.snapshot().recent[0]!.errorMessage).toBe('Could not connect to the environment. No response from <server>. Is the VPN on?');
  });

  it('a statement error mapped by mapMysqlError: English in the panel, pt-BR in the reply', async () => {
    const lost = mapMysqlError({ code: 'PROTOCOL_CONNECTION_LOST', message: 'Connection lost: The server closed the connection.', fatal: true }, ctx);
    expect(lost.message).toBe('Connection lost.');
    const sessions = agentSessions({ onExecute: () => ({ error: lost }) });
    const h = makeBroker({ executor: sessions as any });
    h.envs[0]!.agentLevel = 'free-reads-writes';
    const reply = (await h.broker.query({ env: 'api/dev', sql: 'SELECT 1', reason: 'r' })) as any;
    expect(reply).toMatchObject({ status: 'failed', error: { code: 'PROTOCOL_CONNECTION_LOST', message: 'Conexão perdida.' } });
    expect(JSON.stringify(reply)).not.toContain('Connection lost');
    expect(h.broker.snapshot().recent[0]!.errorMessage).toBe('Connection lost.');
  });
});

describe('shared helpers in English', () => {
  const mysql = getDialect('mysql');

  it('classifier refusals and alerts follow the app locale; SQL keywords stay', () => {
    expect(mysql.classify('DELETE FROM t WHERE id = 1').reason).toBe('Read-only: DELETE is not allowed. Change the tab mode to change data.');
    expect(mysql.classify('SELECT * FROM t FOR UPDATE').reason).toBe('Read-only: locking reads (FOR UPDATE) are not allowed.');
    expect(mysql.classify('SET autocommit = 0').alwaysRefuse).toBe('Use the tab mode (Read-only, Transaction or Auto-commit) to control transactions and autocommit.');
    expect(mysql.classify('SELECT 1 /*!50000 , 2 */').reason).toBe(
      'Read-only: a versioned executable comment (/*!NNNNN … */ or /*M! … */) can hide a statement other than the one shown. Remove the comment.',
    );
    expect(mysql.warnings('DELETE FROM t WHERE 1 = 1')).toEqual(['DELETE with a WHERE that is always true']);
    expect(noStatementMessage()).toBe('No statement under the cursor.');
  });

  it('agent-facing checks stay pt-BR unless asked; markers are never translated', () => {
    expect(mysql.agentCodeProblem!('SELECT 1 --\tx')).toBe('Comentário "--" sem espaço logo depois: use "-- " (traço, traço, espaço).');
    expect(hiddenTextProblem('SELECT 1‮')).toBe('The SQL has an invisible or text-direction character (⟨U+202E⟩). Rewrite it without that character.');
    expect(hiddenTextProblem('SELECT 1‮', AGENT_LOCALE)).toBe('O SQL tem um caractere invisível ou de direção de texto (⟨U+202E⟩). Reescreva sem ele.');
    expect(collapseBlankRuns('a\n\n\nb')).toBe('a\n⋯ 2 blank lines\nb');
    const target = { host: '10.1.2.3', port: 3306 };
    expect(redactForAgent("Access denied for user 'u'@'10.1.2.3'", target)).toBe("Access denied for user '<usuário>'@'<servidor>'");
    expect(redactForAgent("Access denied for user 'u'@'10.1.2.3'", target, 'en')).toBe("Access denied for user '<user>'@'<server>'");
  });
});
