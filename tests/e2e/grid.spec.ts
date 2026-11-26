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
  await expect(page.locator('.toast')).toHaveText('Rodaram na transação: 2 UPDATEs. Faça Commit para gravar.');
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

test('Cmd/Ctrl+C on one cell copies the raw value: NULL, JSON as sent, a cut binary with a notice', async () => {
  const clipboardText = () => app.evaluate(({ clipboard }) => clipboard.readText());
  // what the Edit > Copy menu role (Cmd/Ctrl+C) does: copy on the window's focused element, here the grid
  const copyShortcut = () =>
    app.evaluate(({ BrowserWindow }) => {
      (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.copy();
    });
  await run(`SELECT NULL AS n, CAST('{"a": 1}' AS JSON) AS j, CAST(REPEAT('a', 300) AS BINARY) AS b, 'x' AS t;`);
  await expect(cell(0, 't')).toHaveText('x', { timeout: 20_000 });

  await cell(0, 'n').click();
  await copyShortcut();
  await expect.poll(clipboardText).toBe('NULL');

  // JSON is not quoted like a TSV field: it is the text the server sent
  await cell(0, 'j').click();
  await copyShortcut();
  await expect.poll(clipboardText).toBe('{"a": 1}');
  await expect(page.getByTestId('grid-hint')).toHaveCount(0);

  // a binary the driver cut (256 of 300 bytes) is copied as shown, and the grid says it is partial
  await cell(0, 'b').click();
  await copyShortcut();
  await expect.poll(clipboardText).toBe(`0x${'61'.repeat(256)}…`);
  await expect(page.getByTestId('grid-hint')).toHaveText('Cópia parcial do binário: (300 bytes, mostrando os primeiros 256)');

  // the notice goes away with the selection
  await cell(0, 't').click();
  await expect(page.getByTestId('grid-hint')).toHaveCount(0);

  // the same cut binary through the cell menu: same text, same notice
  await app.evaluate(({ clipboard }) => clipboard.writeText('antes'));
  await cell(0, 'b').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copiar valor' }).click();
  await expect.poll(clipboardText).toBe(`0x${'61'.repeat(256)}…`);
  await expect(page.getByTestId('grid-hint')).toHaveText('Cópia parcial do binário: (300 bytes, mostrando os primeiros 256)');
});

test('copy uses pending edits, and the cell editor keeps its own text selection', async () => {
  const clipboardText = () => app.evaluate(({ clipboard }) => clipboard.readText());
  const copyShortcut = () =>
    app.evaluate(({ BrowserWindow }) => {
      (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.copy();
    });
  await run(READ);
  await expect(cell(0, 'name')).toBeVisible({ timeout: 20_000 });
  await expect(bar()).toHaveCount(0);

  // copying inside the open cell editor copies the input's selection, not the cell's stored value
  await cell(0, 'name').dblclick();
  await expect(editor()).toBeVisible();
  await editor().fill('abc def');
  await editor().selectText();
  await copyShortcut();
  await expect.poll(clipboardText).toBe('abc def');
  await editor().press('Escape');
  await expect(editor()).toHaveCount(0);
  await expect(bar()).toHaveCount(0);

  // a pending edit is what Cmd/Ctrl+C and the menus copy
  await editCell(0, 'name', 'Nome | novo');
  await cell(0, 'name').click();
  await copyShortcut();
  await expect.poll(clipboardText).toBe('Nome | novo');
  await cell(0, 'name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copiar como tabela Markdown' }).click();
  await expect.poll(clipboardText).toBe('| name |\n| --- |\n| Nome \\| novo |');

  // a pending NULL copies as the word NULL
  await cell(0, 'note').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Definir como NULL' }).click();
  await expect(cell(0, 'note')).toHaveText('NULL');
  await cell(0, 'note').click();
  await copyShortcut();
  await expect.poll(clipboardText).toBe('NULL');

  await page.getByTestId('edit-discard').click();
  await expect(bar()).toHaveCount(0);
});

test('Gerar UPDATE da célula: one cell, a column of cells, with the value literals selected', async () => {
  await run(READ);
  await expect(cell(0, 'name')).toBeVisible({ timeout: 20_000 });
  await expect(bar()).toHaveCount(0);
  // earlier tests changed rows: read what the grid holds (plain ASCII text, so the literal is 'text')
  const note3 = await cell(2, 'note').innerText();
  const name1 = await cell(0, 'name').innerText();
  const name2 = await cell(1, 'name').innerText();
  const selected = () => page.evaluate<string>('String(window.getSelection())');

  // one cell: the statement goes at the end of the editor with the literal selected, and nothing runs
  await cell(2, 'note').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Gerar UPDATE da célula' }).click();
  await expect(page.locator('.cm-content')).toContainText(`UPDATE \`cais_test\`.\`grid_items\` SET \`note\` = '${note3}' WHERE \`id\` = 3;`);
  await expect(page.locator('.cm-selectionBackground').first()).toBeVisible();
  await expect.poll(selected).toBe(`'${note3}'`);
  // typing replaces the literal
  await page.keyboard.type('NULL');
  await expect(page.locator('.cm-content')).toContainText('SET `note` = NULL WHERE `id` = 3;');
  expect(await dbValue('SELECT note FROM grid_items WHERE id = 3')).toBe(note3);
  await expect(bar()).toHaveCount(0);

  // a pending edit is the value written, and stays pending
  await editCell(0, 'name', 'Caneta nova');
  await cell(0, 'name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Gerar UPDATE da célula' }).click();
  await expect(page.locator('.cm-content')).toContainText("SET `name` = 'Caneta nova' WHERE `id` = 1;");
  await expect(bar()).toContainText('1 alteração em 1 linha');
  await expect(cell(0, 'name')).toHaveAttribute('data-edited', 'true');
  await page.getByTestId('edit-discard').click();

  // two cells of a column: one UPDATE per row, both literals selected at once, so typing replaces both
  await cell(0, 'name').click();
  await cell(1, 'name').click({ modifiers: ['Shift'] });
  await cell(1, 'name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Gerar UPDATE de 2 células' }).click();
  await expect.poll(editorText).toContain(
    `UPDATE \`cais_test\`.\`grid_items\` SET \`name\` = '${name1}' WHERE \`id\` = 1;\nUPDATE \`cais_test\`.\`grid_items\` SET \`name\` = '${name2}' WHERE \`id\` = 2;`,
  );
  await page.keyboard.type('Z');
  await expect.poll(editorText).toContain('SET `name` = Z WHERE `id` = 1;');
  await expect.poll(editorText).toContain('SET `name` = Z WHERE `id` = 2;');
  expect(await dbValue('SELECT name FROM grid_items WHERE id = 2')).toBe(name2);

  // not offered over a selection of several columns
  await cell(0, 'name').click();
  await cell(1, 'note').click({ modifiers: ['Shift'] });
  await cell(1, 'note').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Copiar como tabela Markdown' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Gerar UPDATE/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('no keystroke or click adds a cursor to the editor: Mod-Alt-ArrowDown keeps one range', async () => {
  await setSql(page, 'SELECT 1;\nSELECT 2;\nSELECT 3;');
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ControlOrMeta+Alt+ArrowDown');
  await page.keyboard.press('ControlOrMeta+Alt+ArrowDown');
  await expect(page.locator('.cm-cursor-secondary')).toHaveCount(0);
  // typing lands in one place only, and Cmd+Enter runs the one statement under the cursor
  await page.keyboard.type('/*x*/');
  await expect.poll(editorText).toBe('/*x*/SELECT 1;\nSELECT 2;\nSELECT 3;');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('result-grid').locator('[role=gridcell]')).toHaveText('1');
  // Mod-click adds no range either
  await page.locator('.cm-line').nth(1).click();
  await page.locator('.cm-line').nth(2).click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('.cm-cursor-secondary')).toHaveCount(0);
});

test('Gerar UPDATE da célula is not offered where the cell cannot be edited', async () => {
  await run('SELECT id, name, 1 + 1 AS two FROM grid_items ORDER BY id;');
  await expect(cell(0, 'two')).toBeVisible({ timeout: 20_000 });
  await cell(0, 'two').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Copiar valor' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Gerar UPDATE/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await cell(0, 'name').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Gerar UPDATE da célula' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('Gerar INSERT: the selected rows, with and without the primary key, from the cell and the row gutter', async () => {
  await db.query(
    `CREATE TABLE grid_ins (
       id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(30) NOT NULL, note VARCHAR(50) NULL,
       shout VARCHAR(30) AS (UPPER(name)) VIRTUAL, price DECIMAL(10,2) NOT NULL, tag VARBINARY(400) NULL
     )`,
  );
  await db.query(
    `INSERT INTO grid_ins (name, note, price, tag) VALUES
       ('Ana', NULL, 1.50, X'00ff'), ('d''Ávila', 'x;y', 20.00, NULL), ('Caio', 'c', 3.25, REPEAT('a', 300))`,
  );
  const text = async () => (await editorText()).replace(/ /g, ' ');
  const insert = page.getByRole('menuitem', { name: 'Gerar INSERT', exact: true });
  const insertNoKey = page.getByRole('menuitem', { name: 'Gerar INSERT sem chave primária' });
  const selected = () => page.evaluate<string>('String(window.getSelection())');
  const gutter = (r: number) => page.locator(`[data-gr="${r}"]`);
  const count = async () => Number(await dbValue('SELECT COUNT(*) FROM grid_ins'));

  await run('SELECT * FROM grid_ins ORDER BY id;');
  await expect(cell(0, 'name')).toHaveText('Ana', { timeout: 20_000 });

  // two rows from a cell: one multi-row INSERT at the end of the editor, selected, and nothing runs. The generated
  // column (shout) is left out and the toast says so.
  await cell(0, 'name').click();
  await cell(1, 'name').click({ modifiers: ['Shift'] });
  await cell(1, 'name').click({ button: 'right' });
  await expect(insertNoKey).toBeVisible({ timeout: 20_000 });
  await insert.click();
  await expect.poll(text).toContain(
    "INSERT INTO `cais_test`.`grid_ins` (`id`, `name`, `note`, `price`, `tag`) VALUES\n  (1, 'Ana', NULL, 1.50, X'00ff'),\n  (2, 'd''Ávila', 'x;y', 20.00, NULL);",
  );
  await expect(page.locator('.toast')).toHaveText(/^Fora do INSERT: shout /);
  await expect.poll(selected).toContain("(2, 'd''Ávila', 'x;y', 20.00, NULL);");
  expect(await count()).toBe(3);

  // without the primary key: the same rows with no id, for the server to number
  await cell(0, 'name').click();
  await cell(1, 'name').click({ modifiers: ['Shift'] });
  await cell(1, 'name').click({ button: 'right' });
  await insertNoKey.click();
  await expect.poll(text).toContain(
    "INSERT INTO `cais_test`.`grid_ins` (`name`, `note`, `price`, `tag`) VALUES\n  ('Ana', NULL, 1.50, X'00ff'),\n  ('d''Ávila', 'x;y', 20.00, NULL);",
  );

  // the row gutter has the same menu: a click outside the selection takes that whole row
  await cell(2, 'name').click();
  await gutter(1).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Gerar INSERT sem chave primária' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Copiar como tabela Markdown' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Editar célula' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Gerar INSERT sem chave primária' }).click();
  await expect.poll(text).toContain("(`name`, `note`, `price`, `tag`) VALUES ('d''Ávila', 'x;y', 20.00, NULL);");
  await expect(cell(1, 'name')).toHaveClass(/sel/);
  expect(await count()).toBe(3);

  // a whole column picked from its header is not whole rows: a right-click on one row's gutter takes that row only
  await page.locator('[data-hc="1"]').click();
  await gutter(1).click({ button: 'right' });
  await insert.click();
  await expect.poll(text).toContain("(`id`, `name`, `note`, `price`, `tag`) VALUES (2, 'd''Ávila', 'x;y', 20.00, NULL);");
  await expect(page.locator('.toast')).not.toContainText('até 1.000');

  // a pending edit is the value written, and stays pending
  await editCell(0, 'name', 'Zed');
  await gutter(0).click({ button: 'right' });
  await insert.click();
  await expect.poll(text).toContain("(`id`, `name`, `note`, `price`, `tag`) VALUES (1, 'Zed', NULL, 1.50, X'00ff');");
  await expect(bar()).toContainText('1 alteração em 1 linha');
  await page.getByTestId('edit-discard').click();

  // a binary value the driver cut cannot go back: nothing is inserted, and the toast names the column and the row
  const before = await text();
  await gutter(2).click({ button: 'right' });
  await insert.click();
  await expect(page.locator('.toast')).toHaveText('O valor binário de tag na linha 3 está cortado na grade: não dá para gerar o INSERT.');
  expect(await text()).toBe(before);

  await db.query('DROP TABLE grid_ins');
});

test('Gerar INSERT: a table without a primary key only has the plain variant, and a read that is not one table has none', async () => {
  await db.query('CREATE TABLE grid_nopk (a INT, b VARCHAR(10))');
  await db.query("INSERT INTO grid_nopk VALUES (1, 'x'), (2, NULL)");
  const text = async () => (await editorText()).replace(/ /g, ' ');

  await run('SELECT * FROM grid_nopk;');
  await expect(cell(0, 'b')).toHaveText('x', { timeout: 20_000 });
  await cell(1, 'a').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Gerar INSERT', exact: true }).click({ timeout: 20_000 });
  await expect.poll(text).toContain('INSERT INTO `cais_test`.`grid_nopk` (`a`, `b`) VALUES (2, NULL);');
  await cell(1, 'a').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Gerar INSERT', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Gerar INSERT sem chave primária' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Editar célula' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // a join, and a result of expressions only
  await run('SELECT i.id, i.name, c.status FROM grid_items i JOIN cards c ON c.id = i.id + 4809 ORDER BY i.id;');
  await expect(cell(0, 'status')).toHaveText('active', { timeout: 20_000 });
  await cell(0, 'name').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Copiar como tabela Markdown' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Gerar INSERT/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await run('SELECT 1 AS one;');
  await expect(cell(0, 'one')).toHaveText('1', { timeout: 20_000 });
  await cell(0, 'one').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Copiar valor' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Gerar INSERT/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await db.query('DROP TABLE grid_nopk');
});

test('Excluir linha: mark from the cell menu, the row gutter and the Delete key; a marked row keeps its edits and cannot be edited', async () => {
  await db.query('CREATE TABLE grid_del (id INT PRIMARY KEY, v VARCHAR(20) NOT NULL)');
  await db.query("INSERT INTO grid_del VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd'), (5, 'e')");
  // a table that cascades from it, there from the start so the environment tree knows the foreign key
  await db.query('CREATE TABLE grid_del_kids (id INT PRIMARY KEY, parent_id INT, FOREIGN KEY (parent_id) REFERENCES grid_del (id) ON DELETE CASCADE)');
  const gutter = (r: number) => page.locator(`[data-gr="${r}"]`);
  const row = (r: number) => page.locator(`[role=row][aria-rowindex="${r + 1}"]`);

  await page.getByTestId('env-dev').click();
  await expect(page.getByTestId('conn-chip')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
  if (await page.getByTestId('txbar').count()) {
    await page.getByTestId('txbar').getByRole('button', { name: 'Rollback' }).click();
    await expect(page.getByTestId('txbar')).toHaveCount(0);
  }
  await page.getByRole('radio', { name: 'Auto-commit' }).click();
  await expect(page.getByRole('radio', { name: 'Auto-commit' })).toHaveAttribute('aria-checked', 'true');
  await run('SELECT id, v FROM grid_del ORDER BY id;');
  await expect(cell(4, 'v')).toHaveText('e', { timeout: 20_000 });

  // from the cell menu, with the shortcut shown in it
  await editCell(1, 'v', 'b2');
  await cell(1, 'v').click({ button: 'right' });
  const del = page.getByRole('menuitem', { name: /^Excluir linha/ });
  await expect(del).toContainText(process.platform === 'darwin' ? '⌫' : 'Delete');
  await del.click();
  await expect(row(1)).toHaveAttribute('data-deleted', 'true');
  // the deletion wins: the edit stays stored but is no longer a change to apply
  await expect(bar()).toHaveText(/1 exclusão/);
  await expect(bar()).not.toContainText('alteração');

  // a marked row does not open for editing and says why
  await cell(1, 'v').dblclick();
  await expect(editor()).toHaveCount(0);
  await expect(page.getByTestId('grid-hint')).toHaveText('A linha está marcada para exclusão. Desfaça a exclusão para editá-la.');

  // from the row gutter, and with the Delete key
  await gutter(3).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Excluir linha' }).click();
  await expect(row(3)).toHaveAttribute('data-deleted', 'true');
  await cell(4, 'v').click();
  await page.keyboard.press('Delete');
  await expect(row(4)).toHaveAttribute('data-deleted', 'true');
  await expect(bar()).toContainText('3 exclusões');

  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'grid-delete-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'grid-delete-dark.png') });
  await setTheme(app, page, 'light');

  // Desfazer exclusão brings the edit back
  await cell(1, 'v').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Desfazer exclusão' }).click();
  await expect(row(1)).not.toHaveAttribute('data-deleted', 'true');
  await expect(cell(1, 'v')).toHaveText('b2');
  await expect(bar()).toContainText('1 alteração em 1 linha');
  await expect(bar()).toContainText('2 exclusões');

  // several selected rows are all marked, and the menu counts them
  await cell(0, 'v').click();
  await cell(2, 'v').click({ modifiers: ['Shift'] });
  await cell(1, 'v').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Excluir 3 linhas' }).click();
  await expect(bar()).toContainText('5 exclusões');
  await expect(bar()).not.toContainText('alteração');
  await page.getByTestId('edit-discard').click();
  await expect(bar()).toHaveCount(0);
  await expect(page.locator('[data-deleted="true"]')).toHaveCount(0);
});

test('Excluir linha: Delete over column headers marks nothing; Gerar UPDATE da célula skips the marked rows', async () => {
  await run('SELECT id, v FROM grid_del ORDER BY id;');
  await expect(cell(4, 'v')).toBeVisible({ timeout: 20_000 });
  await expect(bar()).toHaveCount(0);

  // a click on a column header selects the whole column: Delete marks no row
  await page.locator('[role=columnheader][data-hc="1"]').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-deleted="true"]')).toHaveCount(0);
  await expect(bar()).toHaveCount(0);

  // Cmd+A selects every row of every column: Delete marks them all
  await cell(0, 'v').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-deleted="true"]')).toHaveCount(5);
  await page.getByTestId('edit-discard').click();
  await expect(bar()).toHaveCount(0);

  // a marked row is left out of Gerar UPDATE da célula
  await cell(1, 'v').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-deleted="true"]')).toHaveCount(1);
  await cell(0, 'v').click();
  await cell(2, 'v').click({ modifiers: ['Shift'] });
  await cell(0, 'v').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Gerar UPDATE de 2 células' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Gerar UPDATE de 3 células' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Gerar UPDATE de 2 células' }).click();
  await expect.poll(editorText).toContain('WHERE `id` = 1;');
  await expect.poll(editorText).toContain('WHERE `id` = 3;');
  expect(await editorText()).not.toContain('WHERE `id` = 2;');
  await page.getByTestId('edit-discard').click();
  await expect(bar()).toHaveCount(0);
});

test('Excluir linha: Gerar SQL puts the UPDATEs then the DELETEs in the editor, and runs nothing', async () => {
  await run('SELECT id, v FROM grid_del ORDER BY id;');
  await expect(cell(4, 'v')).toHaveText('e', { timeout: 20_000 });
  await cell(0, 'v').click();
  await page.keyboard.press('Delete');
  await editCell(2, 'v', 'c2');
  await cell(3, 'v').click();
  await page.keyboard.press('Delete');
  await expect(bar()).toContainText('1 alteração em 1 linha · 2 exclusões');
  await page.getByTestId('edit-generate').click();
  await expect(bar()).toHaveCount(0);
  const text = await editorText();
  const at = (sql: string) => text.indexOf(sql);
  expect(at("UPDATE `cais_test`.`grid_del` SET `v` = 'c2' WHERE `id` = 3;")).toBeGreaterThan(-1);
  expect(at('DELETE FROM `cais_test`.`grid_del` WHERE `id` = 1;')).toBeGreaterThan(at("UPDATE `cais_test`.`grid_del` SET `v` = 'c2'"));
  expect(at('DELETE FROM `cais_test`.`grid_del` WHERE `id` = 4;')).toBeGreaterThan(at('DELETE FROM `cais_test`.`grid_del` WHERE `id` = 1;'));
  expect(text).not.toMatch(/LIMIT/);
  expect(await dbValue('SELECT COUNT(*) FROM grid_del')).toBe(5);
});

test('Excluir linha: Auto-commit always asks before deleting, then Aplicar deletes and reads the table again', async () => {
  await run('SELECT id, v FROM grid_del ORDER BY id;');
  await expect(cell(4, 'v')).toHaveText('e', { timeout: 20_000 });
  await cell(1, 'v').click();
  await page.keyboard.press('Delete');
  await cell(3, 'v').click();
  await page.keyboard.press('Delete');
  await page.getByTestId('edit-apply').click();
  const dialog = page.getByRole('dialog', { name: 'Excluir linhas em Auto-commit' });
  await expect(dialog).toContainText('As 2 linhas marcadas serão excluídas do banco.');
  await expect(dialog).toContainText('DELETE FROM `cais_test`.`grid_del` WHERE `id` = 2;');
  await expect(dialog).toContainText('DELETE FROM `cais_test`.`grid_del` WHERE `id` = 4;');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  expect(await dbValue('SELECT COUNT(*) FROM grid_del')).toBe(5);
  await expect(bar()).toContainText('2 exclusões');

  await page.getByTestId('edit-apply').click();
  await page.getByRole('dialog', { name: 'Excluir linhas em Auto-commit' }).getByRole('button', { name: 'Excluir' }).click();
  await expect(bar()).toHaveCount(0);
  await expect(page.locator('[role=row][aria-rowindex]').filter({ has: page.locator('[data-col="v"]') })).toHaveCount(3);
  await expect(cell(1, 'v')).toHaveText('c');
  expect(await dbValue('SELECT COUNT(*) FROM grid_del')).toBe(3);
  expect(await dbValue('SELECT GROUP_CONCAT(id ORDER BY id) FROM grid_del')).toBe('1,3,5');

  // the Trilha labels the DELETE as a grid edit
  await page.getByTestId('trail-entry').click();
  const trail = page.getByRole('dialog', { name: 'Trilha' });
  await trail.getByTestId('trail-row').filter({ hasText: 'DELETE FROM `cais_test`.`grid_del` WHERE `id` = 2' }).first().click();
  await expect(trail.getByTestId('trail-detail')).toContainText('Edição na grade');
  await page.keyboard.press('Escape');
  await expect(trail).toHaveCount(0);
});

test('Excluir linha: in Transação nothing is asked and Commit saves; in Somente leitura Aplicar is disabled; a cascade is warned about', async () => {
  await db.query('INSERT INTO grid_del_kids VALUES (1, 3)');
  await page.getByTestId('env-dev').click();
  await page.getByRole('radio', { name: 'Transação' }).click();
  await expect(page.getByRole('radio', { name: 'Transação' })).toHaveAttribute('aria-checked', 'true');
  await run('SELECT id, v FROM grid_del ORDER BY id;');
  await expect(cell(2, 'v')).toHaveText('e', { timeout: 20_000 });
  await cell(1, 'v').click();
  await page.keyboard.press('Delete');
  await page.getByTestId('edit-apply').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const txbar = page.getByTestId('txbar');
  await expect(txbar).toBeVisible();
  await expect(page.locator('.toast')).toHaveText('Rodaram na transação: 1 DELETE. Faça Commit para gravar.');
  await expect(page.locator('[role=row][aria-rowindex]').filter({ has: page.locator('[data-col="v"]') })).toHaveCount(2);
  // another session still sees the row before the Commit
  expect(await dbValue('SELECT COUNT(*) FROM grid_del')).toBe(3);
  await txbar.getByRole('button', { name: 'Commit' }).click();
  await expect(txbar).toHaveCount(0);
  expect(await dbValue('SELECT COUNT(*) FROM grid_del')).toBe(2);
  // the cascade took the child with it
  expect(await dbValue('SELECT COUNT(*) FROM grid_del_kids')).toBe(0);

  // Somente leitura: Aplicar is disabled, Gerar SQL works
  await page.getByRole('radio', { name: 'Somente leitura' }).click();
  await expect(page.getByRole('radio', { name: 'Somente leitura' })).toHaveAttribute('aria-checked', 'true');
  await run('SELECT id, v FROM grid_del ORDER BY id;');
  await expect(cell(1, 'v')).toHaveText('e', { timeout: 20_000 });
  await cell(0, 'v').click();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('edit-apply')).toBeDisabled();
  await expect(page.getByTestId('edit-generate')).toBeEnabled();
  await page.getByTestId('edit-discard').click();
  await expect(bar()).toHaveCount(0);
});

test('Excluir linha: a table that cascades is warned about in the bar and in the confirmation', async () => {
  await db.query('INSERT INTO grid_del_kids VALUES (2, 1)');
  await page.getByRole('radio', { name: 'Auto-commit' }).click();
  await expect(page.getByRole('radio', { name: 'Auto-commit' })).toHaveAttribute('aria-checked', 'true');
  await run('SELECT id, v FROM grid_del ORDER BY id;');
  await expect(cell(0, 'v')).toHaveText('a', { timeout: 20_000 });
  await cell(0, 'v').click();
  await page.keyboard.press('Delete');
  const warn = page.getByTestId('grid-delete-warning');
  await expect(warn).toContainText('chaves estrangeiras em cascata');
  await expect(warn).toContainText('grid_del_kids');
  await page.getByTestId('edit-apply').click();
  const dialog = page.getByRole('dialog', { name: 'Excluir linhas em Auto-commit' });
  await expect(dialog).toContainText('chaves estrangeiras em cascata');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await page.getByTestId('edit-discard').click();
  expect(await dbValue('SELECT COUNT(*) FROM grid_del_kids')).toBe(1);
  await db.query('DROP TABLE grid_del_kids');
  await db.query('DROP TABLE grid_del');
});

