import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_LOCALE, renderRef, setLocale } from '@shared/i18n';
import type { CaisError } from '@main/errors';
import { GcloudTokenProvider, type ChildLike, type SpawnFn } from '@main/auth/gcloud';

interface Call {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}
interface Reply {
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: NodeJS.ErrnoException;
}

function fakeSpawn(handler: (call: Call) => Reply): { spawn: SpawnFn; calls: Call[] } {
  const calls: Call[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const call = { command, args, env: options.env };
    calls.push(call);
    const reply = handler(call);
    const child = new EventEmitter() as EventEmitter & ChildLike;
    const out = new EventEmitter();
    const err = new EventEmitter();
    Object.assign(child, { stdout: out, stderr: err, kill: () => undefined });
    setImmediate(() => {
      if (reply.error) {
        child.emit('error', reply.error);
        return;
      }
      if (reply.stdout) out.emit('data', Buffer.from(reply.stdout));
      if (reply.stderr) err.emit('data', Buffer.from(reply.stderr));
      child.emit('close', reply.code ?? 0);
    });
    return child;
  };
  return { spawn, calls };
}

function provider(
  handler: (call: Call) => Reply,
  opts: { existing?: string[]; env?: NodeJS.ProcessEnv; now?: () => number } = {},
) {
  const { spawn, calls } = fakeSpawn(handler);
  const existing = new Set(opts.existing ?? ['/usr/local/bin/gcloud']);
  const p = new GcloudTokenProvider({
    spawn,
    env: opts.env ?? { PATH: '/usr/local/bin:/usr/bin' },
    platform: 'darwin',
    homedir: '/Users/x',
    exists: (path) => existing.has(path),
    now: opts.now ?? (() => 0),
  });
  return { p, calls };
}

describe('GcloudTokenProvider: tokens', () => {
  it('runs generate-login-token with the account and trims stdout', async () => {
    const { p, calls } = provider(() => ({ stdout: 'tok-123\n' }));
    expect(await p.getToken('maria@empresa.com')).toBe('tok-123');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('/usr/local/bin/gcloud');
    expect(calls[0]!.args).toEqual(['sql', 'generate-login-token', '--account=maria@empresa.com']);
  });

  it('passes the impersonated service account', async () => {
    const { p, calls } = provider(() => ({ stdout: 'tok' }));
    await p.getToken('maria@empresa.com', 'sa@p.iam.gserviceaccount.com');
    expect(calls[0]!.args).toEqual([
      'sql',
      'generate-login-token',
      '--account=maria@empresa.com',
      '--impersonate-service-account=sa@p.iam.gserviceaccount.com',
    ]);
  });

  it('caches for 50 minutes per (account, service account)', async () => {
    let now = 0;
    let n = 0;
    const { p, calls } = provider(() => ({ stdout: `tok-${++n}` }), { now: () => now });
    expect(await p.getToken('a@x.com')).toBe('tok-1');
    now = 49 * 60 * 1000;
    expect(await p.getToken('a@x.com')).toBe('tok-1');
    expect(await p.getToken('a@x.com', 'sa@p.iam.gserviceaccount.com')).toBe('tok-2'); // other key
    expect(await p.getToken('b@x.com')).toBe('tok-3');
    now = 51 * 60 * 1000;
    expect(await p.getToken('a@x.com')).toBe('tok-4');
    expect(calls).toHaveLength(4);
  });

  it('coalesces concurrent requests and does not cache failures', async () => {
    let n = 0;
    const { p, calls } = provider(() => (++n === 1 ? { code: 1, stderr: 'boom' } : { stdout: 'ok' }));
    const [a, b] = await Promise.allSettled([p.getToken('a@x.com'), p.getToken('a@x.com')]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect(calls).toHaveLength(1);
    expect(await p.getToken('a@x.com')).toBe('ok');
  });

  it('explains reauthentication', async () => {
    const { p } = provider(() => ({
      code: 1,
      stderr: 'ERROR: There was a problem refreshing your current auth tokens: Reauthentication failed.',
    }));
    await expect(p.getToken('maria@empresa.com')).rejects.toThrow(
      'A conta maria@empresa.com precisa entrar de novo: rode `gcloud auth login maria@empresa.com` no terminal.',
    );
  });

  it('surfaces other failures without leaking more than the first stderr line', async () => {
    const { p } = provider(() => ({ code: 1, stderr: 'ERROR: permission denied\nsecond line' }));
    const error = await p.getToken('a@x.com').catch((e: Error) => e);
    expect((error as Error).message).toContain('permission denied');
    expect((error as Error).message).not.toContain('second line');
  });

  it('rejects an empty token', async () => {
    const { p } = provider(() => ({ stdout: '  \n' }));
    await expect(p.getToken('a@x.com')).rejects.toThrow('não devolveu um token');
  });
});

describe('GcloudTokenProvider: stderr sanitizing', () => {
  it('never lets a token-shaped string reach the error message', async () => {
    const secret = 'ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const long = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEf';
    const { p } = provider(() => ({ code: 1, stderr: `ERROR: bad ${secret} and ${long} end` }));
    const error = (await p.getToken('a@x.com').catch((e: Error) => e)) as Error;
    expect(error.message).not.toContain('ya29');
    expect(error.message).not.toContain(long);
    expect(error.message).toContain('[removido]');
    expect(error.message.length).toBeLessThan(400);
  });
});

describe('GcloudTokenProvider: accounts', () => {
  it('lists accounts from auth list --format=json', async () => {
    const { p, calls } = provider(() => ({
      stdout: JSON.stringify([
        { account: 'a@x.com', status: 'ACTIVE' },
        { account: 'b@x.com', status: '' },
      ]),
    }));
    expect(await p.listAccounts()).toEqual([
      { account: 'a@x.com', status: 'ACTIVE' },
      { account: 'b@x.com', status: '' },
    ]);
    expect(calls[0]!.args).toEqual(['auth', 'list', '--format=json']);
  });

  it('only ever runs the two read-only subcommands', async () => {
    const { p, calls } = provider(() => ({ stdout: '[]' }));
    await p.listAccounts();
    await p.getToken('a@x.com').catch(() => undefined);
    for (const c of calls) {
      expect(['auth list', 'sql generate-login-token']).toContain(c.args.slice(0, 2).join(' '));
    }
  });
});

describe('GcloudTokenProvider: binary discovery', () => {
  it('prefers the PATH', async () => {
    const { p } = provider(() => ({ stdout: '[]' }), {
      existing: ['/custom/bin/gcloud', '/opt/homebrew/bin/gcloud'],
      env: { PATH: '/custom/bin' },
    });
    expect(await p.locate()).toBe('/custom/bin/gcloud');
  });

  it('asks a login shell when the PATH does not have it (Finder launch)', async () => {
    const { p, calls } = provider(
      (call) => (call.command === '/bin/zsh' ? { stdout: '/Users/x/sdk/bin/gcloud\n' } : { stdout: '[]' }),
      { existing: ['/Users/x/sdk/bin/gcloud'], env: { PATH: '/usr/bin', SHELL: '/bin/zsh' } },
    );
    expect(await p.locate()).toBe('/Users/x/sdk/bin/gcloud');
    expect(calls[0]).toMatchObject({ command: '/bin/zsh', args: ['-lc', 'command -v gcloud'] });
    await p.locate();
    expect(calls).toHaveLength(1); // looked up once
  });

  it('falls back to the well-known locations', async () => {
    const { p } = provider(() => ({ code: 1 }), {
      existing: ['/opt/homebrew/bin/gcloud'],
      env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
    });
    expect(await p.locate()).toBe('/opt/homebrew/bin/gcloud');
  });

  it('checks ~/google-cloud-sdk', async () => {
    const { p } = provider(() => ({ code: 1 }), {
      existing: ['/Users/x/google-cloud-sdk/bin/gcloud'],
      env: { PATH: '' },
    });
    expect(await p.locate()).toBe('/Users/x/google-cloud-sdk/bin/gcloud');
  });

  it('reports a missing gcloud with the documented message', async () => {
    const { p, calls } = provider(() => ({ code: 1 }), { existing: [], env: { PATH: '/usr/bin', SHELL: '/bin/zsh' } });
    await expect(p.getToken('a@x.com')).rejects.toThrow(
      'gcloud não encontrado. Instale o Google Cloud SDK ou abra o Cais pelo terminal.',
    );
    await expect(p.listAccounts()).rejects.toThrow('gcloud não encontrado');
    expect(calls.every((c) => c.args[0] === '-lc')).toBe(true); // never ran gcloud itself
  });
});

describe('GcloudTokenProvider messages in English', () => {
  afterEach(() => setLocale('pt-BR'));

  it('the person reads English, the ref renders in pt-BR, gcloud output is never translated', async () => {
    setLocale('en');
    const { p } = provider(() => ({ code: 1, stderr: 'ERROR: permission denied\nsecond line' }));
    const error = (await p.getToken('a@x.com').catch((e: unknown) => e)) as CaisError;
    expect(error.message).toBe('gcloud did not generate the login token for the account a@x.com. ERROR: permission denied');
    expect(renderRef(error.ref!, AGENT_LOCALE)).toBe('O gcloud não gerou o token de login da conta a@x.com. ERROR: permission denied');
    const reauth = provider(() => ({ code: 1, stderr: 'Reauthentication required' })).p;
    await expect(reauth.getToken('a@x.com')).rejects.toThrow('The account a@x.com needs to sign in again: run `gcloud auth login a@x.com` in the terminal.');
    const missing = provider(() => ({}), { existing: [], env: { PATH: '/nowhere' } }).p;
    await expect(missing.listAccounts()).rejects.toThrow('gcloud not found. Install the Google Cloud SDK or open Cais from the terminal.');
  });
});
