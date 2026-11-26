import { EventEmitter } from 'node:events';
import {
  chmodSync,
  closeSync as closeSyncReal,
  fchmodSync as fchmodSyncReal,
  fstatSync as fstatSyncReal,
  ftruncateSync as ftruncateSyncReal,
  lstatSync as lstatSyncReal,
  openSync as openSyncReal,
  renameSync as renameSyncReal,
  rmSync as rmSyncReal,
  writeSync as writeSyncReal,
  existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileLog,
  LOG_MAX_BYTES,
  describeEvent,
  escapeLine,
  UNHANDLED_MAX_PER_WINDOW,
  UNHANDLED_WINDOW_MS,
  logProcessErrors,
  logWebContents,
  stackFrames,
  unhandledErrorEvent,
  type LogEvent,
  type LogFs,
} from '@main/log';

const roots: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cais-test-log-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const start: LogEvent = { kind: 'app-start', version: '0.2.0', platform: 'linux', arch: 'x64', electron: '41.0.0' };
const FIXED = Date.UTC(2026, 10, 26, 12, 0, 0);

function logger(dir: string, extra: { maxBytes?: number; fs?: LogFs; echo?: (line: string) => void } = {}) {
  return new FileLog({ dir: () => dir, now: () => FIXED, ...extra });
}

describe('FileLog: file', () => {
  it('writes one line per event: timestamp, level, source, message', () => {
    const dir = join(temp(), 'logs');
    const log = logger(dir);
    log.write(start);
    log.write({ kind: 'window-unresponsive' });
    const lines = readFileSync(join(dir, 'main.log'), 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('2026-11-26T12:00:00.000Z info app start version=0.2.0 platform=linux arch=x64 electron=41.0.0');
    expect(lines[1]).toBe('2026-11-26T12:00:00.000Z warn window unresponsive');
    expect(lines[2]).toBe('');
  });

  it('creates the folder and the file only on the first write, with modes 0700 and 0600', () => {
    const dir = join(temp(), 'a', 'logs');
    const log = logger(dir);
    expect(existsSync(dir)).toBe(false);
    log.write(start);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'main.log')).mode & 0o777).toBe(0o600);
  });

  it('keeps the file at 0600 even under a permissive umask', () => {
    const dir = temp();
    const old = process.umask(0);
    try {
      logger(dir).write(start);
    } finally {
      process.umask(old);
    }
    expect(statSync(join(dir, 'main.log')).mode & 0o777).toBe(0o600);
  });

  it('appends to an existing file', () => {
    const dir = temp();
    writeFileSync(join(dir, 'main.log'), 'previous line\n', { mode: 0o600 });
    logger(dir).write(start);
    expect(readFileSync(join(dir, 'main.log'), 'utf8').startsWith('previous line\n2026-')).toBe(true);
  });

  it('rotates at 1 MB: main.log becomes main.old.log (replacing the older one) and a new main.log starts', () => {
    const dir = temp();
    expect(LOG_MAX_BYTES).toBe(1024 * 1024);
    writeFileSync(join(dir, 'main.log'), 'x'.repeat(LOG_MAX_BYTES), { mode: 0o600 });
    writeFileSync(join(dir, 'main.old.log'), 'ancient\n');
    logger(dir).write(start);
    expect(readFileSync(join(dir, 'main.old.log'), 'utf8')).toBe('x'.repeat(LOG_MAX_BYTES));
    const current = readFileSync(join(dir, 'main.log'), 'utf8');
    expect(current.split('\n')).toHaveLength(2);
    expect(current).toContain(' app start ');
    expect(statSync(join(dir, 'main.log')).mode & 0o777).toBe(0o600);
  });

  it('does not rotate below the limit, and never keeps more than two files', () => {
    const dir = temp();
    writeFileSync(join(dir, 'main.log'), 'x'.repeat(LOG_MAX_BYTES - 1), { mode: 0o600 });
    const log = logger(dir);
    log.write({ kind: 'window-responsive' });
    expect(existsSync(join(dir, 'main.old.log'))).toBe(false);
    log.write({ kind: 'window-responsive' });
    log.write({ kind: 'window-responsive' });
    expect(existsSync(join(dir, 'main.old.log'))).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(['main.log', 'main.old.log']);
  });

  it('rotates with a small limit, across many writes', () => {
    const dir = temp();
    const log = logger(dir, { maxBytes: 300 });
    for (let i = 0; i < 20; i++) log.write(start);
    expect(statSync(join(dir, 'main.log')).size).toBeLessThan(300 + 200);
    expect(existsSync(join(dir, 'main.old.log'))).toBe(true);
  });

  it('never throws when the folder cannot be written', () => {
    const dir = temp();
    const blocked = join(dir, 'blocked');
    mkdirSync(blocked);
    chmodSync(blocked, 0o500);
    const echoed: string[] = [];
    try {
      const log = logger(join(blocked, 'logs'), { echo: (line) => echoed.push(line) });
      expect(() => log.write(start)).not.toThrow();
      expect(() => log.write({ kind: 'window-unresponsive' })).not.toThrow();
    } finally {
      chmodSync(blocked, 0o700);
    }
    // a warning still reaches the console even though the file could not be written
    expect(echoed).toHaveLength(1);
  });

  it('never throws when the folder path is a file, or when the folder lookup itself throws', () => {
    const dir = temp();
    const file = join(dir, 'file');
    writeFileSync(file, 'x');
    expect(() => logger(join(file, 'logs')).write(start)).not.toThrow();
    const broken = new FileLog({
      dir: () => {
        throw new Error('no logs path');
      },
    });
    expect(() => broken.write(start)).not.toThrow();
  });

  it('never throws when the echo does', () => {
    const dir = temp();
    const log = logger(dir, {
      echo: () => {
        throw new Error('console is gone');
      },
    });
    expect(() => log.write({ kind: 'window-unresponsive' })).not.toThrow();
  });

  it('survives a file system that fails on every call', () => {
    const boom = () => {
      throw new Error('EIO');
    };
    const fs: LogFs = {
      mkdirSync: boom,
      lstatSync: boom,
      chmodSync: boom,
      openSync: boom,
      fstatSync: boom,
      fchmodSync: boom,
      ftruncateSync: boom,
      writeSync: boom,
      closeSync: boom,
      renameSync: boom,
      rmSync: boom,
    };
    expect(() => logger(temp(), { fs }).write(start)).not.toThrow();
  });

  it('echoes warnings and errors to the console, not info', () => {
    const echoed: string[] = [];
    const log = logger(temp(), { echo: (line) => echoed.push(line) });
    log.write(start);
    log.write({ kind: 'window-responsive' });
    log.write({ kind: 'window-load-failed', errorCode: -6 });
    expect(echoed).toEqual(['2026-11-26T12:00:00.000Z error window load failed errorCode=-6']);
  });
});

describe('FileLog: links, modes and rotation failures', () => {
  it('does not follow a symlink at main.log: the target stays untouched and nothing is created', () => {
    const dir = temp();
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'precious\n', { mode: 0o644 });
    const logs = join(dir, 'logs');
    mkdirSync(logs, { mode: 0o700 });
    symlinkSync(target, join(logs, 'main.log'));
    expect(() => logger(logs).write(start)).not.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('precious\n');
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  it('does not create a file through a dangling symlink', () => {
    const dir = temp();
    const logs = join(dir, 'logs');
    mkdirSync(logs, { mode: 0o700 });
    const target = join(dir, 'created-by-link.txt');
    symlinkSync(target, join(logs, 'main.log'));
    logger(logs).write(start);
    expect(existsSync(target)).toBe(false);
  });

  it('refuses a hard-linked main.log', () => {
    const dir = temp();
    const other = join(dir, 'other.txt');
    writeFileSync(other, 'mine\n', { mode: 0o644 });
    const logs = join(dir, 'logs');
    mkdirSync(logs, { mode: 0o700 });
    linkSync(other, join(logs, 'main.log'));
    logger(logs).write(start);
    expect(readFileSync(other, 'utf8')).toBe('mine\n');
  });

  it('refuses a logs folder that is a symlink', () => {
    const dir = temp();
    const real = join(dir, 'real');
    mkdirSync(real);
    const link = join(dir, 'logs');
    symlinkSync(real, link);
    logger(link).write(start);
    expect(readdirSync(real)).toEqual([]);
  });

  it('brings a pre-existing 0644 file to 0600 and a 0755 folder to 0700', () => {
    const dir = temp();
    const logs = join(dir, 'logs');
    mkdirSync(logs, { mode: 0o755 });
    chmodSync(logs, 0o755);
    writeFileSync(join(logs, 'main.log'), 'previous\n', { mode: 0o644 });
    chmodSync(join(logs, 'main.log'), 0o644);
    logger(logs).write(start);
    expect(statSync(logs).mode & 0o777).toBe(0o700);
    expect(statSync(join(logs, 'main.log')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(logs, 'main.log'), 'utf8').startsWith('previous\n2026-')).toBe(true);
  });

  it('keeps logging when the rotation rename fails because main.old.log is a non-empty folder', () => {
    const dir = temp();
    mkdirSync(join(dir, 'main.old.log'));
    writeFileSync(join(dir, 'main.old.log', 'keep'), 'x');
    const log = logger(dir, { maxBytes: 100 });
    writeFileSync(join(dir, 'main.log'), 'x'.repeat(200), { mode: 0o600 });
    for (let i = 0; i < 5; i++) log.write({ kind: 'window-responsive' });
    const text = readFileSync(join(dir, 'main.log'), 'utf8');
    expect(statSync(join(dir, 'main.log')).size).toBeLessThan(200);
    expect(text).not.toContain('xxxx');
    expect(text.trimEnd().split('\n').length).toBeGreaterThanOrEqual(1);
    expect(text).toContain(' window responsive again');
  });

  it('replaces an old log that cannot be renamed over by removing it first', () => {
    const dir = temp();
    writeFileSync(join(dir, 'main.old.log'), 'ancient\n');
    writeFileSync(join(dir, 'main.log'), 'y'.repeat(150), { mode: 0o600 });
    let failures = 1;
    const fs: LogFs = {
      mkdirSync: (path, options) => void mkdirSync(path, options),
      lstatSync: (path) => lstatSyncReal(path),
      chmodSync: (path, mode) => chmodSync(path, mode),
      openSync: (path, flags, mode) => openSyncReal(path, flags, mode),
      fstatSync: (fd) => fstatSyncReal(fd),
      fchmodSync: (fd, mode) => fchmodSyncReal(fd, mode),
      ftruncateSync: (fd, length) => ftruncateSyncReal(fd, length),
      writeSync: (fd, data) => void writeSyncReal(fd, data),
      closeSync: (fd) => closeSyncReal(fd),
      renameSync: (from, to) => {
        if (failures-- > 0) throw new Error('EBUSY');
        renameSyncReal(from, to);
      },
      rmSync: (path, options) => rmSyncReal(path, options),
    };
    logger(dir, { fs, maxBytes: 100 }).write(start);
    expect(readFileSync(join(dir, 'main.old.log'), 'utf8')).toBe('y'.repeat(150));
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toContain(' app start ');
  });

  it('empties main.log as a last resort when nothing can be renamed', () => {
    const dir = temp();
    writeFileSync(join(dir, 'main.log'), 'z'.repeat(300), { mode: 0o600 });
    const fs: LogFs = {
      mkdirSync: (path, options) => void mkdirSync(path, options),
      lstatSync: (path) => lstatSyncReal(path),
      chmodSync: (path, mode) => chmodSync(path, mode),
      openSync: (path, flags, mode) => openSyncReal(path, flags, mode),
      fstatSync: (fd) => fstatSyncReal(fd),
      fchmodSync: (fd, mode) => fchmodSyncReal(fd, mode),
      ftruncateSync: (fd, length) => ftruncateSyncReal(fd, length),
      writeSync: (fd, data) => void writeSyncReal(fd, data),
      closeSync: (fd) => closeSyncReal(fd),
      renameSync: () => {
        throw new Error('EPERM');
      },
      rmSync: () => {
        throw new Error('EPERM');
      },
    };
    logger(dir, { fs, maxBytes: 100 }).write(start);
    const text = readFileSync(join(dir, 'main.log'), 'utf8');
    expect(text).not.toContain('zzz');
    expect(text).toContain(' app start ');
  });
});

describe('FileLog: error loops are rate limited', () => {
  it('an echo that raises another uncaught error does not flood the file, and the rest is counted', () => {
    const dir = temp();
    const proc = new EventEmitter();
    let now = FIXED;
    const log = new FileLog({
      dir: () => dir,
      now: () => now,
      echo: () => {
        // a console write to a dead pipe becomes an uncaught exception, which is logged again
        proc.emit('uncaughtExceptionMonitor', new Error('EPIPE'), 'uncaughtException');
      },
    });
    logProcessErrors(proc, log.sink);
    proc.emit('uncaughtExceptionMonitor', new Error('boom'), 'uncaughtException');
    const lines = readFileSync(join(dir, 'main.log'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(UNHANDLED_MAX_PER_WINDOW);
    now += UNHANDLED_WINDOW_MS;
    log.write({ kind: 'window-responsive' });
    const after = readFileSync(join(dir, 'main.log'), 'utf8').trimEnd().split('\n');
    expect(after.some((line) => / warn main unhandled errors suppressed count=\d+$/.test(line))).toBe(true);
    expect(after.at(-1)).toContain('responsive again');
  });

  it('other events are never limited', () => {
    const dir = temp();
    const log = logger(dir);
    for (let i = 0; i < 50; i++) log.write({ kind: 'window-responsive' });
    expect(readFileSync(join(dir, 'main.log'), 'utf8').trimEnd().split('\n')).toHaveLength(50);
  });
});

describe('escaping', () => {
  it('turns every control character into an escape: one event is one line', () => {
    expect(escapeLine('a\nb\r\nc\td\u0000e\u2028f')).toBe('a\\nb\\r\\nc\\td\\u0000e\\u2028f');
  });

  it('a value with newlines in a typed field cannot make a second line', () => {
    const dir = temp();
    const evil = { kind: 'unhandled-error', origin: 'exception', name: 'X\n2026-01-01 info app forged', frames: ['a.js:1:1\nforged'] } as LogEvent;
    logger(dir).write(evil);
    const text = readFileSync(join(dir, 'main.log'), 'utf8');
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(text).not.toContain('forged');
    expect(text).toContain('name=Error frames=none');
  });
});

describe('describeEvent: closed values', () => {
  it('replaces a value that does not fit with unknown', () => {
    const odd = {
      kind: 'app-start',
      version: 'hunter2 secret',
      platform: 'maria@empresa.com',
      arch: 'select * from users',
      electron: '41.0.0 db.internal.example',
    } as unknown as LogEvent;
    expect(describeEvent(odd).message).toBe('start version=unknown platform=unknown arch=unknown electron=unknown');
  });

  it('keeps a prerelease version and drops anything free-form', () => {
    expect(describeEvent({ ...start, version: '0.3.0-beta.1' } as LogEvent).message).toContain('version=0.3.0-beta.1 ');
  });

  it('checks the version-check reason and the duration', () => {
    const line = (reason: string, ms: number) => describeEvent({ kind: 'update-check-failed', reason, ms } as LogEvent).message;
    expect(line('http-503', 12.4)).toBe('version check failed reason=http-503 ms=12');
    expect(line('http-503 token=abc', 5)).toContain('reason=unknown');
    expect(line('http-99', 5)).toContain('reason=unknown');
    expect(line('timeout', -5)).toContain('ms=0');
    expect(line('timeout', Number.NaN)).toContain('ms=unknown');
  });

  it('checks the render process reason and codes', () => {
    expect(describeEvent({ kind: 'render-process-gone', reason: 'oom', exitCode: 9 }).message).toBe('render process gone reason=oom exitCode=9');
    expect(describeEvent({ kind: 'render-process-gone', reason: 'because of /home/x' as never, exitCode: 1.5 }).message).toBe(
      'render process gone reason=unknown exitCode=unknown',
    );
  });
});

describe('unhandled errors drop the message', () => {
  const secrets = ['hunter2-p4ssw0rd', 'SELECT * FROM clientes WHERE cpf', 'db-prod.internal.example.com', 'maria@empresa.com'];

  function failing(): Error {
    const error = new Error(`ER_ACCESS_DENIED for ${secrets[3]}@${secrets[2]}: using password ${secrets[0]}\n${secrets[1]} = '123'\n    at fake (/home/maria/segredo.sql:1:1)`);
    error.name = 'CaisError';
    (error as NodeJS.ErrnoException).code = 'ER_ACCESS_DENIED_ERROR';
    return error;
  }

  it('logs the name, the short code and the frames, and none of the message', () => {
    const dir = temp();
    const log = logger(dir);
    log.write(unhandledErrorEvent('exception', failing(), '/opt/Cais/resources/app.asar'));
    const text = readFileSync(join(dir, 'main.log'), 'utf8');
    expect(text).toContain(' error main unhandled exception name=CaisError code=ER_ACCESS_DENIED_ERROR frames=');
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toContain('maria');
    expect(text).not.toContain('segredo');
    expect(text.trimEnd().split('\n')).toHaveLength(1);
  });

  it('keeps frames as file:line:col: relative inside the app bundle, the base name outside, nothing for native ones', () => {
    const stack = [
      'Error: boom',
      '    at run (/opt/Cais/resources/app.asar/out/main/index.js:10:20)',
      '    at /opt/Cais/resources/app.asar/node_modules/mysql2/lib/x.js:1:2',
      '    at helper (/home/maria/Documents/projeto/script.js:3:4)',
      '    at file:///home/maria/other/mod.mjs:5:6',
      '    at async Promise.all (index 0)',
      '    at new Promise (<anonymous>)',
      '    at node:internal/process/task_queues:95:5',
      '    at C:\\Users\\maria\\app\\win.js:7:8',
    ].join('\n');
    expect(stackFrames(stack, 'boom', '/opt/Cais/resources/app.asar')).toEqual([
      'out/main/index.js:10:20',
      'node_modules/mysql2/lib/x.js:1:2',
      'script.js:3:4',
      'mod.mjs:5:6',
      'node:internal/process/task_queues:95:5',
      'win.js:7:8',
    ]);
  });

  it('a multi-line message cannot pass for frames', () => {
    const message = 'line one\n    at /home/maria/secret-path/credentials.js:1:1\nlast';
    const stack = `Error: ${message}\n    at real (/app/out/main/index.js:2:3)`;
    expect(stackFrames(stack, message, '/app')).toEqual(['out/main/index.js:2:3']);
  });

  const leaks = ['ana@exemplo.com', 'db.prod.internal', '3306', 'SELECT', 'ya29.a0AfH6SMBtoken', 'hunter2'];
  const noLeak = (text: string) => {
    for (const leak of leaks) expect(text).not.toContain(leak);
  };

  it('a message changed after the stack was formatted yields no frames, not the old header', () => {
    const e = new Error('near x\n    at ana@exemplo.com:1:1\n    at db.prod.internal:3306:0\n    at SELECT password FROM users:1:1');
    void e.stack;
    e.message = 'wrapped';
    const event = unhandledErrorEvent('exception', e, '/app');
    expect(event).toMatchObject({ frames: [] });
    noLeak(describeEvent(event).message);
  });

  it('a message emptied after the stack was formatted cannot pass the old header as frames', () => {
    const e = new Error('Access denied\n    at /home/alice/prod-db-hunter2.js:1:1');
    void e.stack;
    e.message = '';
    const frames = stackFrames(e.stack as string, e.message, '/app');
    expect(frames.join('\n')).not.toContain('prod-db-hunter2');
  });

  it('a shorter message found inside the old header cannot pass its tail as frames', () => {
    const e = new Error('SELECT secret\n    at /var/lib/acme/customers.js:9:9');
    void e.stack;
    e.message = 'SELECT';
    const frames = stackFrames(e.stack as string, e.message, '/app');
    expect(frames.join('\n')).not.toContain('customers.js');
  });

  it('keeps frames for a message changed before the stack was read, Node internal errors and ENOENT', () => {
    const e = new Error('first');
    e.message = 'changed';
    expect(stackFrames(e.stack as string, e.message, '/app').length).toBeGreaterThan(0);
    const stack = 'TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be string\n    at /app/out/main/index.js:1:2';
    expect(stackFrames(stack, 'The "path" argument must be string', '/app')).toEqual(['out/main/index.js:1:2']);
    let enoent: Error | undefined;
    try {
      readFileSync('/nonexistent/cais-test-file');
    } catch (err) {
      enoent = err as Error;
    }
    expect(stackFrames(enoent?.stack ?? '', enoent?.message ?? '', '/app').length).toBeGreaterThan(0);
  });

  it('an empty message with a hand-set stack drops only the first line, and a token in a location is no frame', () => {
    const e = new Error('');
    e.stack = 'Error\n    at ya29.a0AfH6SMBtoken:1:1\n    at /app/out/main/index.js:4:5';
    const event = unhandledErrorEvent('exception', e, '/app');
    expect(event).toMatchObject({ frames: ['out/main/index.js:4:5'] });
    noLeak(describeEvent(event).message);
  });

  it('a plain object with a stack is NonError with no frames', () => {
    const event = unhandledErrorEvent('rejection', { name: 'Error', message: 'x', stack: 'at hunter2-password:1:1\n    at /app/a.js:1:1' }, '/app');
    expect(event).toEqual({ kind: 'unhandled-error', origin: 'rejection', name: 'NonError', frames: [] });
    noLeak(describeEvent(event).message);
  });

  it('a header that is not the message cannot pass a host, an email or SQL as a frame', () => {
    const stack = ['Error: other', '    at 10.0.0.12:3306:0', '    at db-prod.internal.example.com:3306:1', '    at loader:647:26', '    at ana@exemplo.com:1:1', '    at /app/out/main/ok.js:1:2'].join('\n');
    expect(stackFrames(stack, 'other', '/app')).toEqual(['out/main/ok.js:1:2']);
    expect(stackFrames(stack, 'not in the stack', '/app')).toEqual([]);
    const forged = { kind: 'unhandled-error', origin: 'exception', name: 'Error', frames: ['10.0.0.12:3306:0', 'ana@exemplo.com:1:1', 'SELECT password FROM users:1:1', '../../etc/x.js:1:1', 'ok.js:1:1'] } as LogEvent;
    expect(describeEvent(forged).message).toBe('unhandled exception name=Error frames=ok.js:1:1');
  });

  it('keeps only paths, file URLs and node: locations with a script file name', () => {
    const stack = [
      'Error: m',
      '    at a (relative/path.js:1:1)',
      '    at b (/home/maria/proj/data file.js:1:1)',
      '    at c (/home/maria/proj/notes.txt:1:1)',
      '    at d (/app/../etc/passwd.js:1:1)',
      '    at e (/app/out/main/index.js:1:1)',
    ].join('\n');
    expect(stackFrames(stack, 'm', '/app')).toEqual(['out/main/index.js:1:1']);
  });

  it('name comes from a closed list and the code from the Node and MySQL families', () => {
    const named = Object.assign(new Error('x'), { name: 'ana_exemplo_com', code: 'PRODDB_HUNTER2' });
    const event = unhandledErrorEvent('exception', named) as { name: string; code?: string };
    expect(event.name).toBe('Error');
    expect(event.code).toBeUndefined();
    for (const code of ['ECONNRESET', 'ERR_INVALID_ARG_TYPE', 'ER_ACCESS_DENIED_ERROR']) {
      expect((unhandledErrorEvent('exception', Object.assign(new Error('x'), { code })) as { code?: string }).code).toBe(code);
    }
    expect(describeEvent({ kind: 'unhandled-error', origin: 'exception', name: 'ana_exemplo_com', code: 'PRODDB_HUNTER2', frames: [] }).message).toBe(
      'unhandled exception name=Error frames=none',
    );
  });

  it('keeps a code only when it is a Node or MySQL error code', () => {
    const odd = Object.assign(new Error('x'), { code: 'password is hunter2' });
    expect(unhandledErrorEvent('exception', odd)).toMatchObject({ name: 'Error' });
    expect((unhandledErrorEvent('exception', odd) as { code?: string }).code).toBeUndefined();
    const ok = Object.assign(new Error('x'), { code: 'ECONNRESET' });
    expect((unhandledErrorEvent('rejection', ok) as { code?: string }).code).toBe('ECONNRESET');
  });

  it('a thrown string or object is NonError with no content, and a hostile getter does not break it', () => {
    expect(unhandledErrorEvent('rejection', 'hunter2')).toEqual({ kind: 'unhandled-error', origin: 'rejection', name: 'NonError', frames: [] });
    const hostile = {
      get name(): string {
        throw new Error('nope');
      },
    };
    expect(() => unhandledErrorEvent('exception', hostile)).not.toThrow();
    expect(describeEvent(unhandledErrorEvent('exception', null)).message).toBe('unhandled exception name=NonError frames=none');
  });

  it('caps the frames', () => {
    const stack = ['Error: x', ...Array.from({ length: 50 }, (_, i) => `    at f (/a/b.js:${i + 1}:1)`)].join('\n');
    expect(stackFrames(stack, 'x')).toHaveLength(10);
  });

  it('the process hooks log uncaught exceptions (once) and unhandled rejections, without the message', () => {
    const proc = new EventEmitter();
    const seen: LogEvent[] = [];
    logProcessErrors(proc, (event) => seen.push(event), '/app');
    proc.emit('uncaughtExceptionMonitor', failing(), 'uncaughtException');
    // Node also reports a rejection it turned into an exception: only the rejection listener logs it
    proc.emit('uncaughtExceptionMonitor', failing(), 'unhandledRejection');
    proc.emit('unhandledRejection', failing(), Promise.resolve());
    expect(seen.map((e) => (e as { origin: string }).origin)).toEqual(['exception', 'rejection']);
    const text = seen.map((e) => describeEvent(e).message).join('\n');
    for (const secret of secrets) expect(text).not.toContain(secret);
  });
});

describe('window events', () => {
  it('logs the render process going away, with reason and exit code only', () => {
    const contents = new EventEmitter();
    const seen: LogEvent[] = [];
    logWebContents(contents, (event) => seen.push(event));
    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139, extra: 'https://example.com/private' });
    expect(seen).toEqual([{ kind: 'render-process-gone', reason: 'crashed', exitCode: 139 }]);
    expect(describeEvent(seen[0]!)).toEqual({ level: 'error', source: 'window', message: 'render process gone reason=crashed exitCode=139' });
  });

  it('logs unresponsive, responsive and a failed load (the error code, never the URL)', () => {
    const contents = new EventEmitter();
    const seen: LogEvent[] = [];
    logWebContents(contents, (event) => seen.push(event));
    contents.emit('unresponsive');
    contents.emit('responsive');
    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://secret.example/path?token=1', true);
    expect(seen).toEqual([{ kind: 'window-unresponsive' }, { kind: 'window-responsive' }, { kind: 'window-load-failed', errorCode: -105 }]);
    expect(JSON.stringify(seen)).not.toContain('secret');
  });

  it('ignores a failed subframe and a cancelled navigation (ERR_ABORTED)', () => {
    const contents = new EventEmitter();
    const seen: LogEvent[] = [];
    logWebContents(contents, (event) => seen.push(event));
    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://x.example/', false);
    contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://localhost:5173/', true);
    expect(seen).toEqual([]);
  });

  it('passes an unhandled rejection to the console hook, which cannot break the log', () => {
    const proc = new EventEmitter();
    const seen: LogEvent[] = [];
    const reasons: unknown[] = [];
    logProcessErrors(proc, (event) => seen.push(event), '/app', (reason) => {
      reasons.push(reason);
      throw new Error('console gone');
    });
    const reason = new Error('boom');
    expect(() => proc.emit('unhandledRejection', reason, Promise.resolve())).not.toThrow();
    expect(reasons).toEqual([reason]);
    expect(seen).toHaveLength(1);
  });
});
