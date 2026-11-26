import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentAccess } from '@main/agents/access';
import { AgentServer, socketPathFor } from '@main/agents/server';
import { send } from '../../src/cli/client';
import { makeBroker } from '../support/agent-fakes';

let dir: string;
let server: AgentServer | undefined;
beforeEach(() => {
  dir = mkdtempSync('/tmp/cais-srv-');
});
afterEach(async () => {
  await server?.stop();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function start(extra: { socketPath?: string } = {}) {
  const h = makeBroker();
  const socketPath = extra.socketPath ?? join(dir, 'agent.sock');
  server = new AgentServer({ broker: h.broker, socketPath, endpointPath: join(dir, 'agent-endpoint.json'), platform: process.platform, pid: process.pid, appVersion: '0.0.0-test' });
  return { ...h, socketPath, server };
}

/** Raw exchange: writes bytes, returns the first reply line (or null if the server closed first). */
function raw(path: string, payload: string): Promise<{ reply: Record<string, any> | null; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (c: string) => {
      buf += c;
      if (buf.includes('\n')) {
        resolve({ reply: JSON.parse(buf.split('\n')[0]!), closed: false });
        socket.destroy();
      }
    });
    socket.on('close', () => resolve({ reply: buf.includes('\n') ? JSON.parse(buf.split('\n')[0]!) : null, closed: true }));
    socket.on('error', () => resolve({ reply: null, closed: true }));
  });
}

describe('AgentServer: where it exists', () => {
  it('has no socket and no endpoint until started; start creates them 0600; stop removes both', async () => {
    const { server, socketPath } = start();
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(join(dir, 'agent-endpoint.json'))).toBe(false);
    await server.start();
    expect(server.isListening()).toBe(true);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'agent-endpoint.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, 'agent-endpoint.json'), 'utf8'))).toEqual({ socket: socketPath, pid: process.pid, protocol: 1 });
    await server.stop();
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(join(dir, 'agent-endpoint.json'))).toBe(false);
    expect((await send(socketPath, 'hello', {})).kind).toBe('unavailable');
  });

  it('removes a stale socket (nobody answers) but never one somebody answers on, nor a regular file', async () => {
    const socketPath = join(dir, 'agent.sock');
    // a stale socket: a process that listened and was killed without cleanup
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((r) => child.stdout.once('data', () => r()));
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    expect(existsSync(socketPath)).toBe(true);
    const a = start({ socketPath });
    await a.server.start();
    expect((await send(socketPath, 'hello', {})).kind).toBe('ok');

    // a second Cais refuses to take over a live socket
    const b = new AgentServer({ broker: a.broker, socketPath, endpointPath: join(dir, 'other.json'), platform: process.platform, pid: 1, appVersion: 'x' });
    await expect(b.start()).rejects.toThrow('Outro Cais');
    expect((await send(socketPath, 'hello', {})).kind).toBe('ok'); // still ours

    // a regular file is never deleted
    await a.server.stop();
    writeFileSync(socketPath, 'not a socket');
    await expect(a.server.start()).rejects.toThrow('Já existe um arquivo');
    expect(readFileSync(socketPath, 'utf8')).toBe('not a socket');
  });

  it('uses a short tmp path when <userData>/agent.sock would pass 100 bytes, and a named pipe on Windows', () => {
    const base = { platform: 'darwin' as const, uid: 501, username: 'ana', tmpdir: '/var/folders/x/T' };
    expect(socketPathFor({ ...base, userData: '/Users/ana/Library/Application Support/Cais' })).toBe('/Users/ana/Library/Application Support/Cais/agent.sock');
    const long = '/Users/ana/' + 'pasta-muito-longa/'.repeat(6) + 'Cais';
    expect(socketPathFor({ ...base, userData: long })).toBe('/var/folders/x/T/cais-501.sock');
    expect(socketPathFor({ ...base, platform: 'win32', userData: 'C:\\x' })).toBe('\\\\.\\pipe\\cais-ana');
    expect(socketPathFor({ ...base, userData: long, override: '/tmp/t.sock' })).toBe('/tmp/t.sock');
  });

  it('prefers $XDG_RUNTIME_DIR/cais.sock on Linux when the preferred path is too long', () => {
    const base = { platform: 'linux' as const, uid: 1000, username: 'ana', tmpdir: '/tmp' };
    const long = '/home/ana/' + 'pasta-muito-longa/'.repeat(6) + 'Cais';
    expect(socketPathFor({ ...base, userData: long, runtimeDir: '/run/user/1000' })).toBe('/run/user/1000/cais.sock');
    expect(socketPathFor({ ...base, userData: long, runtimeDir: 'relative/dir' })).toBe('/tmp/cais-1000.sock');
    expect(socketPathFor({ ...base, userData: long })).toBe('/tmp/cais-1000.sock');
    expect(socketPathFor({ ...base, platform: 'darwin', userData: long, runtimeDir: '/run/user/1000' })).toBe('/tmp/cais-1000.sock');
    expect(socketPathFor({ ...base, userData: '/home/ana/.config/Cais', runtimeDir: '/run/user/1000' })).toBe('/home/ana/.config/Cais/agent.sock');
  });

  it('really works on the tmp fallback path (length > 100 for the preferred one)', async () => {
    const longDir = join(dir, 'a'.repeat(60), 'b'.repeat(40));
    const preferred = join(longDir, 'agent.sock');
    expect(Buffer.byteLength(preferred)).toBeGreaterThan(100);
    const fallback = socketPathFor({ userData: longDir, platform: process.platform, uid: 0, username: 'x', tmpdir: dir });
    expect(fallback).toBe(`${dir}/cais-0.sock`);
    const s = start({ socketPath: fallback });
    await s.server.start();
    expect((await send(fallback, 'hello', {})).kind).toBe('ok');
  });
});

describe('AgentServer: protocol', () => {
  it('answers a request with the same id, ok and the protocol number', async () => {
    const { socketPath, server } = start();
    await server.start();
    const { reply } = await raw(socketPath, JSON.stringify({ id: 'abc', method: 'hello', params: {} }) + '\n');
    expect(reply).toEqual({ id: 'abc', ok: true, protocol: 1, result: { protocol: 1, app_version: '0.0.0-test' } });
  });

  it('turns bad JSON, unknown methods and invalid params into errors (never into a crash)', async () => {
    const { socketPath, server } = start();
    await server.start();
    expect((await raw(socketPath, 'not json\n')).reply).toMatchObject({ ok: false, error: { code: 'invalid_json' } });
    expect((await raw(socketPath, JSON.stringify({ id: 1, method: 'drop_everything' }) + '\n')).reply).toMatchObject({ error: { code: 'unknown_method' } });
    expect((await raw(socketPath, JSON.stringify({ id: 1, method: 'toString' }) + '\n')).reply).toMatchObject({ error: { code: 'unknown_method' } });
    const bad = (await raw(socketPath, JSON.stringify({ id: 2, method: 'query', params: { env: 'x' } }) + '\n')).reply!;
    expect(bad).toMatchObject({ id: 2, ok: false, error: { code: 'invalid_params' } });
    // extra fields are refused (strict): an agent cannot smuggle approval flags
    const extra = (await raw(socketPath, JSON.stringify({ id: 3, method: 'query', params: { env: 'api/dev', sql: 'SELECT 1', approve: true } }) + '\n')).reply!;
    expect(extra.error.code).toBe('invalid_params');
    const wrongType = (await raw(socketPath, JSON.stringify({ id: 4, method: 'query', params: { env: 'api/dev', sql: 'SELECT 1', max_rows: 99999 } }) + '\n')).reply!;
    expect(wrongType.error.code).toBe('invalid_params');
  });

  it('exposes no method to approve, reject, commit, roll back, toggle access or edit scripts', async () => {
    const { socketPath, server } = start();
    await server.start();
    for (const method of ['approve', 'reject', 'commit', 'rollback', 'set_enabled', 'revoke_grant', 'script_update', 'script_delete', 'script_edit', 'snapshot']) {
      expect((await raw(socketPath, JSON.stringify({ id: 1, method, params: {} }) + '\n')).reply).toMatchObject({ ok: false, error: { code: 'unknown_method' } });
    }
  });

  it('refuses SQL over 100 KB and a message over 1 MB (and closes the connection)', async () => {
    const { socketPath, server } = start();
    await server.start();
    const big = JSON.stringify({ id: 1, method: 'query', params: { env: 'api/dev', sql: 'x'.repeat(102_401) } }) + '\n';
    expect((await raw(socketPath, big)).reply).toMatchObject({ error: { code: 'invalid_params' } });
    const huge = 'y'.repeat(1_048_576 + 10) + '\n';
    const out = await raw(socketPath, huge);
    expect(out.reply).toMatchObject({ ok: false, error: { code: 'message_too_large' } });
  });

  it('runs a query end to end through the socket and keeps broker errors as codes', async () => {
    const { socketPath, server } = start();
    await server.start();
    const ok = await send(socketPath, 'query', { env: 'api/dev', sql: 'SELECT 1', client: 'teste' });
    expect(ok).toMatchObject({ kind: 'ok', result: { status: 'succeeded', environment: 'api/dev' } });
    const refused = await send(socketPath, 'query', { env: 'api/dev', sql: 'DROP TABLE t' });
    expect(refused).toMatchObject({ kind: 'error', code: 'ddl_or_transaction' });
  });

  it('a pending query with wait is released when the client disconnects, and the request stays pending', async () => {
    const { socketPath, server, broker } = start();
    await server.start();
    const socket = net.connect(socketPath);
    await new Promise<void>((r) => socket.once('connect', () => r()));
    socket.write(JSON.stringify({ id: 1, method: 'query', params: { env: 'api/pro', sql: 'SELECT 1', reason: 'r', wait: true } }) + '\n');
    await new Promise((r) => setTimeout(r, 100));
    expect(broker.snapshot().pending).toHaveLength(1);
    socket.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(broker.snapshot().pending).toHaveLength(1);
  });

  it('an internal failure answers internal_error without the message', async () => {
    const { socketPath, server, broker } = start();
    await server.start();
    (broker as unknown as { envs: () => never }).envs = () => {
      throw new Error('secret path /etc/x');
    };
    const reply = (await raw(socketPath, JSON.stringify({ id: 1, method: 'envs' }) + '\n')).reply!;
    expect(reply.error).toEqual({ code: 'internal_error', message: 'Internal Cais error.' });
  });
});

describe('the server only removes what it created', () => {
  const mk2 = (socketPath: string, endpointPath: string) => {
    const h = makeBroker();
    const srv = new AgentServer({ broker: h.broker, socketPath, endpointPath, platform: process.platform, pid: process.pid, appVersion: 'x' });
    return { ...h, srv };
  };

  it('a failed start (a regular file at the socket path) followed by stop() leaves that file alone', async () => {
    const victim = join(dir, 'agent.sock');
    writeFileSync(victim, 'precious');
    const m = mk2(victim, join(dir, 'agent-endpoint.json'));
    await expect(m.srv.start()).rejects.toMatchObject({ code: 'socket_path_taken' });
    await m.srv.stop(); // what AgentAccess.set(true) and the quit path both do
    expect(readFileSync(victim, 'utf8')).toBe('precious');
  });

  it('a second instance that failed with socket_in_use cannot delete the first one\'s live socket or endpoint on stop()', async () => {
    const a = mk2(join(dir, 'agent.sock'), join(dir, 'agent-endpoint.json'));
    await a.srv.start();
    const b = mk2(join(dir, 'agent.sock'), join(dir, 'agent-endpoint.json'));
    await expect(b.srv.start()).rejects.toMatchObject({ code: 'socket_in_use' });
    await b.srv.stop();
    expect(existsSync(join(dir, 'agent.sock'))).toBe(true);
    expect(existsSync(join(dir, 'agent-endpoint.json'))).toBe(true);
    expect((await send(join(dir, 'agent.sock'), 'hello', {})).kind).toBe('ok');
    await a.srv.stop();
    expect(existsSync(join(dir, 'agent.sock'))).toBe(false);
    expect(existsSync(join(dir, 'agent-endpoint.json'))).toBe(false);
  });

  it('a symlink at the socket path is refused, its target untouched, and stop() leaves the link too', async () => {
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'keep');
    symlinkSync(target, join(dir, 'agent.sock'));
    const m = mk2(join(dir, 'agent.sock'), join(dir, 'agent-endpoint.json'));
    await expect(m.srv.start()).rejects.toMatchObject({ code: 'socket_path_taken' });
    await m.srv.stop();
    expect(readFileSync(target, 'utf8')).toBe('keep');
    expect(existsSync(join(dir, 'agent.sock'))).toBe(true);
  });

  it('turning the switch OFF persists "off" even when the broker is already off after a failed start', async () => {
    const m = mk2(join(dir, 'agent.sock'), join(dir, 'agent-endpoint.json'));
    const saved: boolean[] = [];
    const settings: any = { agentAccess: true, setAgentAccess: async (v: boolean) => void saved.push(v) };
    const access = new AgentAccess({ settings, broker: m.broker, server: m.srv, onChange: () => undefined });
    m.broker.setEnabled(false);
    await access.set(false);
    expect(saved).toEqual([false]);
    // and when it is already saved as off nothing is rewritten
    settings.agentAccess = false;
    await access.set(false);
    expect(saved).toEqual([false]);
  });
});

describe('connection hygiene', () => {
  it('replies do not pile up timeout listeners on a connection', async () => {
    const { socketPath, server } = start();
    await server.start();
    const socket = net.connect(socketPath);
    await new Promise<void>((r) => socket.once('connect', () => r()));
    socket.setEncoding('utf8');
    let lines = 0;
    await new Promise<void>((resolve) => {
      socket.on('data', (c: string) => {
        lines += c.split('\n').filter(Boolean).length;
        if (lines === 30) resolve();
      });
      for (let i = 0; i < 30; i++) socket.write(JSON.stringify({ id: i, method: 'hello' }) + '\n');
    });
    const server_side = [...((server as any).connections as Set<net.Socket>)][0]!;
    expect(server_side.listenerCount('timeout')).toBe(1);
    socket.destroy();
  });

  it('a connection that sends nothing is dropped after 5 s', async () => {
    const { socketPath, server } = start();
    await server.start();
    const socket = net.connect(socketPath);
    const t0 = Date.now();
    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.on('error', () => undefined);
    });
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(4500);
    expect(waited).toBeLessThan(7500);
  }, 12_000);

  it('hostile messages never reach execution and never crash the server', async () => {
    const m = start();
    await m.server.start();
    const msgs = [
      'not json', '[]', 'null', '{"id":{"a":1},"method":"envs"}', '{"id":1,"method":"__proto__"}', '{"id":1,"method":"constructor"}',
      '{"id":1,"method":"hello","params":[]}', '{"id":1,"method":"hello","params":{"__proto__":{"x":1}}}',
      '{"id":1,"method":"query","params":{"env":"api/pro","sql":"SELECT 1","approved":true,"reason":"x"}}',
      '{"id":1,"method":"query","params":{"env":"api/pro","sql":"SELECT 1","write":"false","reason":"x"}}',
      '{"id":1,"method":"agents","params":{}}', '{"id":"' + 'x'.repeat(101) + '","method":"hello"}',
    ];
    const reply = await new Promise<string[]>((resolve) => {
      const socket = net.connect(m.socketPath);
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(msgs.join('\n') + '\n'));
      socket.on('data', (c: string) => {
        buf += c;
        if (buf.split('\n').filter(Boolean).length >= msgs.length) {
          socket.destroy();
          resolve(buf.split('\n').filter(Boolean));
        }
      });
    });
    const parsed = reply.map((l) => JSON.parse(l));
    expect(parsed.filter((p) => p.ok).length).toBeLessThanOrEqual(2); // only the two harmless hello variants
    expect(m.executor.reads.length).toBe(0);
    expect(m.broker.snapshot().pending).toHaveLength(0);
    expect(((await send(m.socketPath, 'hello', {})) as any).kind).toBe('ok');
  });
});
