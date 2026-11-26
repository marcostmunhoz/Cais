import { describe, expect, it } from 'vitest';
import { connectionTitle, connectionView } from '@shared/connection';
import type { SessionState } from '@shared/results';
import { focusTab, tabForEnvironment } from '@shared/tabs';

const session = (over: Partial<SessionState> = {}): SessionState => ({
  tabId: 't',
  environmentId: 'e',
  status: 'idle',
  mode: 'autocommit',
  database: null,
  transaction: { open: false, statements: 0 },
  ...over,
});

describe('connectionView', () => {
  it('no session: Disconnected with Connect', () => {
    expect(connectionView(undefined)).toEqual({ status: 'disconnected', label: 'Desconectado', idle: false, action: 'connect' });
  });

  it('connecting: from main or from the renderer flag, with no button', () => {
    expect(connectionView(session({ status: 'connecting' }))).toMatchObject({ status: 'connecting', label: 'Conectando…', action: null });
    expect(connectionView(session({ status: 'disconnected' }), { connecting: true }).status).toBe('connecting');
  });

  it('connected shows the server version; Disconnect is blocked with a transaction open', () => {
    expect(connectionView(session({ serverVersion: '8.4.3' }))).toEqual({
      status: 'connected', label: 'Conectado', detail: '8.4.3', idle: false, action: 'disconnect',
    });
    expect(connectionView(session({ transaction: { open: true, statements: 1 } })).disconnectBlocked).toBe('Faça commit ou rollback antes');
  });

  it('running blocks Disconnect', () => {
    const view = connectionView(session({ status: 'running' }));
    expect(view).toMatchObject({ status: 'running', label: 'Executando…', action: 'disconnect' });
    expect(view.disconnectBlocked).toBe('Aguarde o comando terminar');
    expect(connectionView(session(), { running: true }).status).toBe('running');
  });

  it('error carries the message and offers Reconnect; a "disconnected with error" state counts as error', () => {
    const view = connectionView(session({ status: 'error', error: 'ECONNREFUSED' }));
    expect(view).toEqual({ status: 'error', label: 'Erro de conexão', detail: 'ECONNREFUSED', idle: false, action: 'reconnect' });
    expect(connectionTitle(view)).toBe('Erro de conexão · ECONNREFUSED');
    expect(connectionView(session({ status: 'disconnected', error: 'x' })).status).toBe('error');
    expect(connectionView(session({ status: 'error' }), { message: 'from the run' }).detail).toBe('from the run');
  });

  it('idle disconnect says so; a manual one is plain Desconectado', () => {
    expect(connectionView(session({ status: 'disconnected', disconnectReason: 'idle' }))).toMatchObject({
      status: 'disconnected', label: 'Desconectado por inatividade', idle: true, action: 'connect',
    });
    expect(connectionView(session({ status: 'disconnected', disconnectReason: 'manual' })).label).toBe('Desconectado');
    expect(connectionTitle(connectionView(undefined))).toBe('Desconectado');
  });
});

describe('single click on an environment', () => {
  const tabs = [
    { id: 'a1', environmentId: 'a' },
    { id: 'b1', environmentId: 'b' },
    { id: 'a2', environmentId: 'a' },
    { id: 'a3', environmentId: 'a' },
  ];

  it('no tab of the environment: open one', () => {
    expect(tabForEnvironment(tabs, 'a1', [], 'c')).toBeUndefined();
  });

  it('the active tab when it is of that environment', () => {
    expect(tabForEnvironment(tabs, 'a2', ['a1', 'a2'], 'a')).toBe('a2');
  });

  it('else the most recently focused one of it', () => {
    expect(tabForEnvironment(tabs, 'b1', ['b1', 'a1', 'a3'], 'a')).toBe('a1');
  });

  it('else (after a restart, nothing focused yet) the last one in the strip', () => {
    expect(tabForEnvironment(tabs, 'b1', ['b1'], 'a')).toBe('a3');
    expect(tabForEnvironment(tabs, null, [], 'a')).toBe('a3');
  });

  it('focus order: most recent first, closed tabs dropped', () => {
    expect(focusTab(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(focusTab(['a', 'b'], 'x', [{ id: 'x' }, { id: 'b' }])).toEqual(['x', 'b']);
  });
});
