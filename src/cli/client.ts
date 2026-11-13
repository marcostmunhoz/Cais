import net from 'node:net';
import { PROTOCOL } from './endpoint';

export type Reply =
  | { kind: 'ok'; result: Record<string, unknown> }
  | { kind: 'error'; code: string; message: string; fields?: unknown }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'protocol' };

/** One request over the local socket: a JSON line out, a JSON line back. */
/** `timeoutMs`: give up when no reply arrives in that time (used for the hello check; a wait has no limit). */
export function send(socketPath: string, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Reply> {
  return new Promise((resolve) => {
    const id = `${process.pid}-${Date.now()}`;
    const socket = net.connect(socketPath);
    let buffer = '';
    let settled = false;
    const done = (reply: Reply): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const timer = timeoutMs ? setTimeout(() => done({ kind: 'unavailable', reason: 'timeout' }), timeoutMs) : undefined;
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      let msg: { ok?: boolean; protocol?: number; result?: Record<string, unknown>; error?: { code?: string; message?: string; fields?: unknown } };
      try {
        msg = JSON.parse(buffer.slice(0, newline));
      } catch {
        return done({ kind: 'error', code: 'bad_reply', message: 'O Cais respondeu algo que não é JSON.' });
      }
      if (msg.protocol !== PROTOCOL) return done({ kind: 'protocol' });
      if (msg.ok) return done({ kind: 'ok', result: msg.result ?? {} });
      done({
        kind: 'error',
        code: msg.error?.code ?? 'error',
        message: msg.error?.message ?? 'Erro desconhecido.',
        ...(msg.error?.fields !== undefined ? { fields: msg.error.fields } : {}),
      });
    });
    socket.on('error', (error: NodeJS.ErrnoException) => done({ kind: 'unavailable', reason: error.code ?? 'error' }));
    socket.on('close', () => done({ kind: 'unavailable', reason: 'closed' }));
  });
}
