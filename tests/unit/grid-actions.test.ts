import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '@shared/model';
import type { SchemaTree, SessionState, StatementResult } from '@shared/results';
import { setLocale } from '@shared/i18n';

// The renderer's grid actions against a fake `window.cais`: what Gerar UPDATE, Aplicar and
// closing a tab do with pending edits. The paths are not literals so the node typecheck (no DOM types) does
// not follow them into renderer code; the shapes below are the few this test touches.

interface Run {
  running: boolean;
  connecting: boolean;
  results: StatementResult[];
  active: number;
  edits?: { result: StatementResult; cells: Record<number, Record<number, unknown>>; deleted: number[] };
  editNotice?: string[];
}
interface State {
  tabs: { id: string; environmentId: string; sql: string }[];
  activeTabId: string | null;
  catalog: { environments: Environment[] } & Record<string, unknown>;
  sessions: Record<string, SessionState>;
  runs: Record<string, Run>;
  schemas: Record<string, { status: 'ready'; tree: SchemaTree }>;
  confirm: { title: string; body: string; onConfirm: () => void } | null;
  toast: { message: string } | null;
}
interface Actions {
  applyEdits(tabId: string): Promise<void>;
  generateUpdates(tabId: string): Promise<void>;
  markRowsDeleted(tabId: string, result: StatementResult, rows: readonly number[], marked: boolean): void;
  setCellEdit(tabId: string, result: StatementResult, row: number, column: number, value: unknown): void;
  generateCellUpdates(tabId: string, result: StatementResult, column: number, rows: readonly number[]): Promise<void>;
  generateInserts(tabId: string, result: StatementResult, rows: readonly number[], withKey: boolean): void;
  registerEditor(handle: unknown): void;
  requestCloseTab(tabId: string): Promise<void>;
}
interface Store {
  getState(): State;
  setState(patch: Partial<State>): void;
}

const ACTIONS = '../../src/renderer/lib/actions';
const STORE = '../../src/renderer/lib/store';

const dev: Environment = { id: 'dev', projectId: 'p', name: 'dev', engine: 'mysql', host: 'h', port: 3306, credentialId: 'c', production: false };

const tree = (key: string[]): SchemaTree => ({
  databases: [
    {
      name: 'shop',
      tables: [
        {
          name: 'items',
          type: 'table',
          columns: [
            { name: 'id', type: 'int', nullable: false, key: 'PRI' },
            { name: 'tenant_id', type: 'int', nullable: false, ...(key.includes('tenant_id') ? { key: 'PRI' as const } : {}) },
            { name: 'name', type: 'varchar(40)', nullable: true },
          ],
        },
      ],
    },
  ],
});

const read = (database = 'shop', rows: unknown[][] = [[1, 'a'], [2, 'b']]): StatementResult => ({
  index: 0,
  sql: 'SELECT id, name FROM items',
  kind: 'read',
  verb: 'SELECT',
  durationMs: 1,
  columns: [
    { name: 'id', type: 'int', source: { database, table: 'items', column: 'id' }, primaryKeyPart: true, nullable: false },
    { name: 'name', type: 'varchar', source: { database, table: 'items', column: 'name' }, primaryKeyPart: false, nullable: true },
  ],
  rows: rows as StatementResult['rows'],
});

const session: SessionState = {
  tabId: 't', environmentId: 'dev', status: 'idle', mode: 'autocommit', database: 'shop', transaction: { open: false, statements: 0 },
};

let actions: Actions;
let store: Store;
const api = {
  locale: 'pt-BR',
  schema: { get: vi.fn() },
  session: { run: vi.fn(), close: vi.fn(async () => undefined), state: vi.fn(async () => session), open: vi.fn(async () => session) },
  tabs: { save: vi.fn(async () => undefined) },
};

beforeAll(async () => {
  vi.stubGlobal('window', { cais: api });
  vi.stubGlobal('document', { documentElement: {} });
  store = (await import(/* @vite-ignore */ STORE)) as Store;
  actions = (await import(/* @vite-ignore */ ACTIONS)) as Actions;
  setLocale('pt-BR');
});
afterAll(() => vi.unstubAllGlobals());

let result: StatementResult;
beforeEach(() => {
  vi.clearAllMocks();
  result = read();
  store.setState({
    tabs: [{ id: 't', environmentId: 'dev', sql: result.sql }],
    activeTabId: 't',
    catalog: { ...store.getState().catalog, environments: [dev] },
    sessions: { t: session },
    schemas: { dev: { status: 'ready', tree: tree(['id']) } },
    runs: { t: { running: false, connecting: false, results: [result], active: 0, edits: { result, cells: { 0: { 1: 'x' } }, deleted: [] } } },
    confirm: null,
    toast: null,
  });
});

describe('grid edits in the renderer', () => {
  it('Aplicar reads the schema again: a key that grew by a column the query did not select is refused, nothing runs', async () => {
    api.schema.get.mockResolvedValueOnce(tree(['id', 'tenant_id']));
    await actions.applyEdits('t');
    expect(api.schema.get).toHaveBeenCalledWith('dev', { refresh: true });
    expect(api.session.run).not.toHaveBeenCalled();
    expect(store.getState().toast?.message).toBe('Edição na grade só para resultado de uma tabela com a chave primária inteira (falta: tenant_id).');
    // the edits stay for the person to decide
    expect(store.getState().runs.t!.edits?.cells).toEqual({ 0: { 1: 'x' } });
  });

  it('Aplicar with the same key runs the UPDATE by the whole key', async () => {
    api.schema.get.mockResolvedValueOnce(tree(['id']));
    api.session.run
      .mockResolvedValueOnce({ session, results: [{ index: 0, sql: 'u', kind: 'write', verb: 'UPDATE', durationMs: 1, affectedRows: 1 }] })
      .mockResolvedValueOnce({ session, results: [read('shop', [[1, 'x'], [2, 'b']])] });
    await actions.applyEdits('t');
    await vi.waitFor(() => expect(api.session.run).toHaveBeenCalledTimes(2));
    expect(api.session.run.mock.calls[0]![1].sql).toBe("UPDATE `shop`.`items` SET `name` = 'x' WHERE `id` = 1;");
    await vi.waitFor(() => expect(store.getState().runs.t!.running).toBe(false));
    expect(store.getState().runs.t!.results[0]!.rows).toEqual([[1, 'x'], [2, 'b']]);
  });

  it('after Aplicar, a re-read that lands on another database keeps the old result and its remaining edits', async () => {
    store.setState({
      runs: { t: { running: false, connecting: false, results: [result], active: 0, edits: { result, cells: { 0: { 1: 'x' }, 1: { 1: 'y' } }, deleted: [] } } },
    });
    api.schema.get.mockResolvedValueOnce(tree(['id']));
    api.session.run
      // the first UPDATE ran, the second failed: its edit is kept
      .mockResolvedValueOnce({
        session,
        results: [
          { index: 0, sql: 'u1', kind: 'write', verb: 'UPDATE', durationMs: 1, affectedRows: 1 },
          { index: 1, sql: 'u2', kind: 'write', verb: 'UPDATE', durationMs: 1, error: { message: 'Lock wait timeout', code: 'ER_LOCK_WAIT_TIMEOUT' } },
        ],
      })
      // the session is in another database now (a USE, or the database picker): the same SQL reads another table
      .mockResolvedValueOnce({ session: { ...session, database: 'shop_archive' }, results: [read('shop_archive', [[2, 'other'], [1, 'other']])] });
    await actions.applyEdits('t');
    await vi.waitFor(() => expect(store.getState().runs.t!.running).toBe(false));
    const run = store.getState().runs.t!;
    expect(run.results[0]).toBe(result);
    expect(run.edits?.result).toBe(result);
    expect(run.edits?.cells).toEqual({ 1: { 1: 'y' } });
    expect(run.editNotice).toContain('A consulta não pôde ser rodada de novo: ela leu outra tabela (o banco da sessão mudou). O resultado anterior foi mantido.');
  });

  it('closing a tab with pending edits asks first; nothing closes until the person agrees', async () => {
    await actions.requestCloseTab('t');
    const confirm = store.getState().confirm;
    expect(confirm?.title).toBe('Descartar as edições da grade');
    expect(confirm?.body).toContain('1 alteração pendente');
    expect(api.session.close).not.toHaveBeenCalled();
    expect(store.getState().tabs).toHaveLength(1);

    confirm!.onConfirm();
    await vi.waitFor(() => expect(store.getState().tabs).toHaveLength(0));
    expect(api.session.close).toHaveBeenCalledWith('t', undefined);
  });
});

describe('row deletions in the renderer', () => {
  const ok = (index: number, verb: string, affectedRows = 1) => ({ index, sql: 's', kind: 'write', verb, durationMs: 1, affectedRows });
  const mark = (rows: number[], cells: Record<number, Record<number, unknown>> = {}) => {
    store.setState({ runs: { t: { running: false, connecting: false, results: [result], active: 0, edits: { result, cells, deleted: rows } } } });
  };
  const insertText = vi.fn();
  beforeEach(() => {
    insertText.mockClear();
    actions.registerEditor({ getSelection: () => ({ cursor: 0 }), focus: vi.fn(), insertText });
    api.schema.get.mockResolvedValue(tree(['id']));
  });
  afterAll(() => actions.registerEditor(null));

  it('marks and unmarks rows; a pending edit on a marked row stays and comes back', () => {
    store.setState({ runs: { t: { running: false, connecting: false, results: [result], active: 0 } } });
    actions.markRowsDeleted('t', result, [1, 0], true);
    expect(store.getState().runs.t!.edits).toEqual({ result, cells: {}, deleted: [0, 1] });
    actions.setCellEdit('t', result, 0, 1, 'zz');
    actions.markRowsDeleted('t', result, [0], false);
    expect(store.getState().runs.t!.edits).toEqual({ result, cells: { 0: { 1: 'zz' } }, deleted: [1] });
    actions.markRowsDeleted('t', result, [1], false);
    actions.setCellEdit('t', result, 0, 1, undefined);
    // nothing pending any more: no edits object at all
    expect(store.getState().runs.t!.edits).toBeUndefined();
  });

  it('ignores a result that is no longer the tab\'s', () => {
    actions.markRowsDeleted('t', read(), [0], true);
    expect(store.getState().runs.t!.edits?.deleted).toEqual([]);
  });

  it('Gerar SQL puts the UPDATEs, then the DELETEs, in the editor; a marked row gets no UPDATE', async () => {
    mark([0], { 0: { 1: 'x' }, 1: { 1: 'y' } });
    await actions.generateUpdates('t');
    expect(insertText).toHaveBeenCalledWith("UPDATE `shop`.`items` SET `name` = 'y' WHERE `id` = 2;\nDELETE FROM `shop`.`items` WHERE `id` = 1;");
    expect(api.session.run).not.toHaveBeenCalled();
    expect(store.getState().runs.t!.edits).toBeUndefined();
  });

  it('Aplicar always asks in Auto-commit when rows are marked, even outside production, and lists the DELETEs', async () => {
    mark([1]);
    await actions.applyEdits('t');
    const confirm = store.getState().confirm as unknown as { title: string; body: string; items: string[]; notes?: string[] };
    expect(confirm.title).toBe('Excluir linhas em Auto-commit');
    expect(confirm.body).toContain('A linha marcada será excluída');
    expect(confirm.items).toEqual(['DELETE FROM `shop`.`items` WHERE `id` = 2;']);
    expect(api.session.run).not.toHaveBeenCalled();
  });

  it('the confirmation warns about a known cascade and a trigger, and about metadata that could not be read', async () => {
    const t = tree(['id']);
    t.foreignKeysComplete = false;
    t.databases[0]!.tables[0]!.cascadedBy = ['shop.order_lines'];
    t.databases[0]!.tables[0]!.triggers = ['BEGIN END'];
    api.schema.get.mockResolvedValue(t);
    mark([0]);
    await actions.applyEdits('t');
    const notes = (store.getState().confirm as unknown as { notes: string[] }).notes;
    expect(notes).toEqual([
      'A tabela items tem chaves estrangeiras em cascata (ON DELETE ou ON UPDATE): excluir pode apagar ou alterar linhas de shop.order_lines.',
      'A tabela items tem trigger: se algum for de exclusão, o que ele grava não entra na contagem de linhas.',
      'Parte dos metadados do banco (triggers ou chaves estrangeiras) não pôde ser lida: a exclusão pode alcançar outras tabelas.',
    ]);
  });

  it('in production the same confirmation as before, with the deletion said in it', async () => {
    store.setState({ catalog: { ...store.getState().catalog, environments: [{ ...dev, production: true }] } });
    mark([0], { 1: { 1: 'y' } });
    await actions.applyEdits('t');
    const confirm = store.getState().confirm as unknown as { title: string; notes: string[]; items: string[] };
    expect(confirm.title).toBe('Aplicar em Auto-commit em produção');
    expect(confirm.notes[0]).toBe('A linha marcada será excluída do banco.');
    // the sentence about Rollback is in the body only
    expect(confirm.notes.join(' ')).not.toContain('sem Rollback');
    expect(confirm.items).toHaveLength(2);
  });

  it('in a Transaction nothing is asked: the statements run, UPDATEs first', async () => {
    const tx = { ...session, mode: 'transaction' as const, transaction: { open: true, statements: 2 } };
    store.setState({ sessions: { t: tx } });
    mark([0], { 1: { 1: 'y' } });
    api.session.run
      .mockResolvedValueOnce({ session: tx, results: [ok(0, 'UPDATE'), ok(1, 'DELETE')] })
      .mockResolvedValueOnce({ session: tx, results: [read('shop', [[2, 'y']])] });
    await actions.applyEdits('t');
    await vi.waitFor(() => expect(store.getState().runs.t!.running).toBe(false));
    expect(store.getState().confirm).toBeNull();
    const call = api.session.run.mock.calls[0]![1];
    expect(call.origin).toBe('grid');
    expect(call.sql).toBe("UPDATE `shop`.`items` SET `name` = 'y' WHERE `id` = 2;\nDELETE FROM `shop`.`items` WHERE `id` = 1;");
    // the re-read has no row 1: nothing stays pending
    expect(store.getState().runs.t!.results[0]!.rows).toEqual([[2, 'y']]);
    expect(store.getState().runs.t!.edits).toBeUndefined();
    expect(store.getState().toast?.message).toBe('Rodaram na transação: 1 UPDATE e 1 DELETE. Faça Commit para gravar.');
  });

  it('a DELETE that fails keeps its mark and the edits of its row, and says which statement failed', async () => {
    // row 1 carries stored edits; row 0 (no edits) is deleted first and succeeds, then row 1's DELETE is stopped by a foreign key
    mark([0, 1], { 1: { 1: 'x' } });
    api.session.run
      .mockResolvedValueOnce({
        session,
        results: [ok(0, 'DELETE'), { index: 1, sql: 'd2', kind: 'write', verb: 'DELETE', durationMs: 1, error: { message: 'Cannot delete a parent row', code: 'ER_ROW_IS_REFERENCED_2' } }],
      })
      .mockResolvedValueOnce({ session, results: [read('shop', [[2, 'b']])] });
    await actions.applyEdits('t');
    store.getState().confirm!.onConfirm();
    await vi.waitFor(() => expect(api.session.run).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store.getState().runs.t!.running).toBe(false));
    const run = store.getState().runs.t!;
    expect(run.results[0]!.rows).toEqual([[2, 'b']]);
    // the row that was deleted is gone; the failed one keeps its mark and its stored edits, now at its new index
    expect(run.edits?.deleted).toEqual([0]);
    expect(run.edits?.cells).toEqual({ 0: { 1: 'x' } });
    expect(run.editNotice).toContain('O DELETE 2 falhou: Cannot delete a parent row');
    expect(run.editNotice).toContain('Em Auto-commit, o comando anterior ao erro já está gravado.');
  });

  it('an UPDATE that fails before the DELETEs keeps every mark together with the stored edits of the marked rows', async () => {
    // row 0 is edited (UPDATE, statement 0); rows 1 and 2 are marked, row 1 with stored edits
    result = read('shop', [[1, 'a'], [2, 'b'], [3, 'c']]);
    store.setState({
      runs: { t: { running: false, connecting: false, results: [result], active: 0, edits: { result, cells: { 0: { 1: 'x' }, 1: { 1: 'kept' } }, deleted: [1, 2] } } },
    });
    api.session.run.mockResolvedValueOnce({
      session,
      results: [{ index: 0, sql: 'u', kind: 'write', verb: 'UPDATE', durationMs: 1, error: { message: 'Lock wait timeout', code: 'ER_LOCK_WAIT_TIMEOUT' } }],
    });
    await actions.applyEdits('t');
    store.getState().confirm!.onConfirm();
    await vi.waitFor(() => expect(api.session.run).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(store.getState().runs.t!.editNotice).toBeDefined());
    const run = store.getState().runs.t!;
    // nothing ran: no re-read, the result is the same one, and every edit and mark stays
    expect(api.session.run).toHaveBeenCalledTimes(1);
    expect(run.results[0]).toBe(result);
    expect(run.edits?.deleted).toEqual([1, 2]);
    expect(run.edits?.cells).toEqual({ 0: { 1: 'x' }, 1: { 1: 'kept' } });
    expect(run.editNotice).toContain('O UPDATE 1 falhou: Lock wait timeout');
  });

  it('a DELETE that finds no row is reported with its own verb', async () => {
    store.setState({ sessions: { t: { ...session, mode: 'transaction' } } });
    mark([0]);
    api.session.run
      .mockResolvedValueOnce({ session: { ...session, mode: 'transaction' }, results: [ok(0, 'DELETE', 0)] })
      .mockResolvedValueOnce({ session: { ...session, mode: 'transaction' }, results: [read('shop', [[2, 'b']])] });
    await actions.applyEdits('t');
    await vi.waitFor(() => expect(store.getState().runs.t!.running).toBe(false));
    expect(store.getState().runs.t!.editNotice).toContain('O DELETE 1 não encontrou a linha (esperado: 1).');
  });

  it('Aplicar refuses when the key moved, and the marks stay', async () => {
    mark([0]);
    api.schema.get.mockResolvedValueOnce(tree(['id', 'tenant_id']));
    await actions.applyEdits('t');
    expect(api.session.run).not.toHaveBeenCalled();
    expect(store.getState().confirm).toBeNull();
    expect(store.getState().runs.t!.edits?.deleted).toEqual([0]);
  });

  it('closing a tab with only a deletion pending asks first', async () => {
    mark([0]);
    await actions.requestCloseTab('t');
    expect(store.getState().confirm?.body).toContain('1 alteração pendente');
    expect(api.session.close).not.toHaveBeenCalled();
  });
});

describe('Gerar UPDATE da célula in the renderer', () => {
  const insertText = vi.fn();
  beforeEach(() => {
    insertText.mockClear();
    actions.registerEditor({ getSelection: () => ({ cursor: 0 }), focus: vi.fn(), insertText });
    api.schema.get.mockResolvedValue(tree(['id']));
  });
  afterAll(() => actions.registerEditor(null));

  it('writes the value as shown (the pending edit applied), selects the literal and leaves the edits alone', async () => {
    await actions.generateCellUpdates('t', result, 1, [0, 1]);
    expect(api.schema.get).toHaveBeenCalledWith('dev', { refresh: true });
    const [text, ranges] = insertText.mock.calls[0]! as [string, { from: number; to: number }[]];
    expect(text).toBe("UPDATE `shop`.`items` SET `name` = 'x' WHERE `id` = 1;\nUPDATE `shop`.`items` SET `name` = 'b' WHERE `id` = 2;");
    expect(ranges.map((r) => text.slice(r.from, r.to))).toEqual(["'x'", "'b'"]);
    // nothing ran, and the pending edit is still pending
    expect(api.session.run).not.toHaveBeenCalled();
    expect(store.getState().runs.t!.edits?.cells).toEqual({ 0: { 1: 'x' } });
  });

  it('keys on the row the server sent, even when its key cell has a pending edit', async () => {
    store.setState({ runs: { t: { running: false, connecting: false, results: [result], active: 0, edits: { result, cells: { 0: { 0: 99 } }, deleted: [] } } } });
    await actions.generateCellUpdates('t', result, 0, [0]);
    expect(insertText.mock.calls[0]![0]).toBe('UPDATE `shop`.`items` SET `id` = 99 WHERE `id` = 1;');
  });

  it('reads the schema again: a key that grew by a column the result does not have is refused, nothing is inserted', async () => {
    api.schema.get.mockResolvedValueOnce(tree(['id', 'tenant_id']));
    await actions.generateCellUpdates('t', result, 1, [0]);
    expect(insertText).not.toHaveBeenCalled();
    expect(store.getState().toast?.message).toBe('Edição na grade só para resultado de uma tabela com a chave primária inteira (falta: tenant_id).');
  });

  it('refuses a cut binary value and more rows than the limit', async () => {
    const cut = read('shop', [[1, { kind: 'binary', hex: 'ab', length: 400 }]]);
    store.setState({ runs: { t: { running: false, connecting: false, results: [cut], active: 0 } } });
    await actions.generateCellUpdates('t', cut, 1, [0]);
    expect(insertText).not.toHaveBeenCalled();
    expect(store.getState().toast?.message).toBe('O valor binário está cortado na grade: não dá para editá-lo.');

    store.setState({ toast: null });
    await actions.generateCellUpdates('t', result, 1, Array.from({ length: 501 }, (_, i) => i));
    expect(insertText).not.toHaveBeenCalled();
    expect(api.schema.get).toHaveBeenCalledTimes(1);
    expect(store.getState().toast?.message).toContain('até 500 células');
  });

  it('does nothing for a result that is no longer the tab\'s', async () => {
    store.setState({ runs: { t: { running: false, connecting: false, results: [read()], active: 0 } } });
    await actions.generateCellUpdates('t', result, 1, [0]);
    expect(insertText).not.toHaveBeenCalled();
  });
});

describe('Gerar INSERT in the renderer', () => {
  const insertText = vi.fn();
  beforeEach(() => {
    insertText.mockClear();
    actions.registerEditor({ getSelection: () => ({ cursor: 0 }), focus: vi.fn(), insertText });
  });
  afterAll(() => actions.registerEditor(null));

  it('writes the rows as shown (the pending edit applied), selects nothing in particular and leaves the edits alone', () => {
    actions.generateInserts('t', result, [1, 0], true);
    expect(insertText).toHaveBeenCalledWith("INSERT INTO `shop`.`items` (`id`, `name`) VALUES\n  (1, 'x'),\n  (2, 'b');");
    // nothing ran and no schema was read again: an INSERT finds no row by a key
    expect(api.session.run).not.toHaveBeenCalled();
    expect(api.schema.get).not.toHaveBeenCalled();
    expect(store.getState().runs.t!.edits?.cells).toEqual({ 0: { 1: 'x' } });
    expect(store.getState().toast).toBeNull();
  });

  it('without the primary key leaves the key column out; where the key is not whole in the result there is no such variant', () => {
    actions.generateInserts('t', result, [0], false);
    expect(insertText).toHaveBeenLastCalledWith("INSERT INTO `shop`.`items` (`name`) VALUES ('x');");
    insertText.mockClear();
    store.setState({ schemas: { dev: { status: 'ready', tree: tree(['id', 'tenant_id']) } } });
    actions.generateInserts('t', result, [0], false);
    expect(insertText).not.toHaveBeenCalled();
    actions.generateInserts('t', result, [0], true);
    expect(insertText).toHaveBeenCalledWith("INSERT INTO `shop`.`items` (`id`, `name`) VALUES (1, 'x');");
  });

  it('names the columns it left out', () => {
    const withExpression = read();
    withExpression.columns = [...withExpression.columns!, { name: 'two', type: 'bigint' }];
    withExpression.rows = [[1, 'a', 2]];
    store.setState({ runs: { t: { running: false, connecting: false, results: [withExpression], active: 0 } } });
    actions.generateInserts('t', withExpression, [0], true);
    expect(insertText).toHaveBeenCalledWith("INSERT INTO `shop`.`items` (`id`, `name`) VALUES (1, 'a');");
    expect(store.getState().toast?.message).toBe('Fora do INSERT: two (coluna gerada, repetida, expressão ou de tipo sem suporte).');
  });

  it('refuses a cut binary value and more rows than the limit, inserting nothing', () => {
    const cut = read('shop', [[1, { kind: 'binary', hex: 'ab', length: 400 }]]);
    store.setState({ runs: { t: { running: false, connecting: false, results: [cut], active: 0 } } });
    actions.generateInserts('t', cut, [0], true);
    expect(insertText).not.toHaveBeenCalled();
    expect(store.getState().toast?.message).toBe('O valor binário de name na linha 1 está cortado na grade: não dá para gerar o INSERT.');

    store.setState({ toast: null, runs: { t: { running: false, connecting: false, results: [result], active: 0 } } });
    actions.generateInserts('t', result, Array.from({ length: 1001 }, (_, i) => i), true);
    expect(insertText).not.toHaveBeenCalled();
    expect(store.getState().toast?.message).toContain('até 1000 linhas');
  });

  it('says why when the result cannot generate one, and does nothing for a result that is no longer the tab\'s', () => {
    const noTable: StatementResult = { ...result, columns: [{ name: 'x', type: 'int' }], rows: [[1]] };
    store.setState({ runs: { t: { running: false, connecting: false, results: [noTable], active: 0 } } });
    actions.generateInserts('t', noTable, [0], true);
    expect(insertText).not.toHaveBeenCalled();
    expect(store.getState().toast?.message).toMatch(/não vêm de uma tabela/);

    store.setState({ toast: null, runs: { t: { running: false, connecting: false, results: [read()], active: 0 } } });
    actions.generateInserts('t', result, [0], true);
    expect(insertText).not.toHaveBeenCalled();
    expect(store.getState().toast).toBeNull();
  });
});
