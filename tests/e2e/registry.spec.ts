import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, seedUserData, setTheme, shortTempDir, shots } from './helpers';

// Duplicate an environment (prefilled form) and a project, rename a project.
// Own userData: duplicating repeats the testids env-<name>.

let userData: string;
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  userData = shortTempDir('cais-reg-');
  seedUserData(userData);
  ({ app, page } = await launch(userData));
});
test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(userData, { recursive: true, force: true });
});

const dialog = (name: string) => page.getByRole('dialog', { name });
const registry = () => dialog('Cadastro');

async function openEnvMenu(testId: string): Promise<void> {
  const row = page.getByTestId(testId);
  await row.hover();
  await row.getByRole('button', { name: /^Menu do ambiente/ }).click();
}

test('Duplicar on an environment opens the new-environment form prefilled; saving creates it', async () => {
  await expect(page.getByTestId('env-dev')).toBeVisible();
  await openEnvMenu('env-dev');
  await page.getByRole('menuitem', { name: 'Duplicar' }).click();
  const form = registry();
  await expect(form).toBeVisible();
  await expect(form.getByTestId('env-duplicate-of')).toContainText('Cópia de api/dev');
  await expect(form.getByLabel('Nome do ambiente')).toHaveValue('dev (cópia)');
  await expect(form.getByLabel('Projeto', { exact: true })).toHaveValue('p-api');
  await expect(form.getByLabel('Host')).not.toHaveValue('');
  await expect(form.getByLabel('Banco padrão (opcional)')).toHaveValue('cais_test');
  await expect(form.getByLabel('Produção')).not.toBeChecked();
  // a new environment: no Apagar, no Duplicar
  await expect(form.getByRole('button', { name: 'Apagar' })).toHaveCount(0);
  await expect(form.getByRole('button', { name: 'Duplicar' })).toHaveCount(0);

  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'registry-duplicate-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'registry-duplicate-dark.png') });
  await setTheme(app, page, 'light');

  await form.getByRole('button', { name: 'Salvar' }).click();
  await expect(form.getByText('Salvo')).toBeVisible();
  // now editing the saved copy
  await expect(form.getByRole('button', { name: 'Apagar' })).toBeVisible();
  await expect(form.getByTestId('env-duplicate-of')).toHaveCount(0);
  await expect(page.getByTestId('env-dev (cópia)')).toBeVisible();
});

test('the Duplicar button in the form copies production too; the name stays unique in NFC ignoring case', async () => {
  const form = registry();
  await form.locator('.registry-list .tree-row', { hasText: /^pro$/ }).click();
  await form.getByRole('button', { name: 'Duplicar' }).click();
  await expect(form.getByLabel('Nome do ambiente')).toHaveValue('pro (cópia)');
  await expect(form.getByLabel('Produção')).toBeChecked();
  // an existing name (another case) is refused by main
  await form.getByLabel('Nome do ambiente').fill('DEV');
  await form.getByRole('button', { name: 'Salvar' }).click();
  await expect(form.getByRole('alert')).toContainText('O projeto já tem um ambiente chamado "DEV"');
  // "/" would make the agents' slug ambiguous
  await form.getByLabel('Nome do ambiente').fill('pro/2');
  await form.getByRole('button', { name: 'Salvar' }).click();
  await expect(form.getByRole('alert')).toContainText('não pode ter "/"');
  await form.getByLabel('Nome do ambiente').fill('pro (cópia)');
  await form.getByRole('button', { name: 'Salvar' }).click();
  await expect(form.getByText('Salvo')).toBeVisible();
  await form.getByRole('button', { name: 'Fechar' }).click();
  await expect(page.getByTestId('env-pro (cópia)')).toBeVisible();
});

test('Duplicar projeto copies every environment under the name chosen in the prompt', async () => {
  await page.getByTestId('project-api').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Duplicar projeto' }).click();
  const prompt = dialog('Duplicar projeto');
  await expect(prompt.getByLabel('Nome do projeto')).toHaveValue('api (cópia)');
  await expect(prompt).toContainText('Os scripts não são copiados');

  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'project-duplicate-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'project-duplicate-dark.png') });
  await setTheme(app, page, 'light');

  await prompt.getByRole('button', { name: 'Duplicar' }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByTestId('project-api (cópia)')).toBeVisible();
  for (const name of ['dev', 'pro', 'dev (cópia)', 'pro (cópia)']) await expect(page.getByTestId(`env-${name}`)).toHaveCount(2);
});

test('Renomear projeto from the tree; a name with "/" or one already taken is refused inside the prompt', async () => {
  const row = page.getByTestId('project-api (cópia)');
  await row.hover();
  await row.getByRole('button', { name: 'Menu do projeto api (cópia)' }).click();
  await page.getByRole('menuitem', { name: 'Renomear projeto' }).click();
  const prompt = dialog('Renomear projeto');
  const input = prompt.getByLabel('Nome do projeto');
  await expect(input).toHaveValue('api (cópia)');
  await input.fill('web/api');
  await prompt.getByRole('button', { name: 'Renomear' }).click();
  await expect(prompt.getByRole('alert')).toContainText('não pode ter "/"');
  await input.fill('API');
  await prompt.getByRole('button', { name: 'Renomear' }).click();
  await expect(prompt.getByRole('alert')).toContainText('Já existe um projeto chamado "API"');
  await input.fill('web');
  await prompt.getByRole('button', { name: 'Renomear' }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByTestId('project-web')).toBeVisible();
  await expect(page.getByTestId('project-api (cópia)')).toHaveCount(0);
});

test('Renomear from the group header in the Cadastro; Esc closes only the prompt', async () => {
  await page.getByRole('button', { name: 'Cadastrar ambiente ou credencial' }).click();
  const form = registry();
  await form.getByTestId('registry-project-api').hover();
  await form.getByRole('button', { name: 'Renomear o projeto api' }).click();
  const prompt = dialog('Renomear projeto');
  await expect(prompt.getByLabel('Nome do projeto')).toHaveValue('api');
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(form).toBeVisible();

  await form.getByRole('button', { name: 'Renomear o projeto api' }).click();
  await expect(prompt).toContainText('Liberações de agentes deste projeto são revogadas');
  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'project-rename-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'project-rename-dark.png') });
  await setTheme(app, page, 'light');
  await prompt.getByLabel('Nome do projeto').fill('core');
  await prompt.getByLabel('Nome do projeto').press('Enter');
  await expect(prompt).toHaveCount(0);
  await expect(form.getByTestId('registry-project-core')).toBeVisible();
  await expect(form.getByTestId('registry-project-web')).toBeVisible();
  await form.getByRole('button', { name: 'Fechar' }).click();
  await expect(page.getByTestId('project-core')).toBeVisible();
});

test('the Trilha has a line per copied environment and per environment of a renamed project', async () => {
  await page.getByTestId('trail-entry').click();
  const trail = dialog('Trilha');
  await trail.getByTestId('trail-search').fill('cópia de');
  await expect(trail.getByTestId('trail-row')).toHaveCount(4);
  await expect(trail.getByTestId('trail-row').filter({ hasText: 'Ambiente criado (cópia de api/pro (cópia))' })).toHaveCount(1);
  await trail.getByTestId('trail-search').fill('Projeto renomeado');
  await expect(trail.getByTestId('trail-row')).toHaveCount(8);
  await expect(trail.getByTestId('trail-row').filter({ hasText: 'Projeto renomeado: api (cópia) → web.' })).toHaveCount(4);
  await expect(trail.getByTestId('trail-row').filter({ hasText: 'Projeto renomeado: api → core.' })).toHaveCount(4);
  await trail.getByRole('button', { name: 'Fechar' }).click();
});

test('after a relaunch on the same userData nothing is blocked and a copied environment connects', async () => {
  await app.close();
  ({ app, page } = await launch(userData));
  await expect(page.getByTestId('project-core')).toBeVisible();
  await expect(page.getByTestId('project-web')).toBeVisible();
  await expect(page.getByTestId('startup-notice')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cadastrar ambiente ou credencial' }).click();
  const form = registry();
  await expect(form.locator('.registry-list .tree-row')).toHaveCount(8);
  await expect(form.locator('.registry-list .detail', { hasText: 'bloqueado' })).toHaveCount(0);
  for (const row of await form.locator('.registry-list .tree-row').all()) {
    await row.click();
    await expect(form.getByLabel('Nome do ambiente')).not.toHaveValue('');
    await expect(form.getByTestId('env-blocked')).toHaveCount(0);
  }
  await form.getByRole('button', { name: 'Fechar' }).click();
  // the second "dev" in the tree is the copy in web: trusted, so it connects
  await page.getByTestId('env-dev').nth(1).click();
  await expect(page.getByTestId('conn-chip')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
});
