import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, seedUserData, setSql, setTheme, shortTempDir, shots, testDb } from './helpers';

// Connection state in the tab, click on the environment, Save button.
// Own userData: the testids env-<name> would repeat across specs that duplicate environments.

let userData: string;
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: 'serial' });

/** A port on the test host that nothing listens on (bound, read, then released). */
async function closedPort(host: string): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test.beforeAll(async () => {
  userData = shortTempDir('cais-tabs-');
  seedUserData(userData, { environments: [{ id: 'e-off', name: 'offline', port: await closedPort(testDb().host) }] });
  ({ app, page } = await launch(userData));
});
test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(userData, { recursive: true, force: true });
});

const tabs = () => page.getByTestId('tab');
const activeTab = () => page.locator('[data-testid=tab][aria-selected=true]');
const chip = () => page.getByTestId('conn-chip');

test('an environment on a closed port shows the error on the tab and the session bar, with Reconnect', async () => {
  await page.getByTestId('env-offline').click();
  await expect(tabs()).toHaveCount(1);
  // opening the tab connects right away: the failure shows before any Run
  await expect(chip()).toHaveAttribute('data-status', 'error', { timeout: 20_000 });
  await expect(chip()).toContainText('Erro de conexão');
  await expect(chip()).toHaveAttribute('title', /^Erro de conexão · Sem resposta de .*A VPN está ligada\?$/);
  await expect(activeTab().getByTestId('tab-status')).toHaveAttribute('data-status', 'error');
  await expect(activeTab().getByTestId('tab-status')).toHaveAttribute('title', /Erro de conexão · Sem resposta de .*A VPN está ligada\?/);
  await expect(page.getByTestId('conn-notice')).toContainText('A VPN está ligada?');
  await expect(page.getByTestId('conn-state')).toHaveAttribute('data-status', 'error');
  // shown once in the tab (notice), not again in the results area
  await expect(page.getByText('Não foi possível continuar')).toHaveCount(0);
  await expect(page.getByTestId('btn-reconnect')).toBeVisible();
  await expect(page.getByTestId('btn-disconnect')).toHaveCount(0);

  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'tabs-error-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'tabs-error-dark.png') });
  await setTheme(app, page, 'light');

  // Reconnect goes through the open again and fails the same way
  await page.getByTestId('btn-reconnect').click();
  await expect(chip()).toHaveAttribute('data-status', 'error', { timeout: 20_000 });
  // Disconnect on the notice clears the error and keeps the tab
  await page.getByTestId('notice-disconnect').click();
  await expect(chip()).toHaveAttribute('data-status', 'disconnected');
  await expect(chip()).toHaveText('Desconectado');
  await expect(page.getByTestId('conn-notice')).toHaveCount(0);
  await expect(page.getByTestId('btn-connect')).toBeVisible();
  await expect(tabs()).toHaveCount(1);
});

test('a working environment connects on open', async () => {
  await page.getByTestId('env-dev').click();
  await expect(tabs()).toHaveCount(2);
  await expect(chip()).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
  await expect(chip()).toContainText('Conectado');
  await expect(chip()).toContainText('MySQL 8.4');
  await expect(activeTab().getByTestId('tab-status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('conn-state')).toHaveText('Conectado');
  await expect(page.getByTestId('btn-disconnect')).toBeEnabled();
});

test('Disconnect keeps the tab, its text and its mode; Connect brings them back', async () => {
  await page.getByRole('radio', { name: 'Transação' }).click();
  await expect(page.getByRole('radio', { name: 'Transação' })).toHaveAttribute('aria-checked', 'true');
  await setSql(page, 'SELECT 1 AS um;');
  await page.getByTestId('btn-disconnect').click();
  await expect(chip()).toHaveAttribute('data-status', 'disconnected');
  await expect(chip()).toHaveText('Desconectado');
  await expect(tabs()).toHaveCount(2);
  await expect(page.getByRole('radio', { name: 'Transação' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.cm-content')).toContainText('SELECT 1 AS um;');

  await page.getByTestId('btn-connect').click();
  await expect(chip()).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
  await expect(page.getByRole('radio', { name: 'Transação' })).toHaveAttribute('aria-checked', 'true');
});

test('with an open transaction Disconnect is disabled and says why', async () => {
  await setSql(page, 'UPDATE people SET name = name WHERE id = 1;');
  await page.getByTestId('run').click();
  await expect(page.getByTestId('txbar')).toBeVisible({ timeout: 20_000 });
  const disconnect = page.getByTestId('btn-disconnect');
  await expect(disconnect).toBeDisabled();
  await expect(disconnect).toHaveAttribute('title', 'Faça commit ou rollback antes');
  await page.getByTestId('txbar').getByRole('button', { name: 'Rollback' }).click();
  await expect(page.getByTestId('txbar')).toHaveCount(0);
  await expect(disconnect).toBeEnabled();
});

test('single click on an environment focuses its tab; double click opens another', async () => {
  // offline already has a tab: a click focuses it, no new tab
  await page.getByTestId('env-offline').click();
  await expect(tabs()).toHaveCount(2);
  await expect(activeTab()).toHaveAttribute('title', /api · offline/);
  await page.getByTestId('env-dev').click();
  await expect(tabs()).toHaveCount(2);
  await expect(activeTab()).toHaveAttribute('title', /api · dev/);

  // dev had a tab before the gesture: the double click opens a second one
  await page.getByTestId('env-dev').dblclick();
  await expect(tabs()).toHaveCount(3);
  await expect(chip()).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });

  // pro had none: the first click opens it and the double click does not add another
  await page.getByTestId('env-pro').dblclick();
  await expect(tabs()).toHaveCount(4);
  await expect(activeTab()).toHaveAttribute('title', /api · pro/);
  await expect(chip()).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });

  // the most recently focused tab of dev wins over the last one in the strip
  await tabs().nth(1).click();
  await page.getByTestId('env-offline').click();
  await page.getByTestId('env-dev').click();
  await expect(tabs().nth(1)).toHaveAttribute('aria-selected', 'true');
});

test('Save in the session bar asks for a name on a loose tab and lights up on changes', async () => {
  const save = page.getByTestId('btn-save');
  await expect(save).toHaveAttribute(
    'title',
    process.platform === 'darwin'
      ? 'Salvar script (⌘S) · Salvar como (⇧⌘S)'
      : 'Salvar script (Ctrl+S) · Salvar como (Ctrl+Shift+S)',
  );
  await setSql(page, 'SELECT id, name FROM people ORDER BY id;');
  await save.click();
  const dialog = page.getByRole('dialog', { name: 'Salvar script' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Nome do script').fill('Pessoas');
  await dialog.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(save).toHaveAttribute('data-dirty', 'false');

  await setSql(page, 'SELECT id, name, email FROM people ORDER BY id;');
  await expect(save).toHaveAttribute('data-dirty', 'true');
  await expect(page.getByTestId('dirty-mark')).toBeVisible();

  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'tabs-state-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'tabs-state-dark.png') });
  await setTheme(app, page, 'light');

  // the button does what Cmd+S does on a linked tab: saves in place
  await save.click();
  await expect(save).toHaveAttribute('data-dirty', 'false');
  await expect(page.getByTestId('dirty-mark')).toHaveCount(0);
});

test('restored tabs stay disconnected; idle disconnect says so and the next Run reconnects', async () => {
  await page.waitForTimeout(900); // debounce of the tabs file
  await app.close();
  ({ app, page } = await launch(userData, { CAIS_IDLE_MS: '1500' }));
  await expect(tabs()).toHaveCount(4);
  // nothing connects on its own after a restart
  for (let i = 0; i < 4; i++) await expect(tabs().nth(i).getByTestId('tab-status')).toHaveAttribute('data-status', 'disconnected');
  await expect(page.getByTestId('conn-state')).toHaveText('Desconectado');
  await expect(page.getByTestId('btn-connect')).toBeVisible();

  await page.getByTestId('btn-connect').click();
  await expect(chip()).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
  await expect(chip()).toHaveText('Desconectado por inatividade', { timeout: 15_000 });
  await expect(page.getByTestId('conn-state')).toHaveText('Desconectado por inatividade');
  await expect(activeTab().getByTestId('tab-status')).toHaveAttribute('data-status', 'disconnected');

  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'tabs-idle-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'tabs-idle-dark.png') });
  await setTheme(app, page, 'light');

  await setSql(page, 'SELECT 41 + 1 AS answer;');
  await page.getByTestId('run').click();
  await expect(page.locator('[role=gridcell]', { hasText: /^42$/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('conn-state')).toHaveText(/Conectado|Desconectado por inatividade/);
});
