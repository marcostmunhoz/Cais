import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, root, seedUserData, setSql, setTheme, shortTempDir, shots, testDb } from './helpers';

// The screenshots of docs/images, taken with the English UI (CAIS_LOCALE=en). The other specs pin pt-BR, so these
// scenes live here instead of flipping the suite. Each test builds one scene from scratch (own userData, own window)
// and writes tests/e2e/screenshots/<name>-en.png; `docs/images/<name>.png` is a copy of that file:
//   transaction-light-en.png      -> docs/images/transaction-light.png
//   grid-edit-dark-en.png         -> docs/images/grid-edit-dark.png
//   agent-write-approval-light-en.png -> docs/images/agent-write-approval-light.png
//   trail-light-en.png            -> docs/images/trail-light.png
// Everything is rolled back or rejected at the end: the shared test database is left as it was found.

const cliFile = join(root, 'out', 'cli', 'cais.mjs');

test.describe.configure({ mode: 'serial' });

let userData: string;
let app: ElectronApplication;
let page: Page;

async function open(extra: Record<string, string> = {}, seed: Parameters<typeof seedUserData>[1] = {}): Promise<void> {
  userData = shortTempDir('cais-doc-');
  seedUserData(userData, seed);
  ({ app, page } = await launch(userData, { CAIS_LOCALE: 'en', ...extra }));
  await expect(page.getByTestId('env-dev')).toBeVisible();
  // the docs images are 1280 x 800 of window content, whatever the window manager does with the frame
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
  await page.waitForTimeout(300);
}

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  rmSync(userData, { recursive: true, force: true });
});

const dialog = (name: string) => page.getByRole('dialog', { name });
const shot = (name: string) => page.screenshot({ path: join(shots, `${name}-en.png`) });

function cli(socket: string, args: string[]): Promise<{ code: number; json: any }> {
  const child = spawn(process.execPath, [cliFile, ...args], { env: { ...process.env, CAIS_SOCKET: socket } });
  let stdout = '';
  child.stdout.on('data', (c) => (stdout += c));
  return new Promise((resolve) => {
    child.on('close', (code) => {
      let json: unknown;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      resolve({ code: code ?? -1, json });
    });
  });
}

test('transaction-light: a tab in Transaction mode with the Commit and Rollback bar', async () => {
  await open();
  await page.getByTestId('env-dev').click();
  await expect(page.getByTestId('conn-chip')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
  await page.getByTestId('env-pro').click();
  await expect(page.getByTestId('tab')).toHaveCount(2);
  await expect(page.getByTestId('conn-chip')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
  await page.getByTestId('tab').first().click();
  await page.getByRole('radio', { name: 'Transaction' }).click();

  await setSql(page, "INSERT INTO people (name, email) VALUES ('Zed', 'zed@exemplo.com');");
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('affected')).toContainText('1 row affected');
  const txbar = page.getByTestId('txbar');
  await expect(txbar).toContainText('Transaction open · 1 statement');

  await setSql(page, "SELECT id, name, email FROM people WHERE name = 'Zed';");
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('[role=gridcell]', { hasText: 'zed@exemplo.com' })).toBeVisible();
  await expect(txbar).toContainText('2 statements');

  await setTheme(app, page, 'light');
  await shot('transaction-light');

  // leave nothing behind in the shared database
  await txbar.getByRole('button', { name: 'Rollback' }).click();
  await expect(txbar).toHaveCount(0);
});

test('grid-edit-dark: three pending changes in the results grid', async () => {
  await open();
  const cell = (r: number, col: string) => page.locator(`[role=gridcell][data-r="${r}"][data-col="${col}"]`);
  const editor = page.getByTestId('cell-editor');
  await page.getByTestId('env-dev').click();
  await expect(page.getByTestId('conn-chip')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
  await setSql(page, 'SELECT id, name, note, price FROM grid_items ORDER BY id;');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(cell(0, 'name')).toHaveText('Caneta', { timeout: 20_000 });

  await cell(0, 'name').dblclick();
  await editor.fill("Caneta d'ouro");
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);
  await cell(0, 'note').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Set to NULL' }).click();
  await expect(cell(0, 'note')).toHaveText('NULL');
  await cell(1, 'price').dblclick();
  await editor.fill('12.50');
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);
  await expect(page.getByTestId('grid-edit-bar')).toContainText('3 changes in 2 rows');
  await cell(1, 'price').click();

  await setTheme(app, page, 'dark');
  await shot('grid-edit-dark');
  await page.getByTestId('edit-discard').click().catch(() => undefined);
});

test('agent-write-approval-light: the modal for a write requested by an agent', async () => {
  const dir = shortTempDir('cais-docsock-');
  const socket = join(dir, 'a.sock');
  try {
    await open({ CAIS_SOCKET: socket });
    await page.getByTestId('agents-entry').click();
    const panel = dialog('Agents');
    await panel.getByTestId('agent-switch').click();
    await expect(panel.getByTestId('agent-switch')).toHaveAttribute('aria-checked', 'true');
    await panel.getByRole('button', { name: 'Close' }).first().click();
    await page.getByTestId('env-dev').click();
    await expect(page.getByTestId('agents-status')).toContainText('Agents on');
    await expect(page.getByTestId('conn-chip')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });

    const run = cli(socket, [
      'llm', 'query', 'api/dev', '--write', '--sql', "UPDATE agent_items SET status = 'blocked' WHERE id IN (1, 2);",
      '--reason', 'Block the 2 duplicated items', '--wait', '--client', 'Claude Code',
    ]);
    const modal = dialog('Agent asks to write');
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Run in transaction' })).toBeEnabled();
    await setTheme(app, page, 'light');
    await shot('agent-write-approval-light');
    await modal.getByRole('button', { name: 'Reject' }).click();
    expect((await run).code).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trail-light: the Trail screen with agent requests and configuration changes', async () => {
  const dir = shortTempDir('cais-docsock-');
  const socket = join(dir, 'a.sock');
  const t = testDb();
  const db = await mysql.createConnection({ host: t.host, port: t.port, user: t.user, password: t.password, database: t.database });
  try {
    // the database is shared with the other specs: start without the row they may have left
    await db.query('DELETE FROM agent_items WHERE id = 4');
    await open({ CAIS_SOCKET: socket });
    const ask = (args: string[]) => cli(socket, ['llm', ...args]);
    const reject = async () => {
      await dialog('Agent asks to write').getByRole('button', { name: 'Reject' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    };
    const setLevel = async (env: 'dev' | 'pro', level: string) => {
      await page.getByTestId(`env-${env}`).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      const registry = dialog('Registry');
      // the form loads the environment after the dialog opens; picking a level before that is lost
      await expect(registry.getByLabel('Environment name')).toHaveValue(env);
      await registry.getByLabel('Agent access').selectOption(level);
      await expect(registry.getByLabel('Agent access')).toHaveValue(level);
      await registry.getByRole('button', { name: 'Save' }).click();
      await expect(registry.getByText('Saved')).toBeVisible();
      await registry.getByRole('button', { name: 'Close' }).first().click();
      await expect(registry).toHaveCount(0);
    };

    await page.getByTestId('agents-entry').click();
    const panel = dialog('Agents');
    await panel.getByTestId('agent-switch').click();
    await expect(panel.getByTestId('agent-switch')).toHaveAttribute('aria-checked', 'true');
    await panel.getByRole('button', { name: 'Close' }).first().click();
    await page.getByTestId('env-dev').click();
    await expect(page.getByTestId('conn-chip')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });

    // an agent saves a script; a production read is approved; production reads are freed; its write is rejected
    const saved = await ask(['script-save', '--project', 'api', '--name', 'Duplicates by document', '--sql', 'SELECT national_id, COUNT(*) FROM companies GROUP BY 1', '--database', t.database]);
    expect(saved.code).toBe(0);
    expect((await ask(['script-save', '--project', 'api', '--name', 'duplicates by document', '--sql', 'SELECT 2'])).code).toBe(2);
    await setLevel('dev', 'free-reads-writes');

    const read = ask(['query', 'api/pro', '--sql', 'SELECT COUNT(*) AS n FROM agent_items', '--reason', 'Check today’s incident', '--wait', '--client', 'Claude Code']);
    const readModal = dialog('Agent asks to read');
    await expect(readModal.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
    await readModal.getByRole('button', { name: 'Approve', exact: true }).click();
    expect((await read).code).toBe(0);

    await setLevel('pro', 'free-reads');
    expect((await ask(['query', 'api/pro', '--sql', 'SELECT COUNT(*) AS n FROM agent_items', '--reason', 'Check again'])).code).toBe(0);
    const proWrite = await ask(['query', 'api/pro', '--write', '--sql', "UPDATE agent_items SET status = 'x' WHERE id = 3", '--reason', 'test']);
    expect(proWrite.json.status).toBe('pending_approval');
    await reject();
    await setLevel('pro', 'approve-all');

    // dev frees writes: an alert (no WHERE) and a possible foreign key still wait; a plain INSERT commits by itself
    const waiting = ask(['query', 'api/dev', '--write', '--sql', "UPDATE agent_items SET status = 'auto'", '--reason', 'level test', '--wait', '--client', 'Claude Code']);
    await expect(dialog('Agent asks to write')).toBeVisible();
    await reject();
    expect((await waiting).code).toBe(3);
    const upd = await ask(['query', 'api/dev', '--write', '--sql', "UPDATE agent_items SET status = 'auto' WHERE id = 3", '--reason', 'level test', '--client', 'Claude Code']);
    expect(upd.json.status).toBe('pending_approval');
    await reject();
    const ins = await ask(['query', 'api/dev', '--write', '--sql', "INSERT INTO agent_items VALUES (4, 'auto', 'test')", '--reason', 'level test', '--client', 'Claude Code']);
    expect(ins.json).toMatchObject({ status: 'committed', auto_commit: true });

    await page.getByTestId('trail-entry').click();
    const trail = dialog('Trail');
    await expect(trail.getByTestId('trail-row').first()).toContainText('committed (automatic)');
    await trail.getByTestId('trail-row').first().click();
    await expect(trail.getByTestId('trail-detail')).toContainText('automatic (environment level)');
    await setTheme(app, page, 'light');
    await shot('trail-light');
    await trail.getByRole('button', { name: 'Close' }).first().click();
  } finally {
    await db.query('DELETE FROM agent_items WHERE id = 4').catch(() => undefined);
    await db.query("UPDATE agent_items SET status = 'active'").catch(() => undefined);
    await db.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
