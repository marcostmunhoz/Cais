import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * The local file log of the main process (`main.log`, plus `main.old.log` after a rotation).
 *
 * It is allowlist-only: `FileLog.write` takes a `LogEvent`, a closed union of typed events, and builds the line itself.
 * There is no `log(message: string)`. Every field is validated again when the line is built (a version looks like a
 * version, a reason is one of a closed list, a code is a Node or MySQL error code, a name is on a closed list), so a value that does not fit becomes
 * `unknown` instead of reaching the file. What never goes in: SQL, results, database or `gcloud` messages, hosts,
 * users, names, ids, tokens, passwords, emails, paths of the user's files, agent request content, URLs.
 * The file stays on the machine. See docs/security.md.
 */

export type LogLevel = 'info' | 'warn' | 'error';

/** Why a version check failed. A closed list: nothing from the response (body or headers) is ever kept. */
export type UpdateFailureReason =
  | `http-${number}`
  | 'timeout'
  | 'network'
  | 'body-too-large'
  | 'invalid-json'
  | 'invalid-shape'
  | 'invalid-current-version';

/** The only three `gcloud` commands Cais runs, by id. */
export type GcloudCommandId = 'auth-list' | 'sql-login-token' | 'print-access-token';

/** How a `gcloud` command failed. Never what it printed. */
export type GcloudOutcome = 'exit' | 'signal' | 'timeout' | 'spawn-error' | 'not-found';

export type RenderGoneReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | 'memory-eviction';

export type LogEvent =
  | { kind: 'app-start'; version: string; platform: NodeJS.Platform; arch: string; electron: string }
  | { kind: 'update-check-failed'; reason: UpdateFailureReason; ms: number }
  | { kind: 'render-process-gone'; reason: RenderGoneReason; exitCode: number }
  | { kind: 'window-unresponsive' }
  | { kind: 'window-responsive' }
  | { kind: 'window-load-failed'; errorCode: number }
  | { kind: 'gcloud-failed'; command: GcloudCommandId; outcome: GcloudOutcome; exit: number | null; signal: string | null }
  | { kind: 'unhandled-error'; origin: 'exception' | 'rejection'; name: string; code?: string; frames: readonly string[] }
  | { kind: 'unhandled-error-suppressed'; count: number };

/** What other modules receive: a function that records an event and never throws. */
export type LogSink = (event: LogEvent) => void;
export const noLog: LogSink = () => {};

// ---- line building: every value is rechecked here ----

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,30})?$/;
const PLATFORMS = new Set(['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd']);
const ARCHES = new Set(['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64']);
const GONE_REASONS = new Set<string>(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction']);
const OUTCOMES = new Set<string>(['exit', 'signal', 'timeout', 'spawn-error', 'not-found']);
const COMMANDS = new Set<string>(['auth-list', 'sql-login-token', 'print-access-token']);
const STATIC_REASONS = new Set<string>(['timeout', 'network', 'body-too-large', 'invalid-json', 'invalid-shape', 'invalid-current-version']);
const SIGNAL = /^SIG[A-Z0-9]{1,10}$/;
/** Error names are a closed list: a library may copy free text into `name`, and anything else becomes `Error`. */
const ERROR_NAMES = new Set<string>([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'SystemError',
  'CaisError',
  'DriverError',
  'AgentError',
  'ZodError',
  'NonError',
]);
/** Node errno (`ECONNRESET`), Node `ERR_*` and MySQL `ER_*` codes only. */
const ERROR_CODE = /^(?:E[A-Z0-9]{2,20}|ERR?_[A-Z0-9_]{1,40})$/;
/** A frame is a script location (`file.js:1:2`, a path inside the bundle, or `node:internal/x:1:2`); a host, an email or SQL is not. */
const FRAME = /^(?:node:[\w/.-]{1,80}|[\w.@/-]{1,160}\.(?:[cm]?[jt]s|node)):\d{1,7}:\d{1,7}$/;
const BASENAME = /^[\w.-]{1,80}\.(?:[cm]?[jt]s|node)$/;
const BUNDLE_PATH = /^[\w.@/-]{1,160}$/;

const MAX_FRAMES = 10;

function oneOf(value: unknown, allowed: Set<string>): string {
  return typeof value === 'string' && allowed.has(value) ? value : 'unknown';
}

function whole(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : 'unknown';
}

function duration(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.max(0, Math.round(value))) : 'unknown';
}

function errorName(value: unknown): string {
  return typeof value === 'string' && ERROR_NAMES.has(value) ? value : 'Error';
}

function frameOk(frame: unknown): frame is string {
  return typeof frame === 'string' && FRAME.test(frame) && !/(^|\/)\.\.(\/|:)/.test(frame);
}

function reasonText(reason: unknown): string {
  if (typeof reason !== 'string') return 'unknown';
  if (STATIC_REASONS.has(reason)) return reason;
  return /^http-[1-5]\d\d$/.test(reason) ? reason : 'unknown';
}

/** Control characters (newlines first) never reach the file raw: one event is one line. */
export function escapeLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

export interface LogLine {
  level: LogLevel;
  source: 'app' | 'updates' | 'window' | 'gcloud' | 'main';
  message: string;
}

/** The level, source and message of an event, with every field validated against its closed shape. */
export function describeEvent(event: LogEvent): LogLine {
  switch (event.kind) {
    case 'app-start':
      return {
        level: 'info',
        source: 'app',
        message: `start version=${VERSION.test(String(event.version)) ? event.version : 'unknown'} platform=${oneOf(event.platform, PLATFORMS)} arch=${oneOf(event.arch, ARCHES)} electron=${VERSION.test(String(event.electron)) ? event.electron : 'unknown'}`,
      };
    case 'update-check-failed':
      return { level: 'warn', source: 'updates', message: `version check failed reason=${reasonText(event.reason)} ms=${duration(event.ms)}` };
    case 'render-process-gone':
      return {
        level: 'error',
        source: 'window',
        message: `render process gone reason=${oneOf(event.reason, GONE_REASONS)} exitCode=${whole(event.exitCode)}`,
      };
    case 'window-unresponsive':
      return { level: 'warn', source: 'window', message: 'unresponsive' };
    case 'window-responsive':
      return { level: 'info', source: 'window', message: 'responsive again' };
    case 'window-load-failed':
      return { level: 'error', source: 'window', message: `load failed errorCode=${whole(event.errorCode)}` };
    case 'gcloud-failed': {
      const signal = event.signal === null ? 'none' : SIGNAL.test(String(event.signal)) ? event.signal : 'unknown';
      const exit = event.exit === null ? 'none' : whole(event.exit);
      return {
        level: 'warn',
        source: 'gcloud',
        message: `command failed command=${oneOf(event.command, COMMANDS)} outcome=${oneOf(event.outcome, OUTCOMES)} exit=${exit} signal=${signal}`,
      };
    }
    case 'unhandled-error': {
      const name = errorName(event.name);
      const frames = (Array.isArray(event.frames) ? event.frames : []).filter(frameOk).slice(0, MAX_FRAMES);
      const code = typeof event.code === 'string' && ERROR_CODE.test(event.code) ? ` code=${event.code}` : '';
      return {
        level: 'error',
        source: 'main',
        message: `unhandled ${event.origin === 'rejection' ? 'rejection' : 'exception'} name=${name}${code} frames=${frames.join(',') || 'none'}`,
      };
    }
    case 'unhandled-error-suppressed':
      return { level: 'warn', source: 'main', message: `unhandled errors suppressed count=${whole(event.count)}` };
    default:
      return { level: 'error', source: 'main', message: 'unknown event' };
  }
}

// ---- errors: name, short code and frames, never the message ----

const norm = (path: string): string => path.replace(/\\/g, '/');

/**
 * A frame location made safe. Only an absolute path, a `file://` URL or a `node:` location counts (a host, an email or
 * SQL text that happens to look like `at x:1:1` does not). Inside the app bundle it is relative to it; anywhere else only
 * the file name is kept.
 */
function frameFile(file: string, appRoot: string | undefined): string | undefined {
  let path = file;
  if (path.startsWith('file://')) {
    try {
      path = fileURLToPath(path);
    } catch {
      return undefined;
    }
  } else if (path.startsWith('node:')) {
    return /^node:[\w/.-]{1,80}$/.test(path) ? path : undefined;
  } else if (!(path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path))) {
    return undefined;
  }
  path = norm(path);
  const root = appRoot ? norm(appRoot).replace(/\/+$/, '') : undefined;
  if (root && path.startsWith(`${root}/`)) {
    const relative = path.slice(root.length + 1);
    return BUNDLE_PATH.test(relative) && !relative.split('/').includes('..') ? relative : undefined;
  }
  const base = path.slice(path.lastIndexOf('/') + 1);
  return BASENAME.test(base) ? base : undefined;
}

/** `    at fn (/path/file.js:1:2)` or `    at /path/file.js:1:2` to `file.js:1:2`; undefined for native or odd frames. */
function sanitizeFrame(line: string, appRoot: string | undefined): string | undefined {
  const text = line.trim();
  if (!text.startsWith('at ')) return undefined;
  let location = text.slice(3);
  if (location.endsWith(')')) {
    const open = location.lastIndexOf('(');
    if (open < 0) return undefined;
    location = location.slice(open + 1, -1);
  }
  const match = /^(.+):(\d{1,7}):(\d{1,7})$/.exec(location);
  if (!match) return undefined;
  const file = frameFile(match[1]!, appRoot);
  if (!file) return undefined;
  const frame = `${file}:${match[2]}:${match[3]}`;
  return frameOk(frame) ? frame : undefined;
}

/**
 * The frames of a stack. The header (which holds the message, maybe over several lines) is cut off first, and it fails
 * closed: when the header cannot be located (the message was changed after the stack was formatted, or the stack was
 * set by hand) there are no frames at all, never a scan of the whole stack. With an empty message, only the first line
 * is the header.
 */
export function stackFrames(stack: string, message: string, appRoot?: string): string[] {
  // The header ("Name: message", also Node's "TypeError [ERR_X]: message") must be located by the message and end at a
  // line end; otherwise the message was changed after the stack was formatted and the old header could pass as frames.
  const head = String.raw`[A-Za-z_$][\w$.]*(?: \[[A-Z0-9_]+\])?`;
  let rest: string;
  if (message) {
    const at = stack.indexOf(message);
    if (at < 0 || !new RegExp(`^${head}: $`).test(stack.slice(0, at))) return [];
    const end = at + message.length;
    if (end < stack.length && stack[end] !== '\n') return [];
    rest = stack.slice(end + 1);
  } else {
    const nl = stack.indexOf('\n');
    if (!new RegExp(`^${head}$`).test(nl < 0 ? stack : stack.slice(0, nl))) return [];
    rest = nl < 0 ? '' : stack.slice(nl + 1);
  }
  const frames: string[] = [];
  for (const line of rest.split('\n')) {
    const frame = sanitizeFrame(line, appRoot);
    if (frame) frames.push(frame);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

function isRealError(error: unknown): error is Error {
  return error instanceof Error || Object.prototype.toString.call(error) === '[object Error]';
}

/**
 * The event for an error nobody caught. Only the name (from a closed list), a Node or MySQL error code and the frames
 * (`file:line:col`) are read, and the frames only for a real `Error`. The message is never read into the event: an
 * Error with a password, a SQL statement or a host in it leaves none of them in the line.
 */
export function unhandledErrorEvent(origin: 'exception' | 'rejection', error: unknown, appRoot?: string): LogEvent {
  let name = 'NonError';
  let code: string | undefined;
  let frames: string[] = [];
  try {
    if (isRealError(error)) {
      const e = error as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown };
      name = errorName(e.name);
      if (typeof e.code === 'string' && ERROR_CODE.test(e.code)) code = e.code;
      if (typeof e.stack === 'string') frames = stackFrames(e.stack, typeof e.message === 'string' ? e.message : '', appRoot);
    }
  } catch {
    // a hostile getter: log what we have
  }
  return { kind: 'unhandled-error', origin, name, ...(code ? { code } : {}), frames };
}

// ---- the writer ----

export interface LogStat {
  size: number;
  nlink: number;
  mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface LogFs {
  mkdirSync(path: string, options: { recursive: true; mode: number }): void;
  lstatSync(path: string): LogStat;
  chmodSync(path: string, mode: number): void;
  /** Opens with the numeric flags given (`O_APPEND`, `O_NOFOLLOW`, …) and returns the descriptor. */
  openSync(path: string, flags: number, mode: number): number;
  fstatSync(fd: number): LogStat;
  fchmodSync(fd: number, mode: number): void;
  ftruncateSync(fd: number, length: number): void;
  writeSync(fd: number, data: string): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options: { force: true }): void;
}

const realFs: LogFs = {
  mkdirSync: (path, options) => void mkdirSync(path, options),
  lstatSync: (path) => lstatSync(path),
  chmodSync: (path, mode) => chmodSync(path, mode),
  openSync: (path, flags, mode) => openSync(path, flags, mode),
  fstatSync: (fd) => fstatSync(fd),
  fchmodSync: (fd, mode) => fchmodSync(fd, mode),
  ftruncateSync: (fd, length) => ftruncateSync(fd, length),
  writeSync: (fd, data) => void writeSync(fd, data),
  closeSync: (fd) => closeSync(fd),
  renameSync: (from, to) => renameSync(from, to),
  rmSync: (path, options) => rmSync(path, options),
};

export const LOG_FILE = 'main.log';
export const LOG_OLD_FILE = 'main.old.log';
export const LOG_MAX_BYTES = 1024 * 1024;
/** At most this many `unhandled-error` lines per window: a loop of errors must not push the rest out of the file. */
export const UNHANDLED_MAX_PER_WINDOW = 20;
export const UNHANDLED_WINDOW_MS = 60_000;

export interface FileLogOptions {
  /** The logs folder (`app.getPath('logs')`), read on every write so it is only touched when something is logged. */
  dir: () => string;
  fs?: LogFs;
  now?: () => number;
  maxBytes?: number;
  /** Called with the same line for `warn` and `error`, so running from a terminal shows it. */
  echo?: (line: string) => void;
}

/**
 * Appends one line per event to `<logs>/main.log`: created on the first write (folder 0700, file 0600, both enforced
 * again when they already exist), append-only, opened without following links (a link or a hard-linked file is refused),
 * and at `maxBytes` renamed over `main.old.log` so there are never more than two files. It never throws: a failure to
 * write is swallowed. Uncaught errors are rate limited, so an error loop cannot flood the file.
 */
export class FileLog {
  private readonly fs: LogFs;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private windowStart = 0;
  private inWindow = 0;
  private suppressed = 0;

  constructor(private readonly options: FileLogOptions) {
    this.fs = options.fs ?? realFs;
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  }

  /** The `LogSink` to hand to other modules. */
  readonly sink: LogSink = (event) => this.write(event);

  write(event: LogEvent): void {
    try {
      const now = this.now();
      const expired = now - this.windowStart >= UNHANDLED_WINDOW_MS || now < this.windowStart;
      if (expired) {
        const count = this.suppressed;
        this.suppressed = 0;
        this.inWindow = 0;
        this.windowStart = now;
        if (count > 0) this.emit({ kind: 'unhandled-error-suppressed', count });
      }
      if (event.kind === 'unhandled-error') {
        if (this.inWindow >= UNHANDLED_MAX_PER_WINDOW) {
          // neither the file nor the console: an echo that fails is how such a loop starts
          this.suppressed++;
          return;
        }
        this.inWindow++;
      }
    } catch {
      return;
    }
    this.emit(event);
  }

  private emit(event: LogEvent): void {
    let line: string;
    let level: LogLevel;
    try {
      const described = describeEvent(event);
      level = described.level;
      line = escapeLine(`${new Date(this.now()).toISOString()} ${described.level} ${described.source} ${described.message}`);
    } catch {
      return;
    }
    try {
      this.append(`${line}\n`);
    } catch {
      // logging must never break the app
    }
    if (level !== 'info') {
      try {
        this.options.echo?.(line);
      } catch {
        // same
      }
    }
  }

  private append(data: string): void {
    const dir = this.options.dir();
    const file = join(dir, LOG_FILE);
    this.fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // the folder is Cais's own: never a link, and private even when it already existed with a wider mode
    const folder = this.fs.lstatSync(dir);
    if (folder.isSymbolicLink() || !folder.isDirectory()) return;
    if (folder.mode & 0o077) {
      try {
        this.fs.chmodSync(dir, 0o700);
      } catch {
        // keep going: the file itself is 0600
      }
    }
    let size: number | undefined;
    try {
      const entry = this.fs.lstatSync(file);
      // a link, a folder or a hard-linked file is not ours to append to
      if (!entry.isFile() || entry.nlink !== 1) return;
      size = entry.size;
    } catch {
      size = undefined;
    }
    const rotated = size !== undefined && size >= this.maxBytes ? this.rotate(dir, file) : 'none';
    this.appendTo(file, data, rotated === 'failed');
  }

  /** Renames `main.log` over `main.old.log`; when that fails the old file is removed, and as a last resort `main.log` is emptied. */
  private rotate(dir: string, file: string): 'done' | 'failed' {
    const old = join(dir, LOG_OLD_FILE);
    try {
      this.fs.renameSync(file, old);
      return 'done';
    } catch {
      // fall through
    }
    try {
      if (this.fs.lstatSync(old).isFile()) this.fs.rmSync(old, { force: true });
      this.fs.renameSync(file, old);
      return 'done';
    } catch {
      return 'failed';
    }
  }

  /** `truncate`: rotation was not possible, so the file is emptied to stay under the limit. */
  private appendTo(file: string, data: string, truncate: boolean): void {
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
    const fd = this.fs.openSync(file, flags, 0o600);
    try {
      const entry = this.fs.fstatSync(fd);
      if (!entry.isFile() || entry.nlink !== 1) return;
      if (entry.mode & 0o077) this.fs.fchmodSync(fd, 0o600);
      if (truncate) this.fs.ftruncateSync(fd, 0);
      this.fs.writeSync(fd, data);
    } finally {
      this.fs.closeSync(fd);
    }
  }
}

// ---- wiring: process and window events ----

interface Emitter {
  on(event: string, listener: (...args: any[]) => void): unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * Logs what nobody caught in the main process. `uncaughtExceptionMonitor` only observes, so Node and Electron keep
 * their default behavior. `unhandledRejection` has to be listened to directly, and a listener replaces Node's own
 * warning (which Electron's warn mode prints with the message and the stack): `onRejection` gets the reason so the
 * console can keep showing it, while the file never does.
 */
export function logProcessErrors(proc: Emitter, sink: LogSink, appRoot?: string, onRejection?: (reason: unknown) => void): void {
  proc.on('uncaughtExceptionMonitor', (error: unknown, origin: unknown) => {
    // a rejection that Node turns into an exception is logged by the `unhandledRejection` listener
    if (origin === 'unhandledRejection') return;
    sink(unhandledErrorEvent('exception', error, appRoot));
  });
  proc.on('unhandledRejection', (reason: unknown) => {
    sink(unhandledErrorEvent('rejection', reason, appRoot));
    try {
      onRejection?.(reason);
    } catch {
      // the console is not worth a second failure
    }
  });
}

/**
 * Logs a window's failures: the render process going away, freezing, and the main page not loading (the code only, no
 * URL). A subframe and a cancelled navigation (ERR_ABORTED, -3, as on a dev reload) are not failures.
 */
export function logWebContents(contents: Emitter, sink: LogSink): void {
  contents.on('render-process-gone', (_event: unknown, details: { reason?: unknown; exitCode?: unknown }) => {
    sink({
      kind: 'render-process-gone',
      reason: details?.reason as RenderGoneReason,
      exitCode: details?.exitCode as number,
    });
  });
  contents.on('unresponsive', () => sink({ kind: 'window-unresponsive' }));
  contents.on('responsive', () => sink({ kind: 'window-responsive' }));
  contents.on('did-fail-load', (_event: unknown, errorCode: unknown, _description: unknown, _url: unknown, isMainFrame: unknown) => {
    if (isMainFrame !== true || errorCode === -3) return;
    sink({ kind: 'window-load-failed', errorCode: errorCode as number });
  });
}
