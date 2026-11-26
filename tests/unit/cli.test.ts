import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { send } from '../../src/cli/client';
import { parseArgs, UsageError } from '../../src/cli/args';
import { discoverEndpoint, userDataDir } from '../../src/cli/endpoint';
import { EXIT, exitForError, exitForResult } from '../../src/cli/exit';
import { GUIDE } from '../../src/cli/guide';
import { finalExitCode, guardPipe, writeTo } from '../../src/cli/output';
import { EventEmitter } from 'node:events';

const parse = (...argv: string[]) => parseArgs(['llm', ...argv], {});

describe('cais llm: argument parsing', () => {
  it('parses query with every option', () => {
    const p = parse('query', 'api/pro', '--sql', 'SELECT 1', '--write', '--reason', 'incidente', '--database', 'app', '--max-rows', '50', '--wait', '--timeout', '30', '--client', 'Claude Code');
    expect(p.client).toBe('Claude Code');
    expect(p.command).toEqual({
      name: 'query', env: 'api/pro', sql: { kind: 'inline', sql: 'SELECT 1' }, write: true, reason: 'incidente',
      database: 'app', maxRows: 50, wait: true, timeout: 30,
    });
  });

  it('defaults: read, no wait, timeout 600, client "agente" or CAIS_CLIENT', () => {
    expect(parse('query', 'api/dev', '--sql', 'SELECT 1')).toMatchObject({ client: 'agente', command: { write: false, wait: false, timeout: 600 } });
    expect(parseArgs(['llm', 'envs'], { CAIS_CLIENT: 'Codex' }).client).toBe('Codex');
    expect(parseArgs(['llm', 'envs', '--client', 'Outro'], { CAIS_CLIENT: 'Codex' }).client).toBe('Outro');
  });

  it('takes the SQL from --file or from stdin (-), exactly one source', () => {
    expect(parse('query', 'api/dev', '--file', 'q.sql').command).toMatchObject({ sql: { kind: 'file', path: 'q.sql' } });
    expect(parse('query', 'api/dev', '-').command).toMatchObject({ sql: { kind: 'stdin' } });
    expect(() => parse('query', 'api/dev')).toThrow('exactly one option');
    expect(() => parse('query', 'api/dev', '--sql', 'a', '--file', 'b')).toThrow('exactly one option');
    expect(() => parse('query', 'api/dev', '--sql', 'a', '-')).toThrow('exactly one option');
    expect(() => parse('query', 'api/dev', '--sql', '  ')).toThrow('empty');
  });

  it('parses the other commands', () => {
    expect(parse('guide').command).toEqual({ name: 'guide' });
    expect(parse('envs').command).toEqual({ name: 'envs' });
    expect(parse('schema', 'api/dev', '--database', 'app', '--table', 'cards').command).toEqual({ name: 'schema', env: 'api/dev', database: 'app', table: 'cards' });
    expect(parse('status', 'req_1', '--wait', '--timeout', '5').command).toEqual({ name: 'status', id: 'req_1', wait: true, timeout: 5 });
    expect(parse('requests').command).toEqual({ name: 'requests', limit: 20 });
    expect(parse('requests', '--limit', '3').command).toEqual({ name: 'requests', limit: 3 });
    expect(parse('scripts', '--project', 'api').command).toEqual({ name: 'scripts', project: 'api' });
    expect(parse('script', 's1').command).toEqual({ name: 'script', id: 's1' });
    expect(parse('script-save', '--project', 'api', '--name', 'Duplicados', '--sql', 'SELECT 1', '--database', 'app').command).toEqual({
      name: 'script-save', project: 'api', scriptName: 'Duplicados', sql: { kind: 'inline', sql: 'SELECT 1' }, database: 'app',
    });
  });

  it('accepts --flag=value', () => {
    expect(parse('query', 'api/dev', '--sql=SELECT 1', '--max-rows=7').command).toMatchObject({ sql: { sql: 'SELECT 1' }, maxRows: 7 });
  });

  it('rejects what it does not know, with exit-2 usage errors', () => {
    const bad: string[][] = [
      [], ['query'], ['nope'], ['query', 'api/dev', '--sql', 'x', '--bogus'], ['query', 'api/dev', '--sql', 'x', '-z'],
      ['query', 'api/dev', '--sql', 'x', '--max-rows', '0'], ['query', 'api/dev', '--sql', 'x', '--max-rows', '1001'],
      ['query', 'api/dev', '--sql', 'x', '--max-rows', 'abc'], ['query', 'api/dev', '--sql', 'x', '--timeout', '0'],
      ['query', 'api/dev', '--sql', 'x', '--timeout', '4000'], ['query', 'a', 'b', '--sql', 'x'], ['query', 'api/dev', '--sql'],
      ['query', 'api/dev', '--sql', 'x', '--sql', 'y'], ['query', 'api/dev', '--sql', 'x', '--write=1'], ['envs', 'x'],
      ['status'], ['status', 'a', '--sql', 'x'], ['script-save', '--name', 'x', '--sql', 'y'], ['script-save', '--project', 'p', '--sql', 'y'],
      ['requests', '--limit', '101'], ['envs', '-'],
    ];
    for (const argv of bad) expect(() => parse(...argv), argv.join(' ')).toThrow(UsageError);
    expect(() => parseArgs(['envs'], {})).toThrow(UsageError);
  });

  it('has no command to approve, commit, toggle access, edit or delete', () => {
    for (const sub of ['approve', 'reject', 'commit', 'rollback', 'enable', 'script-edit', 'script-delete', 'script-update']) {
      expect(() => parse(sub, 'x'), sub).toThrow('Unknown command');
    }
  });
});

describe('cais llm: exit codes', () => {
  it('maps the final status to an exit code', () => {
    const map: [Record<string, unknown>, number][] = [
      [{ status: 'succeeded' }, 0], [{ status: 'committed' }, 0], [{ status: 'pending_approval' }, 0], [{ status: 'awaiting_commit' }, 0],
      [{ status: 'running' }, 0], [{ status: 'failed' }, 1], [{ status: 'rejected' }, 3], [{ status: 'expired' }, 3],
      [{ status: 'rolled_back' }, 3], [{ status: 'pending_approval', timed_out: true }, 5], [{ status: 'awaiting_commit', timed_out: true }, 5],
    ];
    for (const [result, code] of map) expect(exitForResult(result), JSON.stringify(result)).toBe(code);
  });

  it('maps server error codes: usage/validation/policy 2, internal 1, access off 4', () => {
    for (const code of ['invalid_params', 'ddl_or_transaction', 'writes_in_read', 'reason_required', 'queue_full', 'env_not_found', 'duplicate_name', 'not_found', 'sql_too_large']) {
      expect(exitForError(code)).toBe(EXIT.usage);
    }
    expect(exitForError('internal_error')).toBe(EXIT.failed);
    // the environment could not be reached: failed (1), not a usage error
    expect(exitForError('connection_failed')).toBe(EXIT.failed);
    expect(exitForError('credential_unavailable')).toBe(EXIT.failed);
    expect(exitForError('not_found')).toBe(EXIT.usage);
    expect(exitForError('invalid_state')).toBe(EXIT.usage);
    expect(exitForError('agent_access_off')).toBe(EXIT.unavailable);
    expect([EXIT.ok, EXIT.failed, EXIT.usage, EXIT.declined, EXIT.unavailable, EXIT.timeout]).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('cais llm: finding the endpoint', () => {
  const base = { platform: 'darwin' as const, home: '/Users/ana', pidAlive: () => true };
  const files = (map: Record<string, string>) => (path: string) => map[path] ?? null;

  it('uses CAIS_SOCKET first', () => {
    expect(discoverEndpoint({ ...base, env: { CAIS_SOCKET: '/tmp/x.sock' }, readFile: () => null })).toEqual({ socket: '/tmp/x.sock' });
  });

  it('reads agent-endpoint.json from the Cais user data folder of each platform', () => {
    expect(userDataDir({}, 'darwin', '/Users/ana')).toBe('/Users/ana/Library/Application Support/Cais');
    expect(userDataDir({}, 'linux', '/home/ana')).toBe('/home/ana/.config/Cais');
    expect(userDataDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/ana')).toBe('/cfg/Cais');
    expect(userDataDir({ APPDATA: 'C:\\Users\\ana\\AppData\\Roaming' }, 'win32', 'C:\\Users\\ana')).toContain('Cais');
    const path = '/Users/ana/Library/Application Support/Cais/agent-endpoint.json';
    const ok = JSON.stringify({ socket: '/s/agent.sock', pid: 42, protocol: 1 });
    expect(discoverEndpoint({ ...base, env: {}, readFile: files({ [path]: ok }) })).toEqual({ socket: '/s/agent.sock' });
  });

  it('is "unavailable" when the file is missing, broken, or its process is gone', () => {
    const path = '/Users/ana/Library/Application Support/Cais/agent-endpoint.json';
    expect(discoverEndpoint({ ...base, env: {}, readFile: () => null })).toMatchObject({ unavailable: true });
    expect(discoverEndpoint({ ...base, env: {}, readFile: files({ [path]: '{nope' }) })).toMatchObject({ unavailable: true });
    expect(discoverEndpoint({ ...base, env: {}, readFile: files({ [path]: JSON.stringify({ pid: 1, protocol: 1 }) }) })).toMatchObject({ unavailable: true });
    const stale = JSON.stringify({ socket: '/s', pid: 99, protocol: 1 });
    expect(discoverEndpoint({ ...base, pidAlive: () => false, env: {}, readFile: files({ [path]: stale }) })).toEqual({ unavailable: true, reason: 'stale_endpoint' });
  });

  it('checks the protocol number', () => {
    const path = '/Users/ana/Library/Application Support/Cais/agent-endpoint.json';
    const v2 = JSON.stringify({ socket: '/s', pid: 1, protocol: 2 });
    expect(discoverEndpoint({ ...base, env: {}, readFile: files({ [path]: v2 }) })).toEqual({ protocolMismatch: true });
  });
});

describe('cais llm guide', () => {
  it('explains the flow in English, with the rules that matter', () => {
    expect(GUIDE).toContain('You do not execute, you ask');
    for (const word of ['--reason', '--wait', 'awaiting', 'Rollback', 'result_withheld', 'cais llm envs', '5  wait timed out']) expect(GUIDE).toContain(word.replace('awaiting', 'Commit'));
    expect(GUIDE).not.toMatch(/!/);
    // the BigQuery section: read only, the estimate, the approval above 10 GiB and the codes
    for (const word of ['BigQuery', 'engine_read_only', '10 GiB', 'bytes_over_approved', 'bytes_billed', 'EXTERNAL_QUERY', 'system_schema', 'ML.*, AI.*']) {
      expect(GUIDE).toContain(word);
    }
  });

  it('tells who decided and that a closed pipe keeps the exit code', () => {
    for (const word of ['"decided_by": "person"', '"policy"', '"auto_commit": true', 'false (the user clicked Commit)', '| head']) expect(GUIDE).toContain(word);
  });
});

describe('cais llm: a server that never answers', () => {
  it('send() with a time limit gives up as unavailable (exit 4 path); without one it keeps waiting', async () => {
    const dir = mkdtempSync('/tmp/cais-cli-');
    const sock = join(dir, 'silent.sock');
    const server = net.createServer((c) => c.on('data', () => undefined));
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      const t0 = Date.now();
      expect(await send(sock, 'hello', {}, 300)).toEqual({ kind: 'unavailable', reason: 'timeout' });
      expect(Date.now() - t0).toBeLessThan(2000);
      const racing = await Promise.race([send(sock, 'hello', {}), new Promise((r) => setTimeout(() => r('still waiting'), 400))]);
      expect(racing).toBe('still waiting');
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a hostile reply with the wrong protocol or non-JSON is not trusted', async () => {
    const dir = mkdtempSync('/tmp/cais-cli-');
    const sock = join(dir, 'h.sock');
    let reply = '';
    const server = net.createServer((c) => c.on('data', () => c.write(reply)));
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      reply = JSON.stringify({ id: 1, ok: true, protocol: 99, result: {} }) + '\n';
      expect((await send(sock, 'envs', {})).kind).toBe('protocol');
      reply = 'garbage\n';
      expect(await send(sock, 'envs', {})).toMatchObject({ kind: 'error', code: 'bad_reply' });
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cais llm: a closed pipe is not an error', () => {
  class FakeStream extends EventEmitter {
    written: string[] = [];
    destroyed = false;
    write(chunk: string): boolean {
      this.written.push(chunk);
      return true;
    }
  }
  const pipeError = (code: string) => Object.assign(new Error(code), { code });
  const before = process.exitCode;
  afterEach(() => {
    process.exitCode = before;
  });

  it('EPIPE and ERR_STREAM_DESTROYED are ignored: no throw, the computed exit code stands, later writes are skipped', () => {
    for (const code of ['EPIPE', 'ERR_STREAM_DESTROYED']) {
      const stream = new FakeStream();
      let failures = 0;
      const state = guardPipe(stream, () => failures++);
      writeTo(stream, 'first\n');
      process.exitCode = EXIT.declined;
      expect(() => stream.emit('error', pipeError(code))).not.toThrow();
      expect(process.exitCode).toBe(EXIT.declined);
      expect(failures).toBe(0);
      expect(state).toEqual({ closed: true, failed: false });
      writeTo(stream, 'second\n');
      expect(stream.written).toEqual(['first\n']);
      expect(finalExitCode(EXIT.declined, stream)).toBe(EXIT.declined);
      expect(finalExitCode(EXIT.ok, stream)).toBe(EXIT.ok);
    }
  });

  it('with the default handler, EPIPE leaves process.exitCode untouched', () => {
    const stream = new FakeStream();
    guardPipe(stream);
    process.exitCode = EXIT.unavailable;
    stream.emit('error', pipeError('EPIPE'));
    expect(process.exitCode).toBe(EXIT.unavailable);
  });

  it('any other stream error ends with exit 1, without writing anything', () => {
    const stream = new FakeStream();
    const other = new FakeStream();
    guardPipe(stream);
    guardPipe(other);
    process.exitCode = EXIT.ok;
    expect(() => stream.emit('error', pipeError('EIO'))).not.toThrow();
    expect(process.exitCode).toBe(EXIT.failed);
    expect(stream.written).toEqual([]);
    expect(other.written).toEqual([]);
    // the code main computes later does not hide it
    expect(finalExitCode(EXIT.ok, stream, other)).toBe(EXIT.failed);
    expect(finalExitCode(EXIT.ok, other)).toBe(EXIT.ok);
    // an error with no code at all counts as another error too
    const third = new FakeStream();
    let failures = 0;
    guardPipe(third, () => failures++);
    third.emit('error', new Error('boom'));
    expect(failures).toBe(1);
  });

  it('guards once per stream, and skips a stream that is already destroyed', () => {
    const stream = new FakeStream();
    expect(guardPipe(stream)).toBe(guardPipe(stream));
    expect(stream.listenerCount('error')).toBe(1);
    stream.destroyed = true;
    writeTo(stream, 'x');
    expect(stream.written).toEqual([]);
  });
});
