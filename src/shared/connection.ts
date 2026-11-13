import { m } from './i18n';
import type { SessionState } from './results';

/** The connection state a tab shows. */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'running' | 'error';

/** The renderer's transient flags for a tab (a subset of its RunView). */
export interface RunFlags {
  running?: boolean;
  connecting?: boolean;
  /** Failure before any statement ran (connection, validation). */
  message?: string;
}

export interface ConnectionView {
  status: ConnectionStatus;
  /** "Conectado", "Desconectado por inatividade"... in the app locale. */
  label: string;
  /** The error message (error), or the server version (connected). */
  detail?: string;
  /** Disconnected by the idle timer. */
  idle: boolean;
  /** The button next to the state: Conectar, Reconectar, Desconectar, or none while connecting. */
  action: 'connect' | 'reconnect' | 'disconnect' | null;
  /** Why Desconectar is disabled (transaction open or statement running). Main refuses it too. */
  disconnectBlocked?: string;
}

/**
 * The single place that turns a tab's session (pushed by main) and its transient flags into what the
 * tab strip, the session bar and the status bar show. Pure: no store, no DOM.
 */
export function connectionView(session: SessionState | undefined, run?: RunFlags): ConnectionView {
  const t = m().sessionBar;
  const status = session?.status;
  if (run?.connecting || status === 'connecting') {
    return { status: 'connecting', label: t.connection.connecting, idle: false, action: null };
  }
  if (run?.running || status === 'running') {
    return {
      status: 'running',
      label: t.connection.running,
      idle: false,
      action: 'disconnect',
      disconnectBlocked: t.disconnectBlockedRunning,
    };
  }
  if (status === 'idle') {
    return {
      status: 'connected',
      label: t.connection.connected,
      ...(session?.serverVersion ? { detail: session.serverVersion } : {}),
      idle: false,
      action: 'disconnect',
      ...(session?.transaction.open ? { disconnectBlocked: t.disconnectBlockedTransaction } : {}),
    };
  }
  if (status === 'error' || (status === 'disconnected' && session?.error)) {
    const detail = session?.error ?? run?.message;
    return { status: 'error', label: t.connection.error, ...(detail ? { detail } : {}), idle: false, action: 'reconnect' };
  }
  const idle = session?.disconnectReason === 'idle';
  return { status: 'disconnected', label: idle ? t.connection.idle : t.connection.disconnected, idle, action: 'connect' };
}

/** "Erro de conexão · <message>": the tooltip of the tab's status dot. */
export function connectionTitle(view: ConnectionView): string {
  return view.detail ? `${view.label} · ${view.detail}` : view.label;
}
