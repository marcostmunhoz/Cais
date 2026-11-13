import { rmSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, seedUserData, setSql, setTheme, shortTempDir, shots, testDb } from './helpers';

// Editing in the results grid, Gerar UPDATE and Aplicar.
// Own userData; the table grid_items is seeded by global-setup and used only here.

let userData: string;
let app: ElectronApplication;
let page: Page;
let db: mysql.Connection;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  userData = shortTempDir('cais-grid-');
  seedUserData(userData);
  const t = testDb();
  db = await mysql.createConnection({ host: t.host, port: t.port, user: t.user, password: t.password, database: t.database });
  ({ app, page } = await launch(userData));
});
test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await db?.end().catch(() => undefined);
  rmSync(userData, { recursive: true, force: true });
});

const READ = 'SELECT id, name, note, price FROM grid_items ORDER BY id;';
const cell = (r: number, col: string) => page.locator(`[role=gridcell][data-r="${r}"][data-col="${col}"]`);
const editor = () => page.getByTestId('cell-editor');
const bar = () => page.getByTestId('grid-edit-bar');
const editorText = () => page.locator('.cm-content').innerText();
const dbValue = async (sql: string): Promise<unknown> => {
  const [rows] = await db.query(sql);
  return Object.values((rows as Record<string, unknown>[])[0] ?? {})[0];
};

async function run(sql: string): Promise<void> {
  await setSql(page, sql);
  await page.keyboard.press('ControlOrMeta+Enter');
}

async function editCell(r: number, col: string, text: string): Promise<void> {
  await cell(r, col).dblclick();
  await expect(editor()).toBeVisible();
  await editor().fill(text);
  await editor().press('Enter');
  await expect(editor()).toHaveCount(0);
}

test('editing cells marks them and shows the edit bar; Gerar UPDATE puts the statements in the editor', async () => {
  await page.getByTestId('env-dev').click();
  await expect(page.getByTestId('conn-chip')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
  await run(READ);
  await expect(cell(0, 'name')).toHaveText('Caneta', { timeout: 20_000 });

  await editCell(0, 'name', "Caneta d'ouro");
  await expect(cell(0, 'name')).toHaveText("Caneta d'ouro");
  await expect(cell(0, 'name')).toHaveAttribute('data-edited', 'true');
  await expect(cell(0, 'name')).toHaveAttribute('title', 'Alterada. Valor original: Caneta');
  await expect(bar()).toContainText('1 alteração em 1 linha');

  // Esc cancels; Enter on the focused cell (and F2) open the input too
  await cell(2, 'note').click();
  await page.keyboard.press('F2');
  await expect(editor()).toHaveValue('HB');
  await editor().fill('nada');
  await editor().press('Escape');
  await expect(cell(2, 'note')).toHaveText('HB');
  await page.keyboard.press('Enter');
  await editor().fill('2B');
  await editor().press('Enter');
  await expect(cell(2, 'note')).toHaveText('2B');

  // the cell menu: Definir como NULL and Desfazer edição
  await cell(0, 'note').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Definir como NULL' }).click();
  await expect(cell(0, 'note')).toHaveText('NULL');
  await expect(bar()).toContainText('3 alterações em 2 linhas');
  await cell(2, 'note').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Desfazer edição' }).click();
  await expect(cell(2, 'note')).toHaveText('HB');
  await expect(cell(2, 'note')).not.toHaveAttribute('data-edited', 'true');

  // a number column checks what was typed
  await cell(1, 'price').dblclick();
  await editor().fill('12,50');
  await editor().press('Enter');
  await expect(editor()).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('grid-hint')).toHaveText('Valor inválido para price: use um número com ponto decimal.');
  await editor().fill('12.50');
  await editor().press('Enter');
  await expect(bar()).toContainText('3 alterações em 2 linhas');

  await cell(1, 'price').click();
  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'grid-edit-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'grid-edit-dark.png') });
  await setTheme(app, page, 'light');

  await page.getByTestId('edit-generate').click();
  await expect(bar()).toHaveCount(0);
  await expect(cell(0, 'name')).toHaveText('Caneta');
  const text = await editorText();
  expect(text).toContain(READ);
  expect(text).toContain("UPDATE `cais_test`.`grid_items` SET `name` = 'Caneta d''ouro', `note` = NULL WHERE `id` = 1;");
  expect(text).toContain('UPDATE `cais_test`.`grid_items` SET `price` = 12.50 WHERE `id` = 2;');
  // nothing ran
  expect(await dbValue('SELECT name FROM grid_items WHERE id = 1')).toBe('Caneta');
});

test('in Transação, Aplicar runs the UPDATE, shows what the server wrote and waits for Commit', async () => {
  await page.getByRole('radio', { name: 'Transação' }).click();
  await run(READ);
  await expect(cell(0, 'name')).toHaveText('Caneta', { timeout: 20_000 });
  await editCell(0, 'name', 'Caneta azul');
  await editCell(3, 'price', '1.999');
  await page.getByTestId('edit-apply').click();

  const txbar = page.getByTestId('txbar');
  await expect(txbar).toBeVisible();
  // the read ran again: the server rounded the decimal, and nothing is pending any more
  await expect(cell(3, 'price')).toHaveText('2.00');
  await expect(cell(0, 'name')).toHaveText('Caneta azul');
  await expect(cell(0, 'name')).not.toHaveAttribute('data-edited', 'true');
  await expect(bar()).toHaveCount(0);
  await expect(page.getByTestId('grid-edit-notice')).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveText('2 UPDATEs rodaram na transação. Faça Commit para gravar.');
  // another session does not see it before the Commit
  expect(await dbValue('SELECT name FROM grid_items WHERE id = 1')).toBe('Caneta');

  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'grid-applied-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'grid-applied-dark.png') });
  await setTheme(app, page, 'light');

  await txbar.getByRole('button', { name: 'Commit' }).click();
  await expect(txbar).toHaveCount(0);
  expect(await dbValue('SELECT name FROM grid_items WHERE id = 1')).toBe('Caneta azul');
  expect(await dbValue('SELECT price FROM grid_items WHERE id = 4')).toBe('2.00');
  await run("SELECT name FROM grid_items WHERE id = 1;");
  await expect(cell(0, 'name')).toHaveText('Caneta azul');
});

test('an UPDATE that finds no row is reported, and Transação suggests Rollback', async () => {
  await run(READ);
  await expect(cell(1, 'name')).toHaveText('Caderno', { timeout: 20_000 });
  await editCell(1, 'name', 'Caderno grande');
  // someone else removes the row before Aplicar
  await db.query('DELETE FROM grid_items WHERE id = 2');
  await page.getByTestId('edit-apply').click();
  const notice = page.getByTestId('grid-edit-notice');
  await expect(notice).toContainText('O UPDATE 1 não encontrou a linha (esperado: 1).');
  await expect(notice).toContainText('faça Rollback');
  await page.getByTestId('txbar').getByRole('button', { name: 'Rollback' }).click();
  await expect(page.getByTestId('txbar')).toHaveCount(0);
  await db.query("INSERT INTO grid_items VALUES (2, 'Caderno', NULL, 18.90)");
});

test('pending edits are kept until the person agrees to discard them', async () => {
  await run(READ);
  await expect(cell(1, 'name')).toHaveText('Caderno', { timeout: 20_000 });
  await editCell(1, 'note', 'pautado');
  await page.keyboard.press('ControlOrMeta+Enter');
  const dialog = page.getByRole('dialog', { name: 'Descartar as edições da grade' });
  await expect(dialog).toContainText('1 alteração pendente');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(cell(1, 'note')).toHaveText('pautado');
  await page.getByTestId('edit-discard').click();
  await expect(bar()).toHaveCount(0);
  await expect(cell(1, 'note')).toHaveText('NULL');
});

test('in Somente leitura, Aplicar is disabled with the reason and Gerar UPDATE still works', async () => {
  // the reads in Transação keep a transaction open: end it before changing the mode
  await page.getByTestId('txbar').getByRole('button', { name: 'Rollback' }).click();
  await expect(page.getByTestId('txbar')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Somente leitura' }).click();
  await expect(page.getByRole('radio', { name: 'Somente leitura' })).toHaveAttribute('aria-checked', 'true');
  await run(READ);
  await expect(cell(2, 'name')).toHaveText('Lápis', { timeout: 20_000 });
  await editCell(2, 'name', 'Lapiseira');
  await expect(page.getByTestId('edit-apply')).toBeDisabled();
  await expect(page.getByTestId('edit-apply')).toHaveAttribute('title', 'Troque para Transação ou Auto-commit');
  await expect(page.getByTestId('edit-generate')).toBeEnabled();

  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'grid-readonly-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'grid-readonly-dark.png') });
  await setTheme(app, page, 'light');

  await page.getByTestId('edit-discard').click();
  expect(await dbValue('SELECT name FROM grid_items WHERE id = 3')).toBe('Lápis');
});

test('a join result is not editable and says why', async () => {
  await run('SELECT i.id, i.name, c.status FROM grid_items i JOIN cards c ON c.id = i.id + 4809 ORDER BY i.id;');
  await expect(cell(0, 'status')).toHaveText('active', { timeout: 20_000 });
  await cell(0, 'name').dblclick();
  await expect(editor()).toHaveCount(0);
  await expect(page.getByTestId('grid-hint')).toHaveText(
    'Edição na grade só para resultado de uma tabela (este vem de cais_test.grid_items (i), cais_test.cards (c)).',
  );
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 10_000 });

  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'grid-not-editable-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'grid-not-editable-dark.png') });
  await setTheme(app, page, 'light');

  // without the key: the reason names the missing column
  await run('SELECT name FROM grid_items ORDER BY id;');
  await expect(cell(0, 'name')).toHaveText('Caneta azul', { timeout: 20_000 });
  await cell(0, 'name').dblclick();
  await expect(page.getByTestId('grid-hint')).toHaveText(
    'Edição na grade só para resultado de uma tabela com a chave primária inteira (falta: id).',
  );
});

test('Auto-commit in production asks before applying, listing the statements', async () => {
  await page.getByTestId('env-pro').click();
  await expect(page.getByTestId('conn-chip')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
  await page.getByRole('radio', { name: 'Auto-commit' }).click();
  await page.getByRole('dialog', { name: 'Auto-commit em produção' }).getByRole('button', { name: 'Usar auto-commit' }).click();
  await expect(page.getByRole('radio', { name: 'Auto-commit' })).toHaveAttribute('aria-checked', 'true');
  await run(READ);
  await expect(cell(2, 'note')).toHaveText('HB', { timeout: 20_000 });
  await editCell(2, 'note', 'HB nº 2');
  await page.getByTestId('edit-apply').click();
  const dialog = page.getByRole('dialog', { name: 'Aplicar em Auto-commit em produção' });
  await expect(dialog).toContainText("UPDATE `cais_test`.`grid_items` SET `note` = 'HB nº 2' WHERE `id` = 3;");
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  expect(await dbValue('SELECT note FROM grid_items WHERE id = 3')).toBe('HB');

  await page.getByTestId('edit-apply').click();
  await page.getByRole('dialog', { name: 'Aplicar em Auto-commit em produção' }).getByRole('button', { name: 'Aplicar' }).click();
  await expect(cell(2, 'note')).not.toHaveAttribute('data-edited', 'true');
  await expect(cell(2, 'note')).toHaveText('HB nº 2');
  expect(await dbValue('SELECT note FROM grid_items WHERE id = 3')).toBe('HB nº 2');

  // the Trilha keeps the UPDATE as typed SQL, labelled as a grid edit
  await page.getByTestId('trail-entry').click();
  const trail = page.getByRole('dialog', { name: 'Trilha' });
  const row = trail.getByTestId('trail-row').filter({ hasText: "SET `note` = 'HB nº 2'" }).first();
  await row.click();
  await expect(trail.getByTestId('trail-detail')).toContainText('Edição na grade');
  await page.keyboard.press('Escape');
  await expect(trail).toHaveCount(0);
});

test('leaving an untouched editor keeps NULL; Cmd+Enter and Cmd+W while typing ask before discarding', async () => {
  await page.getByTestId('env-dev').click();
  await expect(page.getByTestId('conn-chip')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
  await run(READ);
  await expect(cell(1, 'note')).toHaveText('NULL', { timeout: 20_000 });

  // a NULL cell opens empty: Enter, or leaving it, without typing records nothing (empty text is not NULL)
  await cell(1, 'note').dblclick();
  await expect(editor()).toHaveValue('');
  await editor().press('Enter');
  await expect(editor()).toHaveCount(0);
  await cell(1, 'note').dblclick();
  await cell(0, 'name').click();
  await expect(editor()).toHaveCount(0);
  await expect(cell(1, 'note')).toHaveText('NULL');
  await expect(cell(1, 'note')).not.toHaveAttribute('data-edited', 'true');
  await expect(bar()).toHaveCount(0);

  // Cmd+Enter with a value typed and not confirmed: it counts as a pending edit and the discard question shows
  await cell(0, 'name').dblclick();
  await editor().fill('Caneta preta');
  await page.keyboard.press('ControlOrMeta+Enter');
  const dialog = page.getByRole('dialog', { name: 'Descartar as edições da grade' });
  await expect(dialog).toContainText('1 alteração pendente');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(cell(0, 'name')).toHaveText('Caneta preta');
  await expect(cell(0, 'name')).toHaveAttribute('data-edited', 'true');

  // Cmd+W the same way: the tab stays until the person agrees
  await cell(2, 'name').dblclick();
  await editor().fill('Lapiseira');
  const tabs = await page.getByTestId('tab').count();
  await page.keyboard.press('ControlOrMeta+W');
  await expect(dialog).toContainText('2 alterações pendentes');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByTestId('tab')).toHaveCount(tabs);
  await expect(bar()).toContainText('2 alterações em 2 linhas');
  await page.getByTestId('edit-discard').click();
  await expect(bar()).toHaveCount(0);
});

test('the cell editor opens in view from the keyboard and keeps its text while scrolled away', async () => {
  await db.query('CREATE TABLE grid_many (id INT PRIMARY KEY, v VARCHAR(20) NOT NULL)');
  await db.query(`INSERT INTO grid_many VALUES ${Array.from({ length: 300 }, (_, i) => `(${i + 1}, 'v${i + 1}')`).join(', ')}`);
  await run('SELECT id, v FROM grid_many ORDER BY id;');
  await expect(cell(0, 'v')).toHaveText('v1', { timeout: 20_000 });

  // clicking the header selects the column, with the focus on its last row: Enter edits that row, in view
  await page.locator('[role=columnheader][data-hc="1"]').click();
  await page.keyboard.press('Enter');
  await expect(editor()).toBeVisible();
  await expect(editor()).toHaveValue('v300');
  await editor().fill('fim');
  await editor().press('Enter');
  await expect(cell(299, 'v')).toHaveText('fim');

  // typing, then scrolling far away and back: the input stays, with the text and the focus
  await page.getByTestId('result-grid').evaluate((el) => (el.scrollTop = 0));
  await cell(0, 'v').dblclick();
  await editor().fill('começo');
  await page.getByTestId('result-grid').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(cell(290, 'v')).toBeVisible();
  await expect(editor()).toHaveCount(1);
  await expect(editor()).toBeFocused();
  await page.getByTestId('result-grid').evaluate((el) => (el.scrollTop = 0));
  await expect(editor()).toHaveValue('começo');
  await editor().press('Enter');
  await expect(cell(0, 'v')).toHaveText('começo');
  await expect(bar()).toContainText('2 alterações em 2 linhas');
  await page.getByTestId('edit-discard').click();
});
