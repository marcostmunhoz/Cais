import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, root, seedUserData, setSql, setTheme, shortTempDir, shots } from './helpers';

// The app in English (CAIS_LOCALE=en, test hook of the unpackaged app). The person reads English
// everywhere (menus, sidebar, bars, dialogs, the agent modal); the agent keeps reading pt-BR through the real CLI.

const cliFile = join(root, 'out', 'cli', 'cais.mjs');

let userData: string;
let socket: string;
let app: ElectronApplication;
let page: Page;

interface CliRun {
  code: number;
  stdout: string;
  json: any;
}

function cli(args: string[]): Promise<CliRun> {
  const child = spawn(process.execPath, [cliFile, ...args], { env: { ...process.env, CAIS_SOCKET: socket } });
  let stdout = '';
  child.stdout.on('data', (c) => (stdout += c));
  return new Promise<CliRun>((resolve) => {
    child.on('close', (code) => {
      let json: unknown;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      resolve({ code: code ?? -1, stdout, json });
    });
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  userData = shortTempDir('cais-en-');
  socket = join(userData, 'a.sock');
  seedUserData(userData);
  ({ app, page } = await launch(userData, { CAIS_LOCALE: 'en', CAIS_SOCKET: socket }));
  await expect(page.getByTestId('env-dev')).toBeVisible();
});
test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(userData, { recursive: true, force: true });
});

const dialog = (name: string) => page.getByRole('dialog', { name });

test('the application menu is in English', async () => {
  const menu = await app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? []).map((item) => ({ label: item.label, items: (item.submenu?.items ?? []).map((i) => i.label).filter(Boolean) })),
  );
  const labels = menu.map((i) => i.label);
  expect(labels).toEqual(expect.arrayContaining(['Edit', 'View', 'Window']));
  const all = menu.flatMap((i) => i.items);
  expect(all).toEqual(expect.arrayContaining(['Install cais Command in Terminal', 'Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All', 'Minimize']));
  for (const pt of ['Editar', 'Desfazer', 'Colar', 'Janela', 'Exibir', 'Selecionar tudo']) expect(all.concat(labels)).not.toContain(pt);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('sidebar, session bar and status bar in English; screenshot', async () => {
  const nav = page.getByRole('navigation');
  await expect(nav).toContainText('Projects');
  await expect(nav).toContainText('Credentials');
  await expect(nav).toContainText('Agents');
  await expect(nav).toContainText('Trail');
  await page.getByTestId('env-dev').click();
  const bar = page.getByTestId('sessionbar');
  await expect(bar.getByTestId('run')).toContainText('Run');
  await expect(bar.getByTestId('btn-save')).toContainText('Save');
  await expect(page.getByRole('radio', { name: 'Auto-commit' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Read-only' })).toBeVisible();
  // opening the tab connects; Disconnect, then Run reconnects
  await expect(page.getByTestId('conn-state')).toHaveText(/^Connected/);
  await bar.getByTestId('btn-disconnect').click();
  await expect(page.getByTestId('conn-state')).toContainText('Disconnected');
  await setSql(page, 'SELECT id, status FROM cards ORDER BY id;');
  await bar.getByTestId('run').click();
  await expect(page.getByTestId('conn-state')).toHaveText(/^Connected/);
  await expect(page.getByTestId('result-summary')).toContainText('6 rows');
  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'main-en-light.png') });
});

test('the Registry and the Trail open with English headings', async () => {
  await page.getByRole('navigation').getByRole('button', { name: 'Credentials' }).click();
  const registry = dialog('Registry');
  await expect(registry).toBeVisible();
  await expect(registry.getByRole('tab', { name: 'Environments' })).toBeVisible();
  await expect(registry.getByRole('tab', { name: 'Credentials' })).toBeVisible();
  await registry.getByRole('button', { name: 'Close' }).first().click();
  await expect(registry).toHaveCount(0);

  await page.getByTestId('trail-entry').click();
  const trail = dialog('Trail');
  await expect(trail).toBeVisible();
  await expect(trail.getByLabel('Period')).toBeVisible();
  await expect(trail.getByLabel('Who')).toBeVisible();
  await expect(trail).toContainText('Last 7 days');
  await expect(trail).toContainText('You and agents');
  await expect(trail).toContainText('Each line is chained with a key from the system vault');
  // the run above, by the person: "you"
  await expect(trail.getByTestId('trail-row').filter({ hasText: 'SELECT id, status FROM cards' }).first()).toContainText('you');
  await trail.getByRole('button', { name: 'Close' }).first().click();
  await expect(trail).toHaveCount(0);
});

test('an agent read that needs approval: the modal is English, the CLI stays pt-BR; screenshot', async () => {
  await page.getByTestId('agents-entry').click();
  const panel = dialog('Agents');
  await expect(panel).toContainText('Agent access');
  await panel.getByTestId('agent-switch').click();
  await expect(panel.getByTestId('agent-switch')).toHaveAttribute('aria-checked', 'true');
  await panel.getByRole('button', { name: 'Close' }).first().click();
  await expect(page.getByTestId('agents-status')).toContainText('Agents on');

  // a policy refusal: the CLI's text is pt-BR
  const noReason = await cli(['llm', 'query', 'api/pro', '--sql', 'SELECT 1']);
  expect([noReason.code, noReason.json.code]).toEqual([2, 'reason_required']);
  expect(noReason.json.error).toBe('Este pedido precisa de aprovação. Informe o motivo com --reason.');

  const run = cli(['llm', 'query', 'api/pro', '--sql', 'SELECT id, owner FROM agent_items ORDER BY id', '--reason', 'Check today’s incident', '--wait', '--client', 'Claude Code']);
  const modal = dialog('Agent asks to read');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('Production');
  await expect(modal).toContainText('Claude Code');
  await expect(modal).toContainText('(as stated by the client)');
  await expect(modal.getByLabel('The agent can see the result')).toBeChecked();
  await expect(modal.getByRole('button', { name: 'Reject' })).toBeFocused();
  await expect(modal.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'approval-en-dark.png') });
  await setTheme(app, page, 'light');
  await modal.getByRole('button', { name: 'Approve', exact: true }).click();
  const out = await run;
  expect(out.code).toBe(0);
  expect(out.json).toMatchObject({ status: 'succeeded', decided_by: 'person' });
  expect(out.json.results[0].rows[0]).toEqual([1, 'ana@exemplo.com']);
});

test('an error from main code reaches the agent in pt-BR; the default client name reads in English', async () => {
  const first = await cli(['llm', 'script-save', '--project', 'api', '--name', 'Cards by status', '--sql', 'SELECT status, COUNT(*) FROM cards GROUP BY 1']);
  expect(first.code).toBe(0);
  const again = await cli(['llm', 'script-save', '--project', 'api', '--name', 'cards by status', '--sql', 'SELECT 2']);
  expect([again.code, again.json.code]).toEqual([2, 'duplicate_name']);
  expect(again.json.error).toBe('Já existe um script com esse nome em api.');
  await page.getByTestId('env-dev').getByRole('button', { name: /Expand databases|Collapse databases/ }).first().waitFor();
  if (!(await page.getByTestId('scripts-dev').isVisible())) await page.getByTestId('env-dev').getByRole('button', { name: 'Expand databases' }).click();
  await expect(page.getByTestId('scripts-count-dev')).toHaveText('1');
  if (!(await page.getByTestId('script-Cards by status').isVisible())) await page.getByTestId('scripts-dev').click();
  await expect(page.getByTestId('script-Cards by status').locator('.tag-agent')).toHaveText('agent');

  // the request without --client is recorded as "agente" (persisted as is) and reads "agent" here
  const plain = await cli(['llm', 'query', 'api/dev', '--sql', 'SELECT COUNT(*) AS n FROM agent_items']);
  expect(plain.json.status).toBe('succeeded');
  await page.getByTestId('trail-entry').click();
  const trail = dialog('Trail');
  await expect(trail.getByTestId('trail-row').filter({ hasText: 'SELECT COUNT(*) AS n FROM agent_items' }).first()).toContainText('agent: agent');
  await expect(trail.getByTestId('trail-row').filter({ hasText: 'SELECT id, owner FROM agent_items' }).first()).toContainText('agent: Claude Code');
  await expect(trail).not.toContainText('agente');
  await trail.getByRole('button', { name: 'Close' }).first().click();
});
