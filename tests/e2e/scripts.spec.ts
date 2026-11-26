import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ids, launch, seedUserData, setSql, setTheme, shortTempDir, shots } from './helpers';

let userData: string;
let app: ElectronApplication;
let page: Page;

const now = Date.now();
const seeded = [
  { id: 's-faturas', projectId: ids.project, name: 'Faturas sem vínculo', sql: 'SELECT 1 AS faturas;', createdAt: now - 9e6, updatedAt: now - 9e6, createdBy: 'user', lastRun: { environmentId: ids.pro, at: now - 2 * 86_400_000 } },
  { id: 's-dup', projectId: ids.project, name: 'Duplicados por documento', sql: 'SELECT 2 AS dup;', createdAt: now - 5e6, updatedAt: now - 5e6, createdBy: 'agent' },
];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  userData = shortTempDir('cais-sc-');
  seedUserData(userData, { scripts: seeded });
  ({ app, page } = await launch(userData));
});
test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(userData, { recursive: true, force: true });
});

const tab = (name: string | RegExp) => page.getByRole('tab', { name });

async function expandScripts(env: 'dev' | 'pro'): Promise<void> {
  const group = page.getByTestId(`scripts-${env}`);
  if (!(await group.isVisible())) await page.getByTestId(`env-${env}`).getByRole('button', { name: 'Expandir bancos' }).click();
  await group.click();
}

test('Cmd+S on a loose tab asks for a name, saves in the project and links the tab', async () => {
  await page.getByTestId('env-dev').click();
  await expect(page.getByTestId('tab')).toHaveCount(1);
  await setSql(page, "SELECT id, status FROM cards WHERE status = 'blocked';");
  await page.keyboard.press('ControlOrMeta+S');
  const dialog = page.getByRole('dialog', { name: 'Salvar script' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Nome do script').fill('Faturas sem vínculo');
  await dialog.getByRole('button', { name: 'Salvar', exact: true }).click();
  // the name is taken: the error shows inside the prompt
  await expect(dialog.getByRole('alert')).toContainText('Já existe um script com esse nome em api.');
  await dialog.getByLabel('Nome do script').fill('Cartões bloqueados');
  await dialog.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(tab(/Cartões bloqueados/)).toBeVisible();
  await expect(page.getByTestId('dirty-mark')).toHaveCount(0);
});

test('the script is listed under Scripts of dev and of pro; agent scripts carry the tag', async () => {
  await expect(page.getByTestId('scripts-count-dev')).toHaveText('3');
  await expandScripts('dev');
  await expect(page.getByTestId('script-Cartões bloqueados')).toBeVisible();
  await expect(page.getByTestId('script-Duplicados por documento')).toContainText('agente');
  await expect(page.getByTestId('script-Faturas sem vínculo')).toHaveAttribute('title', 'rodou em pro há 2 dias');
  // most recently used first: the one just saved, then the one that ran 2 days ago... saved earlier counts by updatedAt
  const names = await page.locator('[data-testid^="script-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(names[0]).toBe('script-Cartões bloqueados');
  await expandScripts('pro');
  await expect(page.getByTestId('scripts-count-pro')).toHaveText('3');
  await expect(page.locator('[data-testid="script-Cartões bloqueados"]')).toHaveCount(2);
});

test('opening from pro creates a tab of pro; opening the same script there again focuses it', async () => {
  const row = page.getByTestId('scripts-pro').locator('xpath=following-sibling::*[1]');
  await row.click();
  await expect(page.getByTestId('tab')).toHaveCount(2);
  await expect(tab(/Cartões bloqueados/).last()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('sessionbar')).toContainText('pro');
  await expect(page.getByRole('radio', { name: 'Somente leitura' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.cm-content')).toContainText("status = 'blocked'");
  await page.getByTestId('tab').first().click();
  await row.click();
  await expect(page.getByTestId('tab')).toHaveCount(2);
  await expect(tab(/Cartões bloqueados/).last()).toHaveAttribute('aria-selected', 'true');
});

test('editing shows the marker, Cmd+S clears it and the last run is recorded', async () => {
  await setSql(page, "SELECT id, status FROM cards WHERE status = 'pending';");
  const activeMark = page.getByRole('tab', { selected: true }).getByTestId('dirty-mark');
  await expect(activeMark).toBeVisible();
  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'script-tab-dirty-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'script-tab-dirty-dark.png') });
  await setTheme(app, page, 'light');
  await page.keyboard.press('ControlOrMeta+S');
  await expect(activeMark).toHaveCount(0);
  await page.getByTestId('run').click();
  await expect(page.locator('[role=gridcell]', { hasText: '4814' })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => JSON.parse(readFileSync(join(userData, 'scripts.json'), 'utf8')).scripts.find((s: { name: string }) => s.name === 'Cartões bloqueados')?.lastRun?.environmentId).toBe(ids.pro);
  // the dev tab still holds the old text, which now differs from the saved script
  await page.getByTestId('tab').first().click();
  await expect(page.getByTestId('dirty-mark')).toBeVisible();
});

test('closing a tab with unsaved changes asks Save / Discard / Cancel', async () => {
  await setSql(page, 'SELECT 99 AS descartar;');
  await page.keyboard.press('ControlOrMeta+W');
  const dialog = page.getByRole('dialog', { name: 'Alterações não salvas' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByTestId('tab')).toHaveCount(2);
  await page.keyboard.press('ControlOrMeta+W');
  await page.getByRole('dialog', { name: 'Alterações não salvas' }).getByRole('button', { name: 'Descartar' }).click();
  await expect(page.getByTestId('tab')).toHaveCount(1);
  const saved = JSON.parse(readFileSync(join(userData, 'scripts.json'), 'utf8')).scripts.find((s: { name: string }) => s.name === 'Cartões bloqueados');
  expect(saved.sql).not.toContain('descartar');
});

test('screenshots: the tree with scripts in light and dark', async () => {
  await page.getByTestId('tab').first().click();
  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'scripts-tree-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'scripts-tree-dark.png') });
  await setTheme(app, page, 'light');
});

test('Cmd+Shift+S saves as another script; the menu renames, duplicates and deletes', async () => {
  await page.keyboard.press('ControlOrMeta+Shift+S');
  const dialog = page.getByRole('dialog', { name: 'Salvar script' });
  await expect(dialog.getByLabel('Nome do script')).toHaveValue('Cartões bloqueados (cópia)');
  await dialog.getByLabel('Nome do script').fill('Bloqueados hml');
  await dialog.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(tab(/Bloqueados hml/)).toBeVisible();
  await expect(page.getByTestId('scripts-count-dev')).toHaveText('4');
  await expect(page.getByTestId('scripts-count-pro')).toHaveText('4');

  await page.getByRole('button', { name: 'Menu do script Bloqueados hml' }).first().click();
  await page.getByRole('menuitem', { name: 'Renomear' }).click();
  const rename = page.getByRole('dialog', { name: 'Renomear script' });
  await rename.getByLabel('Nome do script').fill('Bloqueados do dia');
  await rename.getByRole('button', { name: 'Renomear' }).click();
  await expect(tab(/Bloqueados do dia/)).toBeVisible();

  await page.getByRole('button', { name: 'Menu do script Bloqueados do dia' }).first().click();
  await page.getByRole('menuitem', { name: 'Duplicar' }).click();
  await expect(page.getByTestId('script-Bloqueados do dia (cópia)').first()).toBeVisible();

  await page.getByRole('button', { name: 'Menu do script Bloqueados do dia (cópia)' }).first().click();
  await page.getByRole('menuitem', { name: 'Abrir em outro ambiente' }).hover();
  await expect(page.getByRole('menuitem', { name: 'pro', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Menu do script Bloqueados do dia (cópia)' }).first().click();
  await page.getByRole('menuitem', { name: 'Excluir' }).click();
  const confirm = page.getByRole('dialog', { name: 'Excluir script' });
  await expect(confirm).toContainText('Excluir o script Bloqueados do dia (cópia)? Não dá para desfazer.');
  await confirm.getByRole('button', { name: 'Excluir' }).click();
  await expect(page.getByTestId('script-Bloqueados do dia (cópia)')).toHaveCount(0);

  // deleting the script of an open tab leaves the tab loose, with its text
  await page.getByRole('button', { name: 'Menu do script Bloqueados do dia' }).first().click();
  await page.getByRole('menuitem', { name: 'Excluir' }).click();
  await page.getByRole('dialog', { name: 'Excluir script' }).getByRole('button', { name: 'Excluir' }).click();
  await expect(tab(/api · pro/).first()).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('cards');
});

test('Cmd+O searches "project · name" and opens in the environment of the active tab', async () => {
  await page.keyboard.press('ControlOrMeta+O');
  const picker = page.getByRole('dialog', { name: 'Abrir script' });
  await picker.getByLabel('Buscar script').fill('api duplic');
  await expect(picker.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('.cm-content')).toContainText('SELECT 2 AS dup;');
  await expect(page.getByTestId('sessionbar')).toContainText('pro');
});

test('restarting keeps the link and the marker; a script that disappeared leaves a loose tab with its text', async () => {
  await setSql(page, 'SELECT 3 AS pendente;');
  await expect(page.getByTestId('dirty-mark')).toBeVisible();
  await page.waitForTimeout(900);
  await app.close();
  ({ app, page } = await launch(userData));
  await expect(page.getByTestId('dirty-mark')).toBeVisible();
  await page.waitForTimeout(900);
  await app.close();

  const file = JSON.parse(readFileSync(join(userData, 'scripts.json'), 'utf8'));
  file.scripts = file.scripts.filter((s: { name: string }) => s.name !== 'Duplicados por documento');
  writeFileSync(join(userData, 'scripts.json'), JSON.stringify(file));
  ({ app, page } = await launch(userData));
  await expect(page.getByTestId('dirty-mark')).toHaveCount(0);
  await expect(tab(/Duplicados por documento/)).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('SELECT 3 AS pendente;');
});
