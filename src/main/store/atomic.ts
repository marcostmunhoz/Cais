import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { m } from '@shared/i18n';

/** Writes through a temporary file and renames it over the target. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await fs.open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const text = await fs.readFile(path, 'utf8');
    return JSON.parse(text) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export interface Loaded<T> {
  value: T | null;
  /** Message (app locale) when the file was unreadable and set aside. */
  notice?: string;
}

/**
 * Reads and validates a JSON file. A missing file is fine. A corrupt or invalid one is renamed to
 * `<name>.corrupt-<timestamp>.json` (never deleted) so the app can start empty and say so.
 */
export async function loadValidated<T>(
  path: string,
  schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } },
  now: () => number = Date.now,
): Promise<Loaded<T>> {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: null };
    throw error;
  }
  try {
    const result = schema.safeParse(JSON.parse(text));
    if (result.success) return { value: result.data };
  } catch {
    // not JSON: handled below like a schema failure
  }
  const aside = path.replace(/\.json$/, '') + `.corrupt-${now()}.json`;
  await fs.rename(path, aside);
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { value: null, notice: m().mainMisc.store.unreadable({ name, aside }) };
}
