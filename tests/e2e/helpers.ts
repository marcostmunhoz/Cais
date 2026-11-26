import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { FakeVault } from '../../src/main/store/vault';
import { environmentSealText } from '../../src/main/store/seal';

export const root = resolve(__dirname, '../..');
export const shots = join(__dirname, 'screenshots');

export interface TestDb {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export const testDb = (): TestDb => JSON.parse(process.env.CAIS_TEST_MYSQL!) as TestDb;

export const ids = { project: 'p-api', credential: 'c-test', dev: 'e-dev', pro: 'e-pro' };

/** A short temp dir (unix socket paths are limited to about 100 bytes). */
export function shortTempDir(prefix: string): string {
  return mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', prefix));
}

/**
 * Writes a catalog (project api with dev and pro, one password credential) straight into the user data dir,
 * using the fake vault of the test hook, so each spec starts from a known state without clicking through the registry.
 */
export function seedUserData(
  dir: string,
  extra: { scripts?: unknown[]; environments?: { id: string; name: string; port: number; production?: boolean }[] } = {},
): void {
  const db = testDb();
  mkdirSync(dir, { recursive: true });
  const env = (id: string, name: string, production: boolean, port = db.port) => ({
    id, projectId: ids.project, name, engine: 'mysql', host: db.host, port, defaultDatabase: db.database,
    credentialId: ids.credential, production,
  });
  const environments = [
    env(ids.dev, 'dev', false),
    env(ids.pro, 'pro', true),
    ...(extra.environments ?? []).map((e) => env(e.id, e.name, !!e.production, e.port)),
  ];
  const credential = { id: ids.credential, name: 'test user', kind: 'password', username: db.user };
  const secret = new FakeVault().encrypt(db.password);
  writeFileSync(
    join(dir, 'catalog.json'),
    JSON.stringify({ version: 1, projects: [{ id: ids.project, name: 'api', order: 0 }], environments, credentials: [credential] }),
  );
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ [ids.credential]: secret }));
  // the integrity seal the Cais would have written, with the test hook's fake vault
  const key = Buffer.alloc(32, 7);
  const mac = (text: string): string => createHmac('sha256', key).update(text, 'utf8').digest('hex');
  writeFileSync(
    join(dir, 'seal.json'),
    JSON.stringify({
      version: 1,
      key: new FakeVault().encrypt(key.toString('hex')),
      envs: Object.fromEntries(environments.map((e) => [e.id, mac(environmentSealText({ env: e, project: 'api' }, credential, secret))])),
    }),
  );
  if (extra.scripts) writeFileSync(join(dir, 'scripts.json'), JSON.stringify({ version: 1, scripts: extra.scripts }));
}

export async function launch(userData: string, env: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [root],
    cwd: root,
    env: { ...process.env, CAIS_E2E: '1', CAIS_LOCALE: 'pt-BR', CAIS_USER_DATA: userData, ...env },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

export async function setTheme(app: ElectronApplication, page: Page, theme: 'light' | 'dark'): Promise<void> {
  await app.evaluate(({ nativeTheme }, t) => {
    nativeTheme.themeSource = t;
  }, theme);
  await page.emulateMedia({ colorScheme: theme });
  await page.waitForTimeout(350);
}

export async function setSql(page: Page, sql: string): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(sql);
}

/** page.screenshot, retried: on a cold CI runner without a GPU, Chromium may have no copyable surface for a moment right after a theme flip on a fresh window ("Unable to capture screenshot"). */
export async function shoot(page: Page, path: string): Promise<void> {
  await expect(async () => {
    // A string, because the node tsconfig has no DOM types.
    await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))');
    await page.screenshot({ path });
  }).toPass({ intervals: [200, 500, 1000, 2000], timeout: 15_000 });
}
