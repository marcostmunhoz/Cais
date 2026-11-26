import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { electronOptions } from './helpers';

const shots = join(__dirname, 'screenshots');
const db = JSON.parse(process.env.CAIS_TEST_MYSQL!) as {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

let userData: string;
let app: ElectronApplication;
let page: Page;

async function launch(): Promise<void> {
  app = await electron.launch(electronOptions(userData));
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
}

async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  await app.evaluate(({ nativeTheme }, t) => {
    nativeTheme.themeSource = t;
  }, theme);
  // Playwright pins the page to a color scheme; follow the theme we just set on the app instead.
  await page.emulateMedia({ colorScheme: theme });
  await page.waitForTimeout(350);
}

async function setSql(sql: string): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(sql);
}

async function runCurrent(): Promise<void> {
  await page.keyboard.press('ControlOrMeta+Enter');
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'cais-e2e-'));
  mkdirSync(shots, { recursive: true });
  await launch();
});

test.afterAll(async () => {
  await app?.close();
  rmSync(userData, { recursive: true, force: true });
});

test('empty state, then register credential, project and environments', async () => {
  await expect(page.getByText('Cadastre uma credencial e um ambiente para começar')).toBeVisible();
  await page.screenshot({ path: join(shots, 'empty-light.png') });
  await page.getByRole('button', { name: 'Cadastrar', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Cadastro' });
  // credential
  await dialog.getByLabel('Nome', { exact: true }).fill('test user');
  await dialog.getByLabel('Usuário', { exact: true }).fill(db.user);
  await dialog.getByLabel('Senha').fill(db.password);
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(dialog.getByText('Salvo')).toBeVisible();

  // environments: dev and pro
  for (const envName of ['dev', 'pro']) {
    await dialog.getByRole('tab', { name: 'Ambientes' }).click();
    await dialog.getByRole('button', { name: 'Novo ambiente' }).click();
    if (envName === 'dev') await dialog.getByLabel('Nome do novo projeto').fill('api');
    await dialog.getByLabel('Nome do ambiente').fill(envName);
    await dialog.getByLabel('Host').fill(db.host);
    await dialog.getByLabel('Porta').fill(String(db.port));
    await dialog.getByLabel('Banco padrão (opcional)').fill(db.database);
    if (envName === 'pro') await expect(dialog.getByLabel('Produção')).toBeChecked();
    else await expect(dialog.getByLabel('Produção')).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Testar conexão' }).click();
    await expect(dialog.getByTestId('test-result')).toContainText('Conectado', { timeout: 20_000 });
    if (envName === 'dev') await page.screenshot({ path: join(shots, 'registry-light.png') });
    await dialog.getByRole('button', { name: 'Salvar' }).click();
    await expect(dialog.getByText('Salvo')).toBeVisible();
  }
  await dialog.getByRole('button', { name: 'Fechar' }).click();
  await expect(page.getByTestId('env-dev')).toBeVisible();
  await expect(page.getByTestId('env-pro')).toBeVisible();
});

test('password never reaches the renderer', async () => {
  const snapshot = await page.evaluate(() => (globalThis as unknown as { cais: { catalog: { get(): Promise<unknown> } } }).cais.catalog.get());
  expect(JSON.stringify(snapshot)).not.toContain(db.password);
});

test('dev: query shows rows in the grid; screenshots light and dark', async () => {
  await page.getByTestId('env-dev').click();
  await expect(page.getByTestId('tab')).toHaveCount(1);
  await expect(page.getByRole('radio', { name: 'Auto-commit' })).toHaveAttribute('aria-checked', 'true');

  await setSql(
    'SELECT c.id, c.status, c.created_at, co.name, co.national_id\nFROM cards c JOIN companies co ON co.id = c.company_id\nORDER BY c.id;',
  );
  await runCurrent();
  await expect(page.locator('[role=gridcell]', { hasText: 'Café Aurora Ltda' }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[role=gridcell]', { hasText: 'blocked' })).toHaveCount(0);
  await expect(page.getByTestId('conn-state')).toHaveText('Conectado');
  await expect(page.getByTestId('result-summary')).toContainText('6 linhas');
  const empty = page.locator('.cellpanel-empty');
  await expect(empty).toContainText('Selecione uma célula');
  expect(await empty.evaluate((el) => (globalThis as unknown as { getComputedStyle(e: unknown): { fontFamily: string } }).getComputedStyle(el).fontFamily)).not.toMatch(/monospace|Menlo|SF Mono/i);
  await page.locator('[role=gridcell][data-r="0"][data-c="3"]').click();
  await expect(page.getByTestId('cell-panel')).toContainText('Café Aurora Ltda');

  const clipboardText = () => app.evaluate(({ clipboard }) => clipboard.readText());
  // What the Edit > Copy menu role (Cmd/Ctrl+C) does: copy on the window's focused element, here the grid
  const copyShortcut = () =>
    app.evaluate(({ BrowserWindow }) => {
      (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.copy();
    });

  // Copiar as CSV copies the selection (one cell here) with its header
  await page.getByRole('button', { name: /Copiar/ }).click();
  await page.getByRole('menuitem', { name: 'Copiar como CSV' }).click();
  await expect.poll(clipboardText).toBe('name\nCafé Aurora Ltda');

  // Cmd/Ctrl+C on one cell copies the raw value, with no header
  await page.locator('[role=gridcell][data-r="0"][data-c="3"]').click();
  await copyShortcut();
  await expect.poll(clipboardText).toBe('Café Aurora Ltda');

  // Copy value, from the Copy button and from the cell's context menu
  await page.getByRole('button', { name: /Copiar/ }).click();
  await page.getByRole('menuitem', { name: 'Copiar valor' }).click();
  await expect.poll(clipboardText).toBe('Café Aurora Ltda');
  await page.getByRole('button', { name: /Copiar/ }).click();
  await page.getByRole('menuitem', { name: 'Copiar como tabela Markdown' }).click();
  await expect.poll(clipboardText).toBe('| name |\n| --- |\n| Café Aurora Ltda |');
  await page.locator('[role=gridcell][data-r="1"][data-c="3"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copiar valor' }).click();
  await expect.poll(clipboardText).toBe(await page.locator('[role=gridcell][data-r="1"][data-c="3"]').innerText());

  // A numeric column is right-aligned in the Markdown table
  await page.locator('[role=gridcell][data-r="0"][data-c="0"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copiar como tabela Markdown' }).click();
  await expect.poll(clipboardText).toMatch(/^\| id \|\n\| ---: \|\n\| \d+ \|$/);

  // A range keeps the TSV with header on Cmd/Ctrl+C and has no "Copy value"
  await page.locator('[role=gridcell][data-r="0"][data-c="0"]').click();
  await page.locator('[role=gridcell][data-r="1"][data-c="1"]').click({ modifiers: ['Shift'] });
  await copyShortcut();
  await expect.poll(clipboardText).toMatch(/^id\tstatus\n\d+\t.+\n\d+\t.+$/);
  await page.getByRole('button', { name: /Copiar/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Copiar valor' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Copiar como tabela Markdown' }).click();
  await expect.poll(clipboardText).toMatch(/^\| id \| status \|\n\| ---: \| --- \|\n\| \d+ \| .+ \|\n\| \d+ \| .+ \|$/);
  await page.locator('[role=gridcell][data-r="0"][data-c="3"]').click();

  await setTheme('light');
  await page.screenshot({ path: join(shots, 'main-light.png') });
  await setTheme('dark');
  await page.screenshot({ path: join(shots, 'main-dark.png') });
  await setTheme('light');
});

test('production opens read-only and refuses an INSERT', async () => {
  await page.getByTestId('env-pro').click();
  await expect(page.getByTestId('tab')).toHaveCount(2);
  await expect(page.getByRole('radio', { name: 'Somente leitura' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Produção', { exact: true }).first()).toBeVisible();

  await setSql("INSERT INTO people (name) VALUES ('Intruso');");
  await runCurrent();
  const error = page.getByRole('alert');
  await expect(error).toContainText('Comando recusado');
  await expect(error).toContainText('Somente leitura');

  await setSql('SELECT id, name, email, profile FROM people ORDER BY id;');
  await runCurrent();
  await expect(page.locator('[role=gridcell]', { hasText: 'ana@exemplo.com' })).toBeVisible({ timeout: 20_000 });
  await page.locator('[role=gridcell][data-r="0"][data-c="3"]').click();
  await expect(page.getByTestId('cell-panel')).toContainText('"plano": "ouro"');
  await page.screenshot({ path: join(shots, 'production-light.png') });

  // nothing was written
  await setSql("SELECT COUNT(*) AS total FROM people WHERE name = 'Intruso';");
  await runCurrent();
  await expect(page.locator('[role=gridcell]', { hasText: /^0$/ })).toBeVisible();
});

test('transaction mode: INSERT then Rollback removes the row; Commit keeps it', async () => {
  await page.getByTestId('tab').first().click();
  await page.getByRole('radio', { name: 'Transação' }).click();

  await setSql("INSERT INTO people (name, email) VALUES ('Zed', 'zed@exemplo.com');");
  await runCurrent();
  await expect(page.getByTestId('affected')).toContainText('1 linha afetada');
  const txbar = page.getByTestId('txbar');
  await expect(txbar).toContainText('Transação aberta · 1 comando');

  await setSql("SELECT id, name, email FROM people WHERE name = 'Zed';");
  await runCurrent();
  await expect(page.locator('[role=gridcell]', { hasText: 'zed@exemplo.com' })).toBeVisible();
  await expect(txbar).toContainText('2 comandos');

  await setTheme('light');
  await page.screenshot({ path: join(shots, 'transaction-light.png') });
  await setTheme('dark');
  await page.screenshot({ path: join(shots, 'transaction-dark.png') });
  await setTheme('light');

  // changing mode with an open transaction is refused
  await page.getByRole('radio', { name: 'Auto-commit' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Faça commit ou rollback antes de trocar o modo' })).toBeVisible();

  await txbar.getByRole('button', { name: 'Rollback' }).click();
  await expect(txbar).toHaveCount(0);
  await setSql("SELECT id, name FROM people WHERE name = 'Zed';");
  await runCurrent();
  await expect(page.getByText('A query não devolveu linhas.')).toBeVisible();

  // commit path
  await setSql("INSERT INTO people (name) VALUES ('Kim');");
  await runCurrent();
  await expect(txbar).toBeVisible();
  await txbar.getByRole('button', { name: 'Commit' }).click();
  await expect(txbar).toHaveCount(0);
  await setSql("SELECT id, name FROM people WHERE name = 'Kim';");
  await runCurrent();
  await expect(page.locator('[role=gridcell]', { hasText: 'Kim' })).toBeVisible();
});

test('the Trail has what the person ran: the refused INSERT in production, the transaction, Rollback and Commit', async () => {
  await page.getByTestId('trail-entry').click();
  const trail = page.getByRole('dialog', { name: 'Trilha' });
  await expect(trail.getByTestId('trail-row').first()).toBeVisible();
  const rows = trail.getByTestId('trail-row');
  await expect(rows.filter({ hasText: 'Commit' }).first()).toContainText('você');
  await expect(rows.filter({ hasText: 'Rollback' }).first()).toBeVisible();
  await expect(rows.filter({ hasText: "INSERT INTO people (name) VALUES ('Intruso')" }).first()).toContainText('recusado');
  await expect(rows.filter({ hasText: "INSERT INTO people (name, email) VALUES ('Zed'" }).first()).toContainText('Transação');
  await expect(rows.filter({ hasText: "INSERT INTO people (name, email) VALUES ('Zed'" }).first()).toContainText('1 afetada');
  await expect(rows.filter({ hasText: 'Somente leitura → Transação' }).or(rows.filter({ hasText: 'Auto-commit → Transação' })).first()).toBeVisible();
  // a read shows how many rows, never which (ana@exemplo.com only exists in the results)
  await expect(rows.filter({ hasText: 'SELECT id, name, email, profile FROM people ORDER BY id' }).first()).toContainText('linhas');
  await expect(trail).not.toContainText('ana@exemplo.com');
  await trail.getByRole('button', { name: 'Fechar' }).click();
});

test('implicit commit asks for confirmation inside a transaction', async () => {
  await setSql("UPDATE people SET email = 'kim@exemplo.com' WHERE name = 'Kim';");
  await runCurrent();
  await expect(page.getByTestId('txbar')).toBeVisible();
  await setSql('CREATE TABLE tmp_e2e (a INT);');
  await runCurrent();
  const dialog = page.getByRole('dialog', { name: 'Esta operação faz commit implícito' });
  await expect(dialog).toContainText('CREATE TABLE tmp_e2e');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByTestId('txbar')).toBeVisible();
  await page.getByTestId('txbar').getByRole('button', { name: 'Rollback' }).click();
});

test('Cmd+Enter with several statements runs the one under the cursor and Shift runs all', async () => {
  await page.getByRole('radio', { name: 'Auto-commit' }).click();
  await setSql('SELECT 1 AS um;\nSELECT 2 AS dois;');
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect(page.getByRole('tab', { name: /1 · SELECT/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /2 · SELECT/ })).toBeVisible();
});

test('a blank line under the cursor runs nothing', async () => {
  await setSql('SELECT 1 AS um;\n\nSELECT 2 AS dois;');
  await page.keyboard.press('ArrowUp');
  await runCurrent();
  await expect(page.getByText('Nenhum comando sob o cursor.')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await runCurrent();
  await expect(page.locator('[role=gridcell]', { hasText: /^1$/ })).toBeVisible();
});

test('autocomplete suggests tables, columns and alias columns from the schema', async () => {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM car');
  const tooltip = page.locator('.cm-tooltip-autocomplete');
  await expect(tooltip).toContainText('cards');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM cards c WHERE c.sta');
  await expect(tooltip).toContainText('status');
  await page.keyboard.press('Escape');
});

test('autocomplete offers the columns of the tables the statement reads, one per table when two share a name', async () => {
  const tooltip = page.locator('.cm-tooltip-autocomplete');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM cards WHERE sta');
  await expect(tooltip).toContainText('status');
  // only the table of the statement: companies has national_id, cards does not
  await expect(tooltip).not.toContainText('national_id');
  await page.keyboard.press('Escape');

  // the FROM after the cursor counts too
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT  FROM companies co JOIN cards c ON c.company_id = co.id');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Home');
  for (let i = 0; i < 'SELECT '.length; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.type('nat');
  await expect(tooltip).toContainText('national_id');
  await page.keyboard.press('Escape');

  // id is in both tables: one option each, the table in the detail
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM cards c JOIN companies co ON c.company_id = co.id WHERE i');
  await expect(tooltip).toContainText('c · int');
  await expect(tooltip).toContainText('co · int');
  await page.keyboard.press('Escape');

  // after FROM the tables come first (before the keywords that start with the same letters)
  const firstLabel = page.locator('.cm-tooltip-autocomplete .cm-completionLabel').first();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM ca');
  await expect(firstLabel).toHaveText('cards');
  await page.keyboard.press('Escape');

  // after WHERE the columns come first, before any keyword (those are in upper case)
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM cards WHERE ');
  await page.keyboard.press('Control+Space');
  await expect(tooltip).toContainText('status');
  await expect(firstLabel).toHaveText(/^[a-z_]+$/);
  await page.keyboard.press('Escape');

  // after UPDATE with an alias the alias columns
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('UPDATE cards x SET x.sta');
  await expect(tooltip).toContainText('status');
  await page.keyboard.press('Escape');
});

test('a syntax error is underlined after a pause, with the parser message in the tooltip, and goes away when fixed', async () => {
  const marks = page.locator('.cm-lintRange-error');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FRM cards;');
  await page.keyboard.press('Escape');
  await expect(marks).toHaveCount(1, { timeout: 10_000 });
  await expect(marks).toHaveText('FRM');
  await marks.hover();
  await expect(page.locator('.cm-tooltip-lint')).toContainText('Possível erro de sintaxe');
  await expect(page.locator('.cm-tooltip-lint')).toContainText("'FRM' is not valid");
  // fixed: the mark goes
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM cards;');
  await page.keyboard.press('Escape');
  await expect(marks).toHaveCount(0, { timeout: 10_000 });
  // an unfinished statement under the cursor is not an error yet
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM cards WHERE');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);
  await expect(marks).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
});

test('Cmd+T picker filters by "api pro" and opens a tab; Cmd+W closes it', async () => {
  await page.keyboard.press('ControlOrMeta+T');
  const picker = page.getByRole('dialog', { name: 'Nova aba' });
  await picker.getByLabel('Buscar ambiente').fill('api pro');
  await expect(picker.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tab')).toHaveCount(3);
  await expect(page.getByRole('tab', { name: /api · pro/ }).last()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ControlOrMeta+W');
  await expect(page.getByTestId('tab')).toHaveCount(2);
});

test('sidebar: double click on a table opens a tab with SELECT * LIMIT 100 and runs it', async () => {
  await page.getByText('cais_test', { exact: true }).first().click();
  await page.getByText('cards', { exact: true }).dblclick();
  await expect(page.getByTestId('tab')).toHaveCount(3);
  await expect(page.locator('.cm-content')).toContainText('SELECT * FROM `cais_test`.`cards` LIMIT 100;');
  await expect(page.locator('[role=gridcell]', { hasText: '4810' })).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('ControlOrMeta+W');
  await page.keyboard.press('ControlOrMeta+W');
  await expect(page.getByTestId('tab')).toHaveCount(1);
});

test('closing a tab with an open transaction asks for Commit or Rollback', async () => {
  await page.getByRole('radio', { name: 'Transação' }).click();
  await setSql("INSERT INTO people (name) VALUES ('Fechar');");
  await runCurrent();
  await expect(page.getByTestId('txbar')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+W');
  const dialog = page.getByRole('dialog', { name: 'Transação aberta' });
  await expect(dialog).toContainText('1 comando ainda não foi confirmado');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByTestId('tab')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+W');
  await page.getByRole('dialog', { name: 'Transação aberta' }).getByRole('button', { name: 'Rollback' }).click();
  await expect(page.getByTestId('tab')).toHaveCount(0);
  await expect(page.getByText('Nenhuma aba aberta')).toBeVisible();
});

test('quitting with an open transaction asks first, and Rollback leaves nothing behind', async () => {
  await page.getByTestId('env-dev').click();
  await page.getByRole('radio', { name: 'Transação' }).click();
  await setSql("INSERT INTO people (name) VALUES ('Sair'); ");
  await runCurrent();
  await expect(page.getByTestId('txbar')).toBeVisible();
  await setSql('SELECT * FROM people;');
  await page.waitForTimeout(900); // debounce of the tabs file
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  const dialog = page.getByRole('dialog', { name: 'Transações abertas' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('txbar')).toBeVisible();

  const closed = app.waitForEvent('close');
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await page.getByRole('dialog', { name: 'Transações abertas' }).getByRole('button', { name: 'Rollback' }).click();
  await closed;
});

test('tabs persist across restarts without reconnecting; the rolled back row is gone', async () => {
  await launch();
  await expect(page.getByTestId('tab')).toHaveCount(1);
  await expect(page.getByTestId('conn-state')).toHaveText('Desconectado');
  await expect(page.locator('.cm-content')).toContainText('SELECT * FROM people;');
  await page.getByTestId('run').click();
  await expect(page.locator('[role=gridcell]', { hasText: 'Kim' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[role=gridcell]', { hasText: 'Sair' })).toHaveCount(0);
});

test('a corrupt catalog.json and tabs.json are set aside and the app opens empty with a notice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cais-e2e-corrupt-'));
  writeFileSync(join(dir, 'catalog.json'), '{broken');
  writeFileSync(join(dir, 'tabs.json'), '{"version":1,"tabs":[null],"activeTabId":null}');
  const other = await electron.launch(electronOptions(dir));
  try {
    const win = await other.firstWindow();
    const notices = win.getByTestId('startup-notice');
    await expect(notices).toHaveCount(2);
    await expect(notices.first()).toContainText('catalog.json');
    await expect(notices.first()).toContainText('.corrupt-');
    await expect(win.getByText('Cadastre uma credencial e um ambiente para começar')).toBeVisible();
    await other.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light';
    });
    await win.emulateMedia({ colorScheme: 'light' });
    await win.waitForTimeout(350);
    await win.screenshot({ path: join(shots, 'corrupt-notice-light.png') });
    await notices.first().getByRole('button', { name: 'Entendi' }).click();
    await expect(notices).toHaveCount(1);
  } finally {
    await other.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
