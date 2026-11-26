import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { FakeBigquery } from '../support/bigquery-fake';
import { launch, seedUserData, setSql as typeSql, setTheme, shortTempDir, shots } from './helpers';

// A BigQuery environment end to end: registry (engine, project, byte limit, Google IAM credential), tree with
// columns read when a dataset opens, query with bytes in the footer, refusal of DML, confirmation above the byte
// limit and the trail. Against the local fake server only: the app runs with the e2e token and never calls gcloud.

const GIB = 1024 ** 3;
const E2E_TOKEN = 'cais-test-access-token';

let userData: string;
let app: ElectronApplication;
let page: Page;
const fake = new FakeBigquery();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await fake.start();
  fake.validTokens = new Set([E2E_TOKEN]);
  fake.addDataset('vendas', {
    pedidos: {
      schema: [
        { name: 'id', type: 'INTEGER', mode: 'REQUIRED' },
        { name: 'valor', type: 'NUMERIC' },
        { name: 'cliente', type: 'RECORD', fields: [{ name: 'nome', type: 'STRING' }, { name: 'uf', type: 'STRING' }] },
        { name: 'tags', type: 'STRING', mode: 'REPEATED' },
      ],
    },
    eventos: { schema: [{ name: 'id', type: 'INTEGER' }, { name: 'tipo', type: 'STRING' }] },
    muitos: { schema: [{ name: 'n', type: 'INTEGER' }] },
    resumo: { type: 'VIEW', schema: [{ name: 'total', type: 'NUMERIC' }] },
    totais_mv: { type: 'MATERIALIZED_VIEW', schema: [{ name: 'total', type: 'NUMERIC' }] },
    parquet_externa: { type: 'EXTERNAL', schema: [{ name: 'linha', type: 'STRING' }] },
    pedidos_snap: { type: 'SNAPSHOT', schema: [{ name: 'id', type: 'INTEGER' }] },
  });
  fake.addDataset('logs', { acessos: { schema: [{ name: 'ip', type: 'STRING' }] } });
  // what a statement reads: eventos is large (3 GiB), everything else is small
  fake.bytesFor = (sql) => (/\beventos\b/.test(sql) ? 3 * GIB : 10 * 1024 * 1024);
  fake.resultFor = (sql) => {
    if (/\bmuitos\b/.test(sql)) {
      return { schema: [{ name: 'n', type: 'INTEGER' }], rows: Array.from({ length: 1200 }, (_, i) => [String(i + 1)]) };
    }
    if (/\beventos\b/.test(sql)) return { schema: [{ name: 'id', type: 'INTEGER' }, { name: 'tipo', type: 'STRING' }], rows: [['1', 'clique'], ['2', 'compra']] };
    return {
      schema: [{ name: 'id', type: 'INTEGER' }, { name: 'valor', type: 'NUMERIC' }],
      rows: [['1', '10.50'], ['2', '99.90'], ['3', '5']],
    };
  };

  userData = shortTempDir('cais-bq-');
  seedUserData(userData);
  ({ app, page } = await launch(userData, { CAIS_BIGQUERY_URL: fake.url }));
});
test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await fake.stop();
  rmSync(userData, { recursive: true, force: true });
});

const dialog = (name: string) => page.getByRole('dialog', { name });
const registry = () => dialog('Cadastro');
const chip = () => page.getByTestId('conn-chip');

/** Sets the editor text; the completion popup the typing opens is closed, so it never sits over a screenshot. */
async function setSql(page: Page, sql: string): Promise<void> {
  await typeSql(page, sql);
  await page.keyboard.press('Escape');
}

async function runCurrent(): Promise<void> {
  await page.getByTestId('run').click();
}

test('a Google IAM credential and a BigQuery environment are registered in the form', async () => {
  // credential: Google IAM only (the accounts list is the e2e hook's fixed one, never gcloud)
  await page.getByRole('button', { name: 'Credenciais' }).click();
  const form = registry();
  await form.getByRole('button', { name: 'Nova credencial' }).click();
  await form.getByLabel('Nome', { exact: true }).fill('conta google');
  await form.getByRole('radio', { name: 'Google IAM via gcloud' }).click();
  await form.getByLabel('Conta do gcloud').fill('ana@exemplo.com');
  await form.getByRole('button', { name: 'Salvar' }).click();
  await expect(form.getByText('Salvo')).toBeVisible();

  await form.getByRole('tab', { name: 'Ambientes' }).click();
  await form.getByRole('button', { name: 'Novo ambiente' }).click();
  await form.getByLabel('Nome do ambiente').fill('bq-dev');
  // the engine choice is for a new environment; MySQL is the start
  await expect(form.getByLabel('Host')).toBeVisible();
  await form.getByRole('radio', { name: 'BigQuery' }).click();
  await expect(form.getByLabel('Host')).toHaveCount(0);
  await expect(form.getByLabel('Porta')).toHaveCount(0);
  await expect(form.getByLabel('Limite de bytes por consulta (GiB)')).toHaveValue('100');
  await expect(form.getByLabel('Dataset padrão (opcional)')).toBeVisible();
  // only Google IAM credentials are offered, the password one is not
  const credential = form.getByLabel('Credencial');
  await expect(credential.locator('option', { hasText: 'conta google' })).toHaveCount(1);
  await expect(credential.locator('option', { hasText: 'usuário de teste' })).toHaveCount(0);

  // validation: project id and a whole number of GiB from 1
  await form.getByLabel('Projeto do Google Cloud').fill('Projeto Errado');
  await form.getByRole('button', { name: 'Salvar' }).click();
  await expect(form.getByRole('alert')).toContainText('id do projeto do Google Cloud');
  await form.getByLabel('Projeto do Google Cloud').fill('meu-projeto-123');
  await form.getByLabel('Limite de bytes por consulta (GiB)').fill('0');
  await form.getByRole('button', { name: 'Salvar' }).click();
  await expect(form.getByRole('alert')).toContainText('número inteiro de GiB a partir de 1');
  await form.getByLabel('Limite de bytes por consulta (GiB)').fill('1,5');
  await form.getByRole('button', { name: 'Salvar' }).click();
  await expect(form.getByRole('alert')).toContainText('número inteiro de GiB a partir de 1');
  await form.getByLabel('Limite de bytes por consulta (GiB)').fill('1');
  await form.getByLabel('Dataset padrão (opcional)').fill('vendas');

  // Testar conexão: token, datasets.list and a dry run, all against the fake server
  await form.getByRole('button', { name: 'Testar conexão' }).click();
  await expect(form.getByTestId('test-result')).toContainText('Conectado ao BigQuery');
  expect(fake.requests.every((r) => r.authorization === `Bearer ${E2E_TOKEN}`)).toBe(true);

  await form.getByRole('button', { name: 'Testar conexão' }).scrollIntoViewIfNeeded();
  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'bigquery-registry-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'bigquery-registry-dark.png') });
  await setTheme(app, page, 'light');

  await form.getByRole('button', { name: 'Salvar' }).click();
  await expect(form.getByText('Salvo')).toBeVisible();
  // the saved environment keeps its engine: no engine choice, the limit comes back in GiB, and it can be duplicated
  await expect(form.getByRole('radiogroup', { name: 'Motor do ambiente' })).toHaveCount(0);
  await expect(form.getByLabel('Limite de bytes por consulta (GiB)')).toHaveValue('1');
  await expect(form.getByRole('button', { name: 'Duplicar' })).toBeVisible();
  await form.getByRole('button', { name: 'Duplicar' }).click();
  await expect(form.getByLabel('Projeto do Google Cloud')).toHaveValue('meu-projeto-123');
  await expect(form.getByLabel('Limite de bytes por consulta (GiB)')).toHaveValue('1');
  await expect(form.getByLabel('Nome do ambiente')).toHaveValue('bq-dev (cópia)');
  await form.getByRole('button', { name: 'Fechar' }).click();
  await expect(registry()).toHaveCount(0);
});

test('the tab opens read-only with the dataset in the bar and the tree reads columns when a dataset opens', async () => {
  await page.getByTestId('env-bq-dev').click();
  await expect(chip()).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
  // the footer says BigQuery once, not "BigQuery BigQuery"
  await expect(page.getByTestId('statusbar')).toContainText('BigQuery');
  await expect(page.getByTestId('statusbar')).not.toContainText('BigQuery BigQuery');

  // the engine accepts one mode only: no picker, a fixed badge with the reason in the tooltip
  await expect(page.getByRole('radiogroup', { name: 'Modo da sessão' })).toHaveCount(0);
  await expect(page.getByRole('radio')).toHaveCount(0);
  const badge = page.getByTestId('mode-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('Somente leitura');
  await expect(badge).toHaveAttribute('aria-label', 'Modo da sessão: Somente leitura');
  await expect(badge).toHaveAttribute('title', 'BigQuery só lê nesta versão');
  // it is not a control: nothing to click or focus
  await expect(badge).not.toHaveAttribute('tabindex', /.*/);
  await expect(page.getByTestId('sessionbar').getByRole('button', { name: 'Somente leitura' })).toHaveCount(0);
  // the bar says dataset, not database
  const picker = page.getByLabel('Dataset atual');
  await expect(picker).toHaveValue('vendas');
  await expect(page.getByLabel('Banco atual')).toHaveCount(0);

  // datasets are listed with no columns read yet
  await expect(page.getByTestId('database-vendas')).toBeVisible();
  await expect(page.getByTestId('database-logs')).toBeVisible();
  const schemaReads = () => fake.requestsTo('/tables/', 'GET').length;
  expect(schemaReads()).toBe(0);
  await page.getByTestId('database-vendas').click();
  await expect(page.getByText('pedidos', { exact: true })).toBeVisible();
  await expect(page.getByTestId('subtype-totais_mv')).toHaveAttribute('title', 'view materializada');
  await expect(page.getByTestId('subtype-parquet_externa')).toHaveAttribute('title', 'tabela externa');
  await expect(page.getByTestId('subtype-pedidos_snap')).toHaveAttribute('title', 'snapshot');
  // one tables.get per table of that dataset, none for the other one
  await expect.poll(schemaReads).toBe(7);
  expect(fake.requestsTo('/datasets/logs/tables/', 'GET')).toHaveLength(0);
  // closing and opening the dataset again reads nothing: the columns are cached per dataset
  await page.getByTestId('database-vendas').click();
  await page.getByTestId('database-vendas').click();
  await expect(page.getByText('pedidos', { exact: true })).toBeVisible();
  await new Promise((r) => setTimeout(r, 300));
  expect(schemaReads()).toBe(7);

  const pedidos = page.locator('.tree-row', { hasText: /^pedidos$/ });
  await pedidos.getByRole('button', { name: 'Expandir colunas' }).click();
  await expect(page.locator('.tree-row', { hasText: 'cliente' })).toContainText('STRUCT<nome STRING, uf STRING>');
  await expect(page.locator('.tree-row', { hasText: /^tags/ })).toContainText('ARRAY<STRING>');

  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'bigquery-tree-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'bigquery-tree-dark.png') });
  await setTheme(app, page, 'light');
});

test('the editor completes dataset.table and the columns from the tree it has', async () => {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM vendas.');
  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup).toContainText('pedidos');
  await expect(popup).toContainText('eventos');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT vendas.pedidos.');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('valor');
  await page.keyboard.press('Escape');
});

test('a query shows rows, bytes processed and billed in the footer, and the grid does not edit', async () => {
  await setSql(page, 'SELECT id, valor FROM vendas.pedidos');
  await runCurrent();
  const grid = page.getByTestId('result-grid');
  await expect(grid).toContainText('99.90');
  await expect(page.getByTestId('result-summary')).toContainText('3 linhas');
  await expect(page.getByTestId('result-bytes')).toContainText('10 MiB processados');
  await expect(page.getByTestId('result-bytes')).toContainText('10 MiB faturados');
  // the engine does not edit in the grid: a double click opens no editor
  await grid.getByText('99.90').dblclick();
  await expect(page.getByTestId('cell-editor')).toHaveCount(0);

  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'bigquery-results-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'bigquery-results-dark.png') });
  await setTheme(app, page, 'light');
});

test('DML is refused by the app before anything reaches the server', async () => {
  const before = fake.requests.length;
  await setSql(page, 'DELETE FROM vendas.pedidos WHERE id = 1');
  await runCurrent();
  await expect(page.locator('.error-card')).toContainText('Somente leitura');
  expect(fake.requests.length).toBe(before);
  expect(fake.realQueries.some((q) => /DELETE/i.test(String(q.body?.query)))).toBe(false);
});

test('a read above the byte limit asks first, Cancelar leaves nothing run, and confirming runs with the ceiling raised', async () => {
  const realBefore = fake.realQueries.length;
  await setSql(page, 'SELECT * FROM vendas.eventos');
  await runCurrent();
  const ask = dialog('Consulta acima do limite de bytes');
  await expect(ask).toBeVisible();
  await expect(ask.getByTestId('bytes-item')).toHaveCount(1);
  await expect(ask.getByTestId('bytes-item')).toContainText('estimativa 3 GiB');
  await expect(ask.getByTestId('bytes-item')).toContainText('SELECT * FROM vendas.eventos');
  await expect(ask).toContainText('O limite do ambiente é 1 GiB');
  await expect(ask).toContainText('sobe para 3 GiB');
  // Cancelar has the focus: Enter never confirms by accident
  await expect(ask.getByTestId('bytes-cancel')).toBeFocused();
  // behind the question the tab is connected and idle, not "Executando…"
  await expect(chip()).toHaveAttribute('data-status', 'connected');

  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'bigquery-confirm-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'bigquery-confirm-dark.png') });
  await setTheme(app, page, 'light');

  await ask.getByTestId('bytes-cancel').click();
  await expect(ask).toHaveCount(0);
  expect(fake.realQueries.length).toBe(realBefore);

  await runCurrent();
  await expect(ask).toBeVisible();
  await ask.getByTestId('bytes-confirm').click();
  await expect(page.getByTestId('result-grid')).toContainText('compra');
  expect(fake.realQueries.length).toBe(realBefore + 1);
  expect(Number(fake.realQueries.at(-1)!.body.maximumBytesBilled)).toBe(3 * GIB);
  await expect(page.getByTestId('result-bytes')).toContainText('3 GiB processados');
});

test('Rodar todos lists every statement above the limit together', async () => {
  const realBefore = fake.realQueries.length;
  await setSql(page, 'SELECT 1 FROM vendas.pedidos;\nSELECT * FROM vendas.eventos;\nSELECT 2 FROM vendas.eventos;');
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  const ask = dialog('Consulta acima do limite de bytes');
  await expect(ask).toBeVisible();
  await expect(ask.getByTestId('bytes-item')).toHaveCount(2);
  await ask.getByTestId('bytes-cancel').click();
  expect(fake.realQueries.length).toBe(realBefore);
});

test('Estimar ao digitar: off by default; on, the statement under the cursor is dry-run after a pause, never run, and an error is marked in the editor', async () => {
  const sw = page.getByRole('switch', { name: 'Estimar ao digitar' });
  const estimate = page.getByTestId('estimate');
  const settingsFile = join(userData, 'settings.json');
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // off: typing sends nothing, whatever is typed
  await expect(sw).toBeVisible();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(sw).toHaveAttribute('title', /O texto dela vai ao Google a cada vez/);
  const dryBefore = fake.dryRuns.length;
  await setSql(page, 'SELECT * FROM vendas.pedidos');
  await wait(1500);
  expect(fake.dryRuns.length).toBe(dryBefore);
  await expect(estimate).toHaveCount(0);

  // on: kept in settings.json; the statement already in the editor is estimated at once
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  expect(JSON.parse(readFileSync(settingsFile, 'utf8')).estimateAsYouType).toBe(true);
  await expect(estimate).toHaveText('Vai processar 10 MiB');
  await expect(estimate).toHaveAttribute('data-state', 'ok');
  expect(fake.dryRuns.length).toBe(dryBefore + 1);

  // a pause after typing sends the new text; over the limit of the environment the bar says it will ask first
  const realBefore = fake.realQueries.length;
  const tablesBefore = fake.requestsTo('/tables/', 'GET').length;
  await setSql(page, 'SELECT * FROM vendas.eventos');
  await expect(estimate).toContainText('Vai processar 3 GiB, acima do limite de 1 GiB');
  await expect(estimate).toHaveAttribute('data-state', 'over');
  // texts asked before are answered from memory: going back and forth sends nothing new
  const dryAfterEventos = fake.dryRuns.length;
  await setSql(page, 'SELECT * FROM vendas.pedidos');
  await expect(estimate).toHaveText('Vai processar 10 MiB');
  await setSql(page, 'SELECT * FROM vendas.eventos');
  await expect(estimate).toContainText('3 GiB');
  await wait(1200);
  expect(fake.dryRuns.length).toBe(dryAfterEventos);
  // the text that was dry-run is the statement, with the dataset of the tab as default
  expect(fake.dryRuns.at(-1)!.body?.configuration?.query?.query).toBe('SELECT * FROM vendas.eventos');
  expect(fake.dryRuns.at(-1)!.body?.configuration?.query?.defaultDataset?.datasetId).toBe('vendas');

  // a fault of the text: the server's error is the editor's diagnostic, at the word it points to
  fake.dryRunError = (sql) =>
    /\bvalr\b/.test(sql) ? { status: 400, reason: 'invalidQuery', message: 'Unrecognized name: valr at [1:8]' } : undefined;
  try {
    await setSql(page, 'SELECT valr FROM vendas.pedidos');
    await expect(estimate).toHaveText('A consulta tem erro');
    await expect(estimate).toHaveAttribute('data-state', 'error');
    const mark = page.locator('.cm-lintRange-error');
    await expect(mark).toHaveCount(1);
    await expect(mark).toHaveText('valr');
    await mark.hover();
    await expect(page.locator('.cm-tooltip-lint')).toContainText('Unrecognized name: valr');
    await setTheme(app, page, 'light');
    await page.screenshot({ path: join(shots, 'bigquery-estimate-error-light.png') });
    await setTheme(app, page, 'dark');
    await page.screenshot({ path: join(shots, 'bigquery-estimate-error-dark.png') });
    await setTheme(app, page, 'light');
    // fixed: the mark goes away with the next answer
    await setSql(page, 'SELECT id FROM vendas.pedidos');
    await expect(estimate).toHaveText('Vai processar 10 MiB');
    await expect(page.locator('.cm-lintRange-error')).toHaveCount(0);
  } finally {
    fake.dryRunError = () => undefined;
  }

  // what the app refuses is refused here, and nothing is sent
  const dryRefused = fake.dryRuns.length;
  const requestsRefused = fake.requests.length;
  await setSql(page, 'DELETE FROM vendas.pedidos WHERE id = 1');
  await expect(estimate).toHaveAttribute('data-state', 'refused');
  await expect(estimate).toContainText('Não estimado');
  await wait(300);
  expect(fake.dryRuns.length).toBe(dryRefused);
  expect(fake.requests.length).toBe(requestsRefused);

  // nothing ran, nothing was billed, and no line went to the trail (the dry run is not a command)
  expect(fake.realQueries.length).toBe(realBefore);
  expect(fake.requestsTo('/tables/', 'GET').length).toBe(tablesBefore);
  await page.getByTestId('trail-entry').click();
  const trail = dialog('Trilha');
  await trail.getByTestId('trail-search').fill('vendas.pedidos WHERE id = 1');
  await expect(trail.getByTestId('trail-row')).toHaveCount(0);
  await trail.getByRole('button', { name: 'Fechar' }).click();

  // off again: the readout and the marks go, and typing sends nothing
  await setSql(page, 'SELECT valr FROM vendas.pedidos');
  fake.dryRunError = () => ({ status: 400, reason: 'invalidQuery', message: 'Unrecognized name: valr at [1:8]' });
  try {
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).estimateAsYouType).toBe(false);
    await expect(estimate).toHaveCount(0);
    await expect(page.locator('.cm-lintRange-error')).toHaveCount(0);
    const dryOff = fake.dryRuns.length;
    await setSql(page, 'SELECT valr, id FROM vendas.pedidos');
    await wait(1500);
    expect(fake.dryRuns.length).toBe(dryOff);
    await expect(page.locator('.cm-lintRange-error')).toHaveCount(0);
  } finally {
    fake.dryRunError = () => undefined;
  }
});

test('a double click on a table runs its preview through the same confirmation', async () => {
  await page.locator('.tree-row', { hasText: /^eventos$/ }).dblclick();
  const ask = dialog('Consulta acima do limite de bytes');
  await expect(ask).toBeVisible();
  await expect(ask.getByTestId('bytes-item')).toContainText('SELECT * FROM `vendas`.`eventos` LIMIT 100');
  await ask.getByTestId('bytes-cancel').click();
});

test('Buscar até 50.000 reads more pages of the same job: no new dry run, no new query', async () => {
  await page.getByTestId('tab').first().click();
  await setSql(page, 'SELECT n FROM vendas.muitos');
  await runCurrent();
  await expect(page.getByTestId('truncated')).toBeVisible();
  await expect(page.getByTestId('result-summary')).toContainText('1.000 linhas');
  const dry = fake.dryRuns.length;
  const real = fake.realQueries.length;
  await page.getByRole('button', { name: 'Buscar até 50.000' }).click();
  await expect(page.getByTestId('result-summary')).toContainText('1.200 linhas');
  await expect(page.getByTestId('truncated')).toHaveCount(0);
  expect(fake.dryRuns.length).toBe(dry);
  expect(fake.realQueries.length).toBe(real);
});

test('the trail has the job id and the bytes of the person lines', async () => {
  await page.getByTestId('trail-entry').click();
  const trail = dialog('Trilha');
  await expect(trail.getByTestId('trail-row').first()).toBeVisible();
  await trail.getByTestId('trail-search').fill('muitos');
  // the "Buscar até 50.000" line of the same query points at the job and carries no bytes: it was billed once
  const row = trail.getByTestId('trail-row').filter({ hasText: '10 MiB faturados' }).first();
  await expect(row).toBeVisible();
  await expect(trail.getByTestId('trail-row').first()).not.toContainText('MiB');
  await row.click();
  const detail = trail.getByTestId('trail-detail');
  await expect(detail).toContainText('Job');
  await expect(detail).toContainText('job_');
  await expect(detail).toContainText('Bytes estimados');
  await expect(detail).toContainText('Bytes faturados');
  await expect(detail).toContainText('Dataset');
  // the confirmation above the limit is on its line (the text search reads the detail too)
  await trail.getByTestId('trail-search').fill('Acima do limite de 1 GiB');
  await expect(trail.getByTestId('trail-row')).toHaveCount(1);
  await trail.getByTestId('trail-row').click();
  await expect(trail.getByTestId('trail-detail')).toContainText('estimativa de 3 GiB');
  await expect(trail.getByTestId('trail-detail')).toContainText('SELECT * FROM vendas.eventos');

  await setTheme(app, page, 'light');
  await page.screenshot({ path: join(shots, 'bigquery-trail-light.png') });
  await setTheme(app, page, 'dark');
  await page.screenshot({ path: join(shots, 'bigquery-trail-dark.png') });
  await setTheme(app, page, 'light');
  await trail.getByRole('button', { name: 'Fechar' }).click();
  // after the whole run: the columns were read for one dataset only, once, and the other one never
  expect(fake.requestsTo('/tables/', 'GET')).toHaveLength(7);
  expect(fake.requestsTo('/datasets/logs/tables/', 'GET')).toHaveLength(0);
});

// last on purpose: it opens the second dataset, which the tests above count on staying unread
test('a dataset row shows a discreet loading signal while its columns are read', async () => {
  await page.getByTestId('env-bq-dev').click();
  await expect(chip()).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
  const row = page.getByTestId('database-logs');
  fake.tableGetDelayMs = 1500;
  try {
    await row.click();
    await expect(page.getByTestId('database-loading-logs')).toBeVisible();
    await expect(row).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('database-loading-logs')).toHaveCount(0, { timeout: 10_000 });
    await expect(row).not.toHaveAttribute('aria-busy', 'true');
    await page.locator('.tree-row', { hasText: /^acessos$/ }).getByRole('button', { name: 'Expandir colunas' }).click();
    await expect(page.locator('.tree-row', { hasText: /^ip/ })).toContainText('STRING');
  } finally {
    fake.tableGetDelayMs = 0;
  }
});
