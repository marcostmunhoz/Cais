import { delimiter, join } from 'node:path';
import { ref, render, type MessageRef } from '@shared/i18n';
import { CaisError } from '../errors';

/** Minimal process surface the provider needs, so tests can inject a fake `spawn`. */
export interface ChildLike {
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'close', cb: (code: number | null) => void): unknown;
  on(event: 'error', cb: (error: Error) => void): unknown;
  kill(): unknown;
}
export type SpawnFn = (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => ChildLike;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runProcess(
  spawn: SpawnFn,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child: ChildLike;
    try {
      child = spawn(command, args, { env });
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(CaisError.of(ref('mainMisc.gcloud.timeout'), 'gcloud-timeout'));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export interface GcloudAccount {
  account: string;
  status: string;
}

export interface GcloudDeps {
  spawn: SpawnFn;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
  /** Is there an executable file at this path? */
  exists(path: string): boolean;
  now(): number;
}

const TOKEN_TTL_MS = 50 * 60 * 1000;
const notFound = (): CaisError => CaisError.of(ref('mainMisc.gcloud.notFound'), 'gcloud-missing');

const REAUTH_MARKERS = [
  /reauthentication/i,
  /gcloud auth login/i,
  /invalid_grant/i,
  /problem refreshing your current auth tokens/i,
  /refresh token/i,
  /not logged in/i,
];

/**
 * Gets IAM login tokens and the list of logged-in accounts from the gcloud CLI.
 * Only runs read-only subcommands (`sql generate-login-token`, `auth list`); never alters gcloud.
 * Tokens stay in memory and are never logged.
 */
export class GcloudTokenProvider {
  private binary: string | null | undefined;
  private binaryLookup: Promise<string | null> | null = null;
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly deps: GcloudDeps) {}

  /** PATH, then the login shell, then well-known install locations. */
  async locate(): Promise<string | null> {
    if (this.binary !== undefined) return this.binary;
    this.binaryLookup ??= this.lookup().then((found) => {
      this.binary = found;
      this.binaryLookup = null;
      return found;
    });
    return this.binaryLookup;
  }

  private async lookup(): Promise<string | null> {
    const { env, platform, homedir, exists } = this.deps;
    const exe = platform === 'win32' ? 'gcloud.cmd' : 'gcloud';

    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
      const candidate = join(dir, exe);
      if (exists(candidate)) return candidate;
    }

    if (platform !== 'win32' && env.SHELL) {
      try {
        const res = await runProcess(this.deps.spawn, env.SHELL, ['-lc', 'command -v gcloud'], env, 5000);
        const line = res.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('/'))
          .pop();
        if (res.code === 0 && line && exists(line)) return line;
      } catch {
        // fall through to the well-known locations
      }
    }

    const candidates = [
      '/usr/local/bin/gcloud',
      '/opt/homebrew/bin/gcloud',
      join(homedir, 'google-cloud-sdk/bin/gcloud'),
      '/opt/homebrew/share/google-cloud-sdk/bin/gcloud',
      '/usr/bin/gcloud',
      '/snap/bin/gcloud',
      '/usr/lib/google-cloud-sdk/bin/gcloud',
    ];
    return candidates.find((c) => exists(c)) ?? null;
  }

  private async run(args: string[], timeoutMs: number): Promise<RunResult> {
    const binary = await this.locate();
    if (!binary) throw notFound();
    const env = { ...this.deps.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' };
    try {
      return await runProcess(this.deps.spawn, binary, args, env, timeoutMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.binary = undefined;
        throw notFound();
      }
      throw error;
    }
  }

  async listAccounts(): Promise<GcloudAccount[]> {
    const res = await this.run(['auth', 'list', '--format=json'], 20000);
    if (res.code !== 0) {
      throw trimmed(ref('mainMisc.gcloud.listFailed', { detail: firstLine(res.stderr) }), 'gcloud-failed');
    }
    try {
      const parsed = JSON.parse(res.stdout) as { account?: unknown; status?: unknown }[];
      return parsed
        .filter((a) => typeof a.account === 'string')
        .map((a) => ({ account: String(a.account), status: typeof a.status === 'string' ? a.status : '' }));
    } catch {
      throw CaisError.of(ref('mainMisc.gcloud.listUnexpected'), 'gcloud-failed');
    }
  }

  async getToken(account: string, impersonateServiceAccount?: string): Promise<string> {
    const sa = impersonateServiceAccount?.trim() || undefined;
    const key = `${account}\u0000${sa ?? ''}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt > this.deps.now()) return cached.token;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = this.fetchToken(account, sa)
      .then((token) => {
        this.tokens.set(key, { token, expiresAt: this.deps.now() + TOKEN_TTL_MS });
        return token;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async fetchToken(account: string, sa?: string): Promise<string> {
    const args = ['sql', 'generate-login-token', `--account=${account}`];
    if (sa) args.push(`--impersonate-service-account=${sa}`);
    const res = await this.run(args, 30000);
    if (res.code !== 0) {
      if (REAUTH_MARKERS.some((re) => re.test(res.stderr))) {
        throw CaisError.of(ref('mainMisc.gcloud.reauth', { account }), 'gcloud-reauth');
      }
      throw trimmed(ref('mainMisc.gcloud.tokenFailed', { account, detail: firstLine(res.stderr) }), 'gcloud-failed');
    }
    const token = res.stdout.trim();
    if (!token) {
      throw CaisError.of(ref('mainMisc.gcloud.noToken', { account }), 'gcloud-failed');
    }
    return token;
  }
}

/** stderr can echo credentials: drop OAuth-token-shaped text before it reaches any message. */
export function sanitizeStderr(text: string): string {
  return text.replace(/ya29\.[\w-]+/g, '[removido]').replace(/[A-Za-z0-9_-]{32,}/g, '[removido]');
}

/** A CaisError for a message that ends with a possibly empty detail: no trailing space when it is empty. */
function trimmed(reference: MessageRef, code: string): CaisError {
  return new CaisError(render(reference).trim(), code, undefined, reference);
}

function firstLine(text: string): string {
  const line = sanitizeStderr(text)
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return line ? line.slice(0, 240) : '';
}
