import { readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, root, setTheme, shortTempDir, shots } from './helpers';

// The About window: opened from the application menu, shows the version and the runtime, never reaches the
// network on its own, and asks the releases API only when the person clicks Verificar. The API is a local fake
// (CAIS_RELEASES_URL, a hook of the unpackaged app); the real GitHub is never contacted.

const appVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;

interface Seen {
  url: string | undefined;
  headers: IncomingHttpHeaders;
}

let server: Server;
let seen: Seen[] = [];
let reply: { status: number; body: string } = { status: 200, body: '{}' };
let userData: string;
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  userData = shortTempDir('cais-about-');
  ({ app, page } = await launch(userData, { CAIS_RELEASES_URL: releasesUrl() }));
  await expect(page.getByText('Nenhum ambiente cadastrado')).toBeVisible();
  await stubOpenExternal();
});
test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(userData, { recursive: true, force: true });
});

const opened = () => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);

/** Clicks the "Sobre o Cais" item of the application menu (the menu bar itself is native and out of Playwright's reach). */
async function openFromMenu(): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label === 'Sobre o Cais') return item;
        const inner = item.submenu ? find(item.submenu.items) : undefined;
        if (inner) return inner;
      }
      return undefined;
    };
    find(Menu.getApplicationMenu()!.items)!.click();
  });
}

/** Closes the app and starts another over the same user data, once the window finished loading (the menu event needs it). */
async function relaunch(env: Record<string, string>): Promise<void> {
  await app.close();
  seen = [];
  ({ app, page } = await launch(userData, env));
  await expect(page.getByText('Nenhum ambiente cadastrado')).toBeVisible();
  await stubOpenExternal();
}

async function stubOpenExternal(): Promise<void> {
  // nothing opens in the real browser: the call is recorded instead
  await app.evaluate(({ shell }) => {
    const list: string[] = [];
    (globalThis as unknown as { __opened: string[] }).__opened = list;
    shell.openExternal = async (url: string) => {
      list.push(url);
    };
  });
}

const releasesUrl = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/latest`;

const about = () => page.getByRole('dialog', { name: 'Sobre o Cais' });

test('the menu has Sobre in the right place', async () => {
  const menu = await app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? []).map((item) => ({ label: item.label, items: (item.submenu?.items ?? []).map((i) => i.label) })),
  );
  const holder = menu.find((entry) => entry.items.includes('Sobre o Cais'));
  expect(holder).toBeTruthy();
  // macOS keeps it in the app menu; the other systems have Ajuda
  expect(holder!.label).toBe(process.platform === 'darwin' ? 'Cais' : 'Ajuda');
});

test('the window shows the version, the runtime, the license and the logo; nothing goes to the network by itself', async () => {
  await openFromMenu();
  await expect(about()).toBeVisible();
  await expect(about().getByTestId('about-version')).toHaveText(`Versão ${appVersion}`);
  const list = about().getByTestId('about-list');
  await expect(list).toContainText('Electron');
  await expect(list).toContainText('Chromium');
  await expect(list).toContainText('Node');
  await expect(list).toContainText('MIT');
  await expect(list).toContainText('github.com/marcostmunhoz/Cais');
  const versions = await app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }));
  await expect(list).toContainText(versions.electron);
  await expect(list).toContainText(versions.chrome);
  await expect(list).toContainText(versions.node);
  const logo = about().getByTestId('about-logo');
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((img) => (img as unknown as { complete: boolean; naturalWidth: number }).complete && (img as unknown as { naturalWidth: number }).naturalWidth > 0)).toBe(true);
  // the check is never automatic
  await expect(about().getByTestId('about-check-result')).toHaveCount(0);
  expect(seen).toHaveLength(0);
  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'about-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'about-dark.png') });
  await setTheme(app, page, 'light');
});

test('the repository link opens the fixed address', async () => {
  await about().getByTestId('about-repository').click();
  await expect.poll(opened).toEqual(['https://github.com/marcostmunhoz/Cais']);
});

test('Verificar finds a newer version and links to that release, built from the tag', async () => {
  reply = { status: 200, body: JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://evil.example/phish' }) };
  await about().getByTestId('about-check').click();
  const result = about().getByTestId('about-check-result');
  await expect(result).toContainText('Há uma versão nova: 99.0.0.');
  expect(seen).toHaveLength(1);
  expect(seen[0]!.url).toBe('/latest');
  expect(seen[0]!.headers['user-agent']).toBe(`Cais/${appVersion}`);
  expect(seen[0]!.headers.authorization).toBeUndefined();
  expect(seen[0]!.headers.cookie).toBeUndefined();
  await about().getByTestId('about-open-release').click();
  await expect.poll(opened).toEqual(['https://github.com/marcostmunhoz/Cais', 'https://github.com/marcostmunhoz/Cais/releases/tag/v99.0.0']);
  await page.screenshot({ path: join(shots, 'about-newer.png') });
});

test('copying the info puts the versions on the clipboard', async () => {
  await app.evaluate(({ clipboard }) => clipboard.clear());
  await about().getByTestId('about-copy').click();
  await expect(page.getByText('Informações copiadas.')).toBeVisible();
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toMatch(new RegExp(`^Cais ${appVersion.replace(/\./g, '\\.')}\\nElectron \\S+\\nChromium \\S+\\nNode \\S+\\nSistema: \\S+ \\S+$`));
});

test('Escape closes the window; reopening it starts without a result', async () => {
  await page.keyboard.press('Escape');
  await expect(about()).toHaveCount(0);
  await openFromMenu();
  await expect(about()).toBeVisible();
  await expect(about().getByTestId('about-check-result')).toHaveCount(0);
  await about().getByTestId('about-close').click();
  await expect(about()).toHaveCount(0);
});

test('a second click within the hour does not ask again', async () => {
  const before = seen.length;
  await openFromMenu();
  await about().getByTestId('about-check').click();
  await expect(about().getByTestId('about-check-result')).toContainText('Há uma versão nova: 99.0.0.');
  expect(seen).toHaveLength(before);
});

test('a failure reads as "could not check" with a link to the releases', async () => {
  // a fresh app: the answer above is cached for an hour
  reply = { status: 403, body: JSON.stringify({ message: 'API rate limit exceeded' }) };
  await relaunch({ CAIS_RELEASES_URL: releasesUrl() });
  await openFromMenu();
  await about().getByTestId('about-check').click();
  const result = about().getByTestId('about-check-result');
  await expect(result).toContainText('Não foi possível verificar.');
  await expect(result).not.toContainText('rate limit');
  await about().getByTestId('about-open-releases').click();
  await expect.poll(opened).toEqual(['https://github.com/marcostmunhoz/Cais/releases']);
});

test('the same version reads as up to date', async () => {
  reply = { status: 200, body: JSON.stringify({ tag_name: `v${appVersion}` }) };
  await relaunch({ CAIS_RELEASES_URL: releasesUrl() });
  await openFromMenu();
  await about().getByTestId('about-check').click();
  await expect(about().getByTestId('about-check-result')).toContainText('Você está na versão mais recente.');
});

test('without the hook the e2e never reaches the network', async () => {
  await relaunch({});
  await openFromMenu();
  await about().getByTestId('about-check').click();
  await expect(about().getByTestId('about-check-result')).toContainText('Não foi possível verificar.');
  expect(seen).toHaveLength(0);
});
