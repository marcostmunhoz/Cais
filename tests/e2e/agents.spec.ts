import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, root, seedUserData, setSql, setTheme, shortTempDir, shots, testDb } from './helpers';

const cliFile = join(root, 'out', 'cli', 'cais.mjs');

let userData: string;
let socket: string;
let app: ElectronApplication;
let page: Page;

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

/**
 * The real CLI as a child process, pointed at the test socket. `closeStdout` closes the reading end of its output
 * right after the spawn, before the CLI writes anything, like `| head` that has already gone (EPIPE).
 */
function cli(args: string[], env: Record<string, string> = {}, opts: { closeStdout?: boolean } = {}): Promise<CliRun> & { pid?: number } {
  const child = spawn(process.execPath, [cliFile, ...args], { env: { ...process.env, CAIS_SOCKET: socket, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  if (opts.closeStdout) child.stdout.destroy();
  const promise = new Promise<CliRun>((resolve) => {
    child.on('close', (code) => {
      let json: unknown;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      resolve({ code: code ?? -1, stdout, stderr, json });
    });
  });
  return promise;
}

const dbRows = async (sql: string): Promise<Record<string, unknown>[]> => {
  const db = testDb();
  const conn = await mysql.createConnection({ host: db.host, port: db.port, user: db.user, password: db.password, database: db.database });
  try {
    const [rows] = await conn.query(sql);
    return rows as Record<string, unknown>[];
  } finally {
    await conn.end();
  }
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  userData = shortTempDir('cais-ag-');
  socket = join(userData, 'a.sock');
  seedUserData(userData);
  ({ app, page } = await launch(userData, { CAIS_SOCKET: socket }));
  await expect(page.getByTestId('env-dev')).toBeVisible();
});
test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(userData, { recursive: true, force: true });
});

const modal = (name: string) => page.getByRole('dialog', { name });

test('access starts off: no socket, the CLI exits 4 and says what to do', async () => {
  expect(existsSync(socket)).toBe(false);
  expect(existsSync(join(userData, 'agent-endpoint.json'))).toBe(false);
  const out = await cli(['llm', 'envs']);
  expect(out.code).toBe(4);
  expect(out.json.error).toBe('Ask the user to open Cais and turn on agent access.');
  // the output closed early: still exit 4, and no stack trace
  const closed = await cli(['llm', 'envs'], {}, { closeStdout: true });
  expect([closed.code, closed.stderr]).toEqual([4, '']);
  await expect(page.getByTestId('agents-status')).toHaveCount(0);
});

test('turning access on in the panel opens the socket and shows "Agents on"', async () => {
  await page.getByTestId('agents-entry').click();
  const panel = modal('Agentes');
  await expect(panel).toContainText('O que um agente roda sem pedir depende do ambiente');
  await expect(panel.getByTestId('agent-level-row')).toHaveText([/api · dev\s*Leitura liberada, escrita com aprovação/, /api · pro\s*Produção\s*Tudo com aprovação/]);
  await expect(panel.getByTestId('agent-switch')).toHaveAttribute('aria-checked', 'false');
  await panel.getByTestId('agent-switch').click();
  await expect(panel.getByTestId('agent-switch')).toHaveAttribute('aria-checked', 'true');
  expect(existsSync(socket)).toBe(true);
  await panel.getByRole('button', { name: 'Fechar' }).click();
  await page.getByTestId('env-dev').click();
  await expect(page.getByTestId('agents-status')).toContainText('Agentes ligado');
});

test('envs lists projects and environments with no host, user or password', async () => {
  const out = await cli(['llm', 'envs']);
  expect(out.code).toBe(0);
  expect(out.json.environments.map((e: { slug: string }) => e.slug)).toEqual(['api/dev', 'api/pro']);
  expect(out.json.environments[1]).toMatchObject({ production: true, engine: 'mysql', agent_access: 'approve-all', default_database: testDb().database });
  expect(out.json.environments[0]).toMatchObject({ production: false, agent_access: 'free-reads' });
  const db = testDb();
  for (const secret of [db.host, db.password, `"${db.user}"`, 'c-test', String(db.port)]) expect(out.stdout).not.toContain(secret);
  expect((await cli(['llm', 'schema', 'api/pro', '--table', 'agent_items'])).json.databases[0].tables[0].columns).toHaveLength(3);
});

test('a reader that closes the output early (| head) is not an error: same exit code, nothing on stderr', async () => {
  for (const args of [['llm', 'guide'], ['llm', 'skill'], ['llm', 'envs'], ['llm', 'schema', 'api/pro'], ['llm', 'requests']]) {
    const out = await cli(args, {}, { closeStdout: true });
    expect([args.join(' '), out.code, out.stderr]).toEqual([args.join(' '), 0, '']);
  }
  // a usage error keeps its own code too
  const usage = await cli(['llm', 'query', 'api/dev'], {}, { closeStdout: true });
  expect([usage.code, usage.stderr]).toEqual([2, '']);
});

test('cais llm skill prints the shipped skill with the app unreachable: exit 0, nothing on stderr, no socket used', async () => {
  const out = await cli(['llm', 'skill'], { CAIS_SOCKET: join(shortTempDir('cais-noskt-'), 'missing.sock') });
  expect([out.code, out.stderr]).toEqual([0, '']);
  expect(out.stdout).toBe(readFileSync(join(root, 'skills', 'cais', 'SKILL.md'), 'utf8'));
});

test('a read outside production runs at once, with no modal', async () => {
  const out = await cli(['llm', 'query', 'api/dev', '--sql', 'SELECT id, status FROM agent_items ORDER BY id', '--client', 'Claude Code']);
  expect(out.code).toBe(0);
  expect(out.json.status).toBe('succeeded');
  expect(out.json.decided_by).toBe('policy');
  expect(out.json.auto_commit).toBeUndefined();
  expect(out.json.results[0].rows).toHaveLength(3);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('policy refusals exit 2: write without --write, DDL, missing reason in production', async () => {
  expect((await cli(['llm', 'query', 'api/dev', '--sql', "UPDATE agent_items SET status = 'x'"])).json.code).toBe('writes_in_read');
  const ddl = await cli(['llm', 'query', 'api/dev', '--write', '--reason', 'x', '--sql', 'DROP TABLE agent_items']);
  expect([ddl.code, ddl.json.code]).toEqual([2, 'ddl_or_transaction']);
  const noReason = await cli(['llm', 'query', 'api/pro', '--sql', 'SELECT 1']);
  expect([noReason.code, noReason.json.code]).toEqual([2, 'reason_required']);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a production read asks first; approving with 15 min lets the next read run with no modal', async () => {
  const run = cli(['llm', 'query', 'api/pro', '--sql', 'SELECT id, owner FROM agent_items ORDER BY id', '--reason', 'Conferir o incidente de hoje', '--wait', '--client', 'Claude Code']);
  const dialog = modal('Agente pede para ler');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Produção');
  await expect(dialog).toContainText('api · pro');
  await expect(dialog).toContainText('Claude Code');
  await expect(dialog).toContainText('Conferir o incidente de hoje');
  await expect(dialog.getByTestId('sqlview')).toContainText('SELECT id, owner FROM agent_items');
  await expect(dialog.getByLabel('O agente pode ver o resultado')).toBeChecked();
  await expect(dialog.getByLabel('Aprovar leituras em api · pro por 15 min')).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Recusar' })).toBeFocused();
  await dialog.getByLabel('Aprovar leituras em api · pro por 15 min').check();
  await expect(dialog.getByRole('button', { name: 'Aprovar', exact: true })).toBeEnabled(); // armed after a moment
  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'agent-read-approval-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'agent-read-approval-dark.png') });
  await setTheme(app, page, 'light');
  await dialog.getByRole('button', { name: 'Aprovar', exact: true }).click();
  const out = await run;
  expect(out.code).toBe(0);
  expect(out.json.status).toBe('succeeded');
  expect(out.json.results[0].rows[0]).toEqual([1, 'ana@exemplo.com']);
  expect(out.json.decided_by).toBe('person');

  // the grant covers the next read in pro: no reason, no modal (the person did not see it: decided_by policy)
  const again = await cli(['llm', 'query', 'api/pro', '--sql', 'SELECT COUNT(*) AS n FROM agent_items']);
  expect(again.code).toBe(0);
  expect(again.json.status).toBe('succeeded');
  expect(again.json.decided_by).toBe('policy');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // a write in pro still asks (no modal yet, because nothing is approved): it stays pending
  const write = await cli(['llm', 'query', 'api/pro', '--write', '--sql', "UPDATE agent_items SET status = 'x' WHERE id = 3", '--reason', 'teste']);
  expect([write.code, write.json.status]).toEqual([0, 'pending_approval']);
  await expect(modal('Agente pede para escrever')).toBeVisible();
  await modal('Agente pede para escrever').getByRole('button', { name: 'Recusar' }).click();
});

test('the panel lists the grant and recent requests; Revogar brings the questions back; screenshots', async () => {
  await page.getByTestId('agents-entry').click();
  const panel = modal('Agentes');
  await expect(panel.getByTestId('agent-grant')).toContainText('Leituras em api · pro');
  await expect(panel.getByTestId('agent-recent').first()).toBeVisible();
  await panel.getByTestId('agent-recent').first().click();
  await expect(panel.getByTestId('agent-detail')).toBeVisible();
  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'agents-panel-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'agents-panel-dark.png') });
  await setTheme(app, page, 'light');
  await panel.getByRole('button', { name: 'Revogar' }).click();
  await expect(panel.getByTestId('agent-grant')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Fechar' }).click();
  const out = await cli(['llm', 'query', 'api/pro', '--sql', 'SELECT 1']);
  expect(out.json.code).toBe('reason_required');
});

test('a write: approve, see the affected rows, Commit; the CLI gets committed', async () => {
  const run = cli(['llm', 'query', 'api/dev', '--write', '--sql', "UPDATE agent_items SET status = 'blocked' WHERE id IN (1, 2);", '--reason', 'Bloquear os 2 itens duplicados', '--wait', '--client', 'Claude Code']);
  const dialog = modal('Agente pede para escrever');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Roda em transação');
  await expect(dialog.getByLabel('Aprovar leituras em api · dev por 15 min')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Rodar em transação' })).toBeEnabled();
  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'agent-write-approval-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'agent-write-approval-dark.png') });
  await setTheme(app, page, 'light');
  await dialog.getByRole('button', { name: 'Rodar em transação' }).click();

  const commit = modal('Transação do agente aberta');
  await expect(commit).toBeVisible();
  await expect(commit.getByTestId('agent-summary')).toContainText('2 linhas afetadas');
  await expect(commit.getByTestId('agent-clock')).toContainText(/rollback em [01]:\d\d/);
  await expect(commit.getByRole('button', { name: 'Rollback' })).toBeFocused();
  // the second connection sees nothing yet
  expect((await dbRows("SELECT COUNT(*) AS n FROM agent_items WHERE status = 'blocked'"))[0]!.n).toBe(0);
  await expect(commit.getByRole('button', { name: 'Commit' })).toBeEnabled();
  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'agent-commit-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'agent-commit-dark.png') });
  await setTheme(app, page, 'light');
  await commit.getByRole('button', { name: 'Commit' }).click();

  const out = await run;
  expect(out.code).toBe(0);
  expect(out.json.status).toBe('committed');
  expect(out.json).toMatchObject({ decided_by: 'person', auto_commit: false });
  expect(out.json.results[0].affected_rows).toBe(2);
  expect((await dbRows("SELECT COUNT(*) AS n FROM agent_items WHERE status = 'blocked'"))[0]!.n).toBe(2);
  // requests carries the same fields
  const list = await cli(['llm', 'requests', '--limit', '1']);
  expect(list.json.requests[0]).toMatchObject({ request_id: out.json.request_id, status: 'committed', decided_by: 'person', auto_commit: false });
});

test('a write with many commands: each listed apart, blank lines and invisible marks visible, a MyISAM warning, and Rodar waits for the end of the list', async () => {
  const blank = '\n'.repeat(301);
  const sql = [
    `UPDATE agent_items SET status = 'x'${blank}WHERE id = 1;`,
    "INSERT INTO agent_legacy (note) VALUES ('um');",
    "SELECT 'ab' AS marca;",
    'SELECT 1 AS dois;',
    'SELECT 2 AS tres;',
    "UPDATE agent_items SET owner = 'z' WHERE id = 2;",
    'DELETE FROM agent_items WHERE id = 3;',
  ].join('\n');
  const run = cli(['llm', 'query', 'api/dev', '--write', '--sql', sql, '--reason', 'Several commands at once', '--wait']);
  const dialog = modal('Agente pede para escrever');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('stmt')).toHaveCount(7);
  await expect(dialog.getByTestId('stmt').first()).toContainText('#1');
  await expect(dialog.getByTestId('stmt').first()).toContainText('escrita');
  await expect(dialog.getByTestId('stmt').nth(2)).toContainText('leitura');
  await expect(dialog.getByTestId('stmt').first()).toContainText('⋯ 300 linhas em branco');
  await expect(dialog.getByRole('alert')).toContainText('A tabela agent_legacy não é transacional (MyISAM): o Rollback não desfaz o que for gravado nela.');
  // the list does not fit: the button stays off until the person has scrolled to the end
  const go = dialog.getByRole('button', { name: 'Rodar em transação' });
  await page.waitForTimeout(900); // past the 600 ms guard
  await expect(go).toBeDisabled();
  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'agent-write-approval-multi-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'agent-write-approval-multi-dark.png') });
  await setTheme(app, page, 'light');
  await dialog.getByTestId('stmt-list').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(go).toBeEnabled();
  await dialog.getByRole('button', { name: 'Recusar' }).click();
  expect((await run).code).toBe(3);
  expect((await dbRows("SELECT COUNT(*) AS n FROM agent_legacy"))[0]!.n).toBe(0);
  // direction and invisible characters never reach the modal: refused before anything else
  const hidden = await cli(['llm', 'query', 'api/dev', '--write', '--sql', "SELECT 'a\u202eb' AS marca", '--reason', 'x']);
  expect(hidden.code).toBe(2);
  expect(hidden.json).toMatchObject({ code: 'hidden_text' });
});

test('Reject sends the reason back with exit 3', async () => {
  const run = cli(['llm', 'query', 'api/dev', '--write', '--sql', "DELETE FROM agent_items", '--reason', 'limpar', '--wait']);
  const dialog = modal('Agente pede para escrever');
  await expect(dialog.getByRole('alert')).toContainText('DELETE sem WHERE');
  await dialog.getByLabel('Motivo da recusa (opcional)').fill('Use um WHERE por id e explique melhor');
  await dialog.getByRole('button', { name: 'Recusar' }).click();
  const out = await run;
  expect(out.code).toBe(3);
  expect(out.json).toMatchObject({ status: 'rejected', rejection_reason: 'Use um WHERE por id e explique melhor', decided_by: 'person' });
  expect((await dbRows('SELECT COUNT(*) AS n FROM agent_items'))[0]!.n).toBe(3);
});

test('Reject while the output is already closed: still exit 3, silently', async () => {
  const run = cli(['llm', 'query', 'api/dev', '--write', '--sql', "UPDATE agent_items SET owner = 'y' WHERE id = 3", '--reason', 'teste do pipe', '--wait'], {}, { closeStdout: true });
  const dialog = modal('Agente pede para escrever');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Recusar' }).click();
  await expect(dialog).toHaveCount(0);
  const out = await run;
  expect([out.code, out.stderr]).toEqual([3, '']);
  expect((await dbRows('SELECT owner FROM agent_items WHERE id = 3'))[0]!.owner).toBe('caio@exemplo.com');
});

test('Rollback in the second decision exits 3 and changes nothing', async () => {
  const run = cli(['llm', 'query', 'api/dev', '--write', '--sql', "UPDATE agent_items SET owner = 'x' WHERE id = 3", '--reason', 'teste', '--wait']);
  await modal('Agente pede para escrever').getByRole('button', { name: 'Rodar em transação' }).click();
  await modal('Transação do agente aberta').getByRole('button', { name: 'Rollback' }).click();
  const out = await run;
  expect(out.code).toBe(3);
  expect(out.json).toMatchObject({ status: 'rolled_back', rollback_reason: 'user', decided_by: 'person' });
  expect((await dbRows("SELECT owner FROM agent_items WHERE id = 3"))[0]!.owner).toBe('caio@exemplo.com');
});

test('"The agent can see the result" unchecked: only counts come back', async () => {
  const run = cli(['llm', 'query', 'api/pro', '--sql', 'SELECT owner FROM agent_items', '--reason', 'conferir', '--wait']);
  const dialog = modal('Agente pede para ler');
  await dialog.getByLabel('O agente pode ver o resultado').uncheck();
  await dialog.getByRole('button', { name: 'Aprovar', exact: true }).click();
  const out = await run;
  expect(out.code).toBe(0);
  expect(out.json.result_withheld).toBe(true);
  expect(out.json.results[0].row_count).toBe(3);
  expect(out.stdout).not.toContain('exemplo.com');
});

test('Esc leaves the request pending; Review in the panel brings it back; "N more in the queue"', async () => {
  const first = await cli(['llm', 'query', 'api/pro', '--sql', 'SELECT 1', '--reason', 'primeiro']);
  const second = await cli(['llm', 'query', 'api/pro', '--sql', 'SELECT 2', '--reason', 'segundo']);
  expect([first.code, first.json.status, second.json.status]).toEqual([0, 'pending_approval', 'pending_approval']);
  const dialog = modal('Agente pede para ler');
  await expect(dialog.getByTestId('agent-queue')).toHaveText('mais 1 na fila');
  await expect(dialog).toContainText('primeiro');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog').first()).toContainText('segundo'); // the next one in line
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await cli(['llm', 'status', first.json.request_id])).json.status).toBe('pending_approval');
  await expect(page.getByTestId('agents-status')).toContainText('2 pedidos');
  await page.getByTestId('agents-entry').click();
  await expect(modal('Agentes').getByTestId('agent-pending')).toHaveCount(2);
  await modal('Agentes').getByTestId('agent-pending').first().getByRole('button', { name: 'Revisar' }).click();
  await expect(modal('Agente pede para ler')).toContainText('primeiro');
  await modal('Agente pede para ler').getByRole('button', { name: 'Recusar' }).click();
  expect((await cli(['llm', 'status', first.json.request_id])).code).toBe(3);
  await expect(page.getByRole('dialog')).toHaveCount(0); // the second one was closed with Esc too: it waits in the panel
  await page.getByTestId('agents-entry').click();
  await modal('Agentes').getByRole('button', { name: 'Revisar' }).click();
  await expect(modal('Agente pede para ler')).toContainText('segundo');
  await modal('Agente pede para ler').getByRole('button', { name: 'Recusar' }).click();
  expect((await cli(['llm', 'requests', '--limit', '3'])).json.requests).toHaveLength(3);
});

test('wait times out with exit 5 and the request stays valid', async () => {
  const first = await cli(['llm', 'query', 'api/pro', '--sql', 'SELECT 3', '--reason', 'esperar']);
  await page.keyboard.press('Escape');
  const waited = await cli(['llm', 'status', first.json.request_id, '--wait', '--timeout', '2']);
  expect(waited.code).toBe(5);
  expect(waited.json).toMatchObject({ status: 'pending_approval', timed_out: true });
  expect((await cli(['llm', 'status', first.json.request_id])).json.status).toBe('pending_approval');
  await page.getByTestId('agents-entry').click();
  await modal('Agentes').getByRole('button', { name: 'Revisar' }).click();
  await modal('Agente pede para ler').getByRole('button', { name: 'Recusar' }).click();
});

test('agents create scripts (marked "agent") but cannot edit or delete them', async () => {
  const saved = await cli(['llm', 'script-save', '--project', 'api', '--name', 'Duplicados por documento', '--sql', 'SELECT national_id, COUNT(*) FROM companies GROUP BY 1', '--database', testDb().database]);
  expect(saved.code).toBe(0);
  expect(saved.json).toMatchObject({ name: 'Duplicados por documento', created_by: 'agent' });
  expect((await cli(['llm', 'script-save', '--project', 'api', '--name', 'duplicados por documento', '--sql', 'SELECT 2'])).code).toBe(2);
  expect((await cli(['llm', 'scripts', '--project', 'api'])).json.scripts).toHaveLength(1);
  expect((await cli(['llm', 'script', saved.json.id])).json.sql).toContain('GROUP BY');
  expect((await cli(['llm', 'script-delete', saved.json.id])).code).toBe(2);
  await page.getByTestId('env-dev').getByRole('button', { name: /Expandir bancos|Recolher bancos/ }).first().waitFor();
  const group = page.getByTestId('scripts-dev');
  if (!(await group.isVisible())) await page.getByTestId('env-dev').getByRole('button', { name: 'Expandir bancos' }).click();
  await expect(page.getByTestId('scripts-count-dev')).toHaveText('1');
});

test('"Reads and writes allowed" in dev: with an alert the write waits for the person; without, it commits by itself; the Trail panel shows it', async () => {
  await page.getByTestId('env-dev').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Editar' }).click();
  const registry = page.getByRole('dialog', { name: 'Cadastro' });
  const level = registry.getByLabel('Acesso de agentes');
  await expect(level).toHaveValue('free-reads');
  await level.selectOption('free-reads-writes');
  await expect(registry.getByTestId('env-agent-hint')).toContainText('faz commit sozinha');
  await registry.getByRole('button', { name: 'Salvar' }).click();
  await expect(registry.getByText('Salvo')).toBeVisible();
  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'registry-agent-level-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'registry-agent-level-dark.png') });
  await setTheme(app, page, 'light');
  // production: starts on "Everything needs approval", may free reads, never writes
  await registry.getByRole('tab', { name: 'Ambientes' }).click();
  await registry.getByRole('button', { name: 'pro', exact: true }).click();
  const proLevel = registry.getByLabel('Acesso de agentes');
  await expect(proLevel).toHaveValue('approve-all');
  await expect(proLevel.locator('option')).toHaveText(['Tudo com aprovação', 'Leitura liberada, escrita com aprovação']);
  await proLevel.selectOption('free-reads');
  await expect(registry.getByTestId('env-agent-hint')).toContainText('inclusive dados de produção');
  await registry.getByRole('button', { name: 'Salvar' }).click();
  await expect(registry.getByText('leitura livre')).toBeVisible();
  await registry.getByRole('button', { name: 'Fechar' }).click();
  // reads in pro now run without the person; a write in pro still asks
  const proRead = await cli(['llm', 'query', 'api/pro', '--sql', 'SELECT COUNT(*) AS n FROM agent_items']);
  expect([proRead.code, proRead.json.status]).toEqual([0, 'succeeded']);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const proWrite = await cli(['llm', 'query', 'api/pro', '--write', '--sql', "UPDATE agent_items SET status = 'x' WHERE id = 3", '--reason', 'teste']);
  expect([proWrite.code, proWrite.json.status]).toEqual([0, 'pending_approval']);
  await modal('Agente pede para escrever').getByRole('button', { name: 'Recusar' }).click();
  // back to "Everything needs approval" for the tests that follow
  await page.getByTestId('env-pro').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Editar' }).click();
  await registry.getByLabel('Acesso de agentes').selectOption('approve-all');
  await registry.getByRole('button', { name: 'Salvar' }).click();
  await expect(registry.getByText('leitura livre')).toHaveCount(0);
  await registry.getByRole('button', { name: 'Fechar' }).click();

  // an alert (no WHERE): the write waits, saying why
  const waiting = cli(['llm', 'query', 'api/dev', '--write', '--sql', "UPDATE agent_items SET status = 'auto'", '--reason', 'level test', '--wait', '--client', 'Claude Code']);
  const dialog = modal('Agente pede para escrever');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('agent-approval-reason')).toContainText('libera escrita, mas o pedido tem alerta');
  await dialog.getByRole('button', { name: 'Recusar' }).click();
  expect((await waiting).code).toBe(3);

  // the test account has no PROCESS: an UPDATE cannot rule out a hidden cascading foreign key and waits
  const upd = await cli(['llm', 'query', 'api/dev', '--write', '--sql', "UPDATE agent_items SET status = 'auto' WHERE id = 3", '--reason', 'level test', '--client', 'Claude Code']);
  expect(upd.json.approval_reason).toContain('cannot see every foreign key');
  await modal('Agente pede para escrever').getByRole('button', { name: 'Recusar' }).click();
  // a plain INSERT never cascades: it commits by itself
  const out = await cli(['llm', 'query', 'api/dev', '--write', '--sql', "INSERT INTO agent_items VALUES (4, 'auto', 'teste')", '--reason', 'level test', '--client', 'Claude Code']);
  expect(out.json.approval_reason).toBeUndefined();
  expect(out.code).toBe(0);
  expect(out.json).toMatchObject({ status: 'committed', auto_commit: true, decided_by: 'policy' });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await dbRows('SELECT status FROM agent_items WHERE id = 4'))[0]!.status).toBe('auto');

  await page.getByTestId('trail-entry').click();
  const trail = modal('Trilha');
  await expect(trail.getByTestId('trail-row').first()).toContainText('commit feito (automático)');
  await expect(trail.getByTestId('trail-verified')).toContainText('encadeada');
  await expect(trail.getByTestId('trail-tampered')).toHaveCount(0);
  await trail.getByTestId('trail-row').first().click();
  await expect(trail.getByTestId('trail-detail')).toContainText('automático (nível do ambiente)');
  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'trail-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'trail-dark.png') });
  await setTheme(app, page, 'light');
  await trail.getByTestId('trail-actor').selectOption('person');
  const personRows = trail.getByTestId('trail-row');
  // newest first: pro back to approve-all, pro to free reads, then dev to free writes
  await expect(personRows.nth(0)).toContainText('api · pro');
  await expect(personRows.nth(0)).toContainText('acesso de agentes: Leitura liberada, escrita com aprovação → Tudo com aprovação');
  await expect(personRows.nth(1)).toContainText('acesso de agentes: Tudo com aprovação → Leitura liberada, escrita com aprovação');
  await expect(personRows.nth(2)).toContainText('acesso de agentes: Leitura liberada, escrita com aprovação → Leitura e escrita liberadas');
  await trail.getByTestId('trail-actor').selectOption('');
  await trail.getByTestId('trail-search').fill('level test');
  await expect(trail.getByTestId('trail-row')).toHaveCount(3); // the two refused ones and the automatic one
  await trail.getByRole('button', { name: 'Fechar' }).click();
});

test('the trail has the requests and never the data', async () => {
  const trailDir = join(userData, 'trail');
  const text = readdirSync(trailDir).map((f) => readFileSync(join(trailDir, f), 'utf8')).join('');
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.length).toBeGreaterThan(8);
  expect(lines.find((l) => l.state === 'committed' && l.decidedBy === 'user')).toMatchObject({ actor: 'agent', mode: 'write', environment: 'api/dev', reason: 'Bloquear os 2 itens duplicados', client: 'Claude Code', secondDecidedBy: 'user' });
  expect(lines.some((l) => l.state === 'rejected')).toBe(true);
  expect(lines.some((l) => l.state === 'refused')).toBe(true);
  expect(lines.every((l) => /^[0-9a-f]{64}$/.test(l.mac))).toBe(true);
  expect(text).not.toContain('exemplo.com'.replace('exemplo.com', 'ana@exemplo.com'));
  expect(text).not.toContain(testDb().password);
});

test('turning access off closes the socket at once, expires what was waiting and the CLI exits 4', async () => {
  const waiting = await cli(['llm', 'query', 'api/pro', '--sql', 'SELECT 9', '--reason', 'vai expirar']);
  expect(waiting.json.status).toBe('pending_approval');
  await page.keyboard.press('Escape');
  await page.getByTestId('agents-entry').click();
  await modal('Agentes').getByTestId('agent-switch').click();
  await expect(modal('Agentes').getByTestId('agent-switch')).toHaveAttribute('aria-checked', 'false');
  await expect(modal('Agentes').getByTestId('agent-pending')).toHaveCount(0);
  expect(existsSync(socket)).toBe(false);
  expect(existsSync(join(userData, 'agent-endpoint.json'))).toBe(false);
  expect((await cli(['llm', 'envs'])).code).toBe(4);
  expect((await cli(['llm', 'status', waiting.json.request_id])).code).toBe(4);
  await modal('Agentes').getByRole('button', { name: 'Fechar' }).click();
  await expect(page.getByTestId('agents-status')).toHaveCount(0);
});

test('the saved switch comes back on at the next launch; quitting removes the socket', async () => {
  await page.getByTestId('agents-entry').click();
  await modal('Agentes').getByTestId('agent-switch').click();
  await expect(modal('Agentes').getByTestId('agent-switch')).toHaveAttribute('aria-checked', 'true');
  await app.close();
  expect(existsSync(socket)).toBe(false);
  ({ app, page } = await launch(userData, { CAIS_SOCKET: socket }));
  await expect(page.getByTestId('env-dev')).toBeVisible();
  await expect.poll(() => existsSync(socket)).toBe(true);
  expect((await cli(['llm', 'envs'])).code).toBe(0);
  await expect(page.getByTestId('env-dev')).toBeVisible();
  void execFile;
  void setSql;
});

test('an environment edited outside the Cais opens blocked, production, with a notice; saving it in the registry unblocks it', async () => {
  await app.close();
  const path = join(userData, 'catalog.json');
  const catalog = JSON.parse(readFileSync(path, 'utf8'));
  const pro = catalog.environments.find((e: { name: string }) => e.name === 'pro');
  pro.production = false;
  pro.agentLevel = 'free-reads-writes';
  writeFileSync(path, JSON.stringify(catalog));
  ({ app, page } = await launch(userData, { CAIS_SOCKET: socket }));
  await expect(page.getByTestId('startup-notice').filter({ hasText: 'alterado fora do Cais (api · pro)' })).toBeVisible();
  // agents cannot reach it, and the level came back to approve-all
  await expect.poll(() => existsSync(socket)).toBe(true);
  const envs = await cli(['llm', 'envs']);
  expect(envs.json.environments.find((e: { slug: string }) => e.slug === 'api/pro')).toMatchObject({ production: true, agent_access: 'approve-all' });
  const read = await cli(['llm', 'schema', 'api/pro']);
  expect(read.code).not.toBe(0);
  // the registry says why and saving unblocks
  await page.getByTestId('env-pro').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Editar' }).click();
  const registry = page.getByRole('dialog', { name: 'Cadastro' });
  await expect(registry.getByTestId('env-blocked')).toBeVisible();
  await expect(registry.getByLabel('Produção')).toBeChecked();
  await registry.getByRole('button', { name: 'Salvar' }).click();
  await expect(registry.getByText('Salvo')).toBeVisible();
  await expect(registry.getByTestId('env-blocked')).toHaveCount(0);
  await registry.getByRole('button', { name: 'Fechar' }).click();
  expect((await cli(['llm', 'schema', 'api/pro'])).code).toBe(0);
});
