import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { loadValidated, writeFileAtomic } from './atomic';
import type { Vault } from './vault';

/**
 * Integrity seal of what decides how much an agent may do without the person: the environments (with the
 * credential each one uses), the agent-access switch and the trail. A key from the system vault (Keychain)
 * signs them; a process that edits catalog.json, settings.json or the trail by hand cannot sign the change,
 * so the Cais notices it at the next start.
 */
export type SealStatus = 'ok' | 'missing' | 'unavailable';

const sealSchema = z.object({
  version: z.literal(1),
  key: z.string().min(1),
  envs: z.record(z.string(), z.string()),
  /** Environments blocked because the seal was missing, still waiting for the person's review (signed ids). */
  pending: z.record(z.string(), z.string()).optional(),
  settings: z.string().optional(),
});
type SealFile = z.infer<typeof sealSchema>;

/** JSON with object keys sorted at every level: the same value always gives the same text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** What the seal covers for one environment: the environment, its credential record and that credential's stored secret. */
export function environmentSealText(env: unknown, credential: unknown, secret: string | null): string {
  return `env:${canonical({ env, credential, secret })}`;
}

export class Seal {
  private key: Buffer | undefined;
  private file: SealFile | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** ok: the seal was read and its key opened. missing: no seal (first start, deleted, or a key the vault cannot open). */
  status: SealStatus = 'missing';
  readonly path: string;

  constructor(
    dir: string,
    private readonly vault: Vault,
  ) {
    this.path = join(dir, 'seal.json');
  }

  async load(): Promise<void> {
    if (!this.vault.isAvailable()) {
      this.status = 'unavailable';
      this.key = undefined;
      return;
    }
    const loaded = await loadValidated<SealFile>(this.path, sealSchema);
    if (loaded.value) {
      try {
        const key = Buffer.from(this.vault.decrypt(loaded.value.key), 'hex');
        if (key.length === 32) {
          this.key = key;
          this.file = loaded.value;
          this.status = 'ok';
          return;
        }
      } catch {
        // a key the vault cannot open counts as no seal
      }
    }
    const key = randomBytes(32);
    this.key = key;
    this.file = { version: 1, key: this.vault.encrypt(key.toString('hex')), envs: {} };
    this.status = 'missing';
    await this.persist();
  }

  /** A key is in hand: changes can be signed and checked. */
  get available(): boolean {
    return this.key !== undefined;
  }

  /** HMAC-SHA256 of `text` under the seal key, hex; undefined without a key. */
  mac(text: string): string | undefined {
    if (!this.key) return undefined;
    return createHmac('sha256', this.key).update(text, 'utf8').digest('hex');
  }

  /** Constant-time comparison of a MAC with the expected one. */
  static same(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b || a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  }

  envMac(id: string): string | undefined {
    return this.file?.envs[id];
  }

  settingsMac(): string | undefined {
    return this.file?.settings;
  }

  pendingMac(id: string): string | undefined {
    return this.file?.pending?.[id];
  }

  /** Replaces the environments' MACs and the signed list of those still waiting for review (removed ones leave). */
  setEnvs(envs: Record<string, string>, pending: Record<string, string> = {}): Promise<void> {
    if (!this.file) return Promise.resolve();
    this.file = { ...this.file, envs, pending };
    return this.persist();
  }

  setSettings(mac: string): Promise<void> {
    if (!this.file) return Promise.resolve();
    this.file = { ...this.file, settings: mac };
    return this.persist();
  }

  private persist(): Promise<void> {
    const next = this.queue.then(() => writeFileAtomic(this.path, JSON.stringify(this.file, null, 2)));
    this.queue = next.catch(() => undefined);
    return next;
  }
}
