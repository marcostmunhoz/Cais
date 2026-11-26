import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { getDialect } from '@shared/dialects/registry';
import type { EstimateResponse } from '@shared/ipc';
import type { BigqueryEnvironment, MysqlEnvironment } from '@shared/model';
import type { SessionState } from '@shared/results';

// "Estimar ao digitar" in the renderer: when a question is asked, what is remembered and what a late answer does.
// The renderer modules are loaded by variable paths (they need `window`, and the node typecheck has no DOM types).

interface EstimateView {
  text: string;
  pending: boolean;
  response?: EstimateResponse;
}
interface State {
  tabs: { id: string; environmentId: string; sql: string }[];
  catalog: { environments: (BigqueryEnvironment | MysqlEnvironment)[] } & Record<string, unknown>;
  sessions: Record<string, SessionState>;
  estimateAsYouType: boolean;
  estimates: Record<string, EstimateView>;
}
interface Store {
  getState(): State;
  setState(patch: Partial<State>): void;
}
interface Controller {
  estimateStatement(tabId: string, text: string): Promise<EstimateResponse | null>;
  estimateAvailable(tabId: string): boolean;
  clearEstimate(tabId: string): void;
  resetEstimates(): void;
  forgetEstimates(environmentId: string): void;
  ESTIMATE_TTL_MS: number;
}
interface Lint {
  estimateSource(tabId: string, dialect: ReturnType<typeof getDialect>): (view: { state: EditorState }) => Promise<{ from: number; to: number; message: string }[]>;
  statementToEstimate(dialect: ReturnType<typeof getDialect>, state: EditorState): { text: string; start: number } | null;
}

const STORE = '../../src/renderer/lib/store';
const CONTROLLER = '../../src/renderer/lib/estimate';
const LINT = '../../src/renderer/lib/estimateLint';

const bq: BigqueryEnvironment = { id: 'bq', projectId: 'p', name: 'dev', engine: 'bigquery', gcpProject: 'proj', credentialId: 'c', production: false };
const my: MysqlEnvironment = { id: 'my', projectId: 'p', name: 'dev', engine: 'mysql', host: 'h', port: 3306, credentialId: 'c', production: false };
const idle = (tabId: string, environmentId: string, database: string | null = 'vendas'): SessionState => ({
  tabId, environmentId, status: 'idle', mode: 'read-only', database, transaction: { open: false, statements: 0 },
});

const api = { locale: 'pt-BR', session: { estimate: vi.fn<(tabId: string, sql: string) => Promise<EstimateResponse>>() } };
let store: Store;
let controller: Controller;
let lint: Lint;

beforeAll(async () => {
  vi.stubGlobal('window', { cais: api });
  vi.stubGlobal('document', { documentElement: { style: {} } });
  store = (await import(/* @vite-ignore */ STORE)) as Store;
  controller = (await import(/* @vite-ignore */ CONTROLLER)) as Controller;
  lint = (await import(/* @vite-ignore */ LINT)) as Lint;
});
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  controller.resetEstimates();
  api.session.estimate.mockResolvedValue({ state: 'ok', bytes: 1024 });
  store.setState({
    tabs: [{ id: 't', environmentId: 'bq', sql: '' }, { id: 'm', environmentId: 'my', sql: '' }],
    catalog: { ...store.getState().catalog, environments: [bq, my] },
    sessions: { t: idle('t', 'bq'), m: idle('m', 'my', 'shop') },
    estimateAsYouType: true,
    estimates: {},
  });
});

describe('when a question is asked', () => {
  it('with the switch off, nothing is asked and nothing is shown', async () => {
    store.setState({ estimateAsYouType: false });
    expect(await controller.estimateStatement('t', 'SELECT 1')).toBeNull();
    expect(api.session.estimate).not.toHaveBeenCalled();
    expect(store.getState().estimates).toEqual({});
  });

  it('an engine with no dry run, or a tab that is not connected, is never asked', async () => {
    expect(controller.estimateAvailable('m')).toBe(false);
    expect(await controller.estimateStatement('m', 'SELECT 1')).toBeNull();
    store.setState({ sessions: { t: { ...idle('t', 'bq'), status: 'disconnected' } } });
    expect(controller.estimateAvailable('t')).toBe(false);
    expect(await controller.estimateStatement('t', 'SELECT 1')).toBeNull();
    expect(api.session.estimate).not.toHaveBeenCalled();
  });

  it('asks once for a text and remembers the answer: the same statement again is not sent', async () => {
    expect(await controller.estimateStatement('t', 'SELECT 1')).toEqual({ state: 'ok', bytes: 1024 });
    expect(store.getState().estimates.t).toEqual({ text: 'SELECT 1', pending: false, response: { state: 'ok', bytes: 1024 } });
    expect(await controller.estimateStatement('t', 'SELECT 1')).toEqual({ state: 'ok', bytes: 1024 });
    expect(api.session.estimate).toHaveBeenCalledTimes(1);
    expect(api.session.estimate).toHaveBeenCalledWith('t', 'SELECT 1');
    await controller.estimateStatement('t', 'SELECT 2');
    expect(api.session.estimate).toHaveBeenCalledTimes(2);
  });

  it('the same text in another dataset is another question', async () => {
    await controller.estimateStatement('t', 'SELECT * FROM pedidos');
    store.setState({ sessions: { t: idle('t', 'bq', 'logs') } });
    await controller.estimateStatement('t', 'SELECT * FROM pedidos');
    expect(api.session.estimate).toHaveBeenCalledTimes(2);
  });

  it('a failure on the way to the server (network, permission) is not remembered: the next pause asks again', async () => {
    api.session.estimate.mockResolvedValue({ state: 'error', error: { message: 'x', inStatement: false } });
    await controller.estimateStatement('t', 'SELECT 1');
    await controller.estimateStatement('t', 'SELECT 1');
    expect(api.session.estimate).toHaveBeenCalledTimes(2);
  });

  it('forgetting an environment, or an environment edited, asks again; another environment is left alone', async () => {
    await controller.estimateStatement('t', 'SELECT 1');
    controller.forgetEstimates('my');
    await controller.estimateStatement('t', 'SELECT 1');
    expect(api.session.estimate).toHaveBeenCalledTimes(1);
    controller.forgetEstimates('bq');
    await controller.estimateStatement('t', 'SELECT 1');
    expect(api.session.estimate).toHaveBeenCalledTimes(2);
    store.setState({ catalog: { ...store.getState().catalog, environments: [{ ...bq, gcpProject: 'other' }, my] } });
    await controller.estimateStatement('t', 'SELECT 1');
    expect(api.session.estimate).toHaveBeenCalledTimes(3);
  });

  it('a reset (the switch off and on) asks again, and an answer already in flight is dropped', async () => {
    await controller.estimateStatement('t', 'SELECT 1');
    controller.resetEstimates();
    let settle!: (r: EstimateResponse) => void;
    api.session.estimate.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
    const inFlight = controller.estimateStatement('t', 'SELECT 1');
    controller.resetEstimates();
    settle({ state: 'ok', bytes: 5 });
    expect(await inFlight).toBeNull();
    await controller.estimateStatement('t', 'SELECT 1');
    expect(api.session.estimate).toHaveBeenCalledTimes(3);
  });

  it('an error is remembered too, so a statement with a fault is not asked about again and again', async () => {
    api.session.estimate.mockResolvedValue({ state: 'error', error: { message: 'x', inStatement: true } });
    await controller.estimateStatement('t', 'SELECT FROM');
    await controller.estimateStatement('t', 'SELECT FROM');
    expect(api.session.estimate).toHaveBeenCalledTimes(1);
    expect(store.getState().estimates.t!.response).toMatchObject({ state: 'error' });
  });

  it('an answer is trusted for a short while only', async () => {
    vi.useFakeTimers();
    await controller.estimateStatement('t', 'SELECT 1');
    vi.advanceTimersByTime(controller.ESTIMATE_TTL_MS + 1);
    await controller.estimateStatement('t', 'SELECT 1');
    expect(api.session.estimate).toHaveBeenCalledTimes(2);
  });

  it('while a newer text is in flight the last answer stays on show, marked pending', async () => {
    await controller.estimateStatement('t', 'SELECT 1');
    let settle!: (r: EstimateResponse) => void;
    api.session.estimate.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
    const next = controller.estimateStatement('t', 'SELECT 2');
    expect(store.getState().estimates.t).toEqual({ text: 'SELECT 2', pending: true, response: { state: 'ok', bytes: 1024 } });
    settle({ state: 'ok', bytes: 2048 });
    await next;
    expect(store.getState().estimates.t).toEqual({ text: 'SELECT 2', pending: false, response: { state: 'ok', bytes: 2048 } });
  });

  it('a late answer to an older text is dropped', async () => {
    let first!: (r: EstimateResponse) => void;
    api.session.estimate.mockReturnValueOnce(new Promise((resolve) => (first = resolve)));
    const older = controller.estimateStatement('t', 'SELECT 1');
    const newer = await controller.estimateStatement('t', 'SELECT 2');
    expect(newer).toEqual({ state: 'ok', bytes: 1024 });
    first({ state: 'ok', bytes: 999_999 });
    expect(await older).toBeNull();
    expect(store.getState().estimates.t!.text).toBe('SELECT 2');
    expect(store.getState().estimates.t!.response).toEqual({ state: 'ok', bytes: 1024 });
    // and it was not remembered for its text
    api.session.estimate.mockClear();
    await controller.estimateStatement('t', 'SELECT 1');
    expect(api.session.estimate).toHaveBeenCalledTimes(1);
  });

  it('main skipping (switch off there, no statement, cancelled) or a call that failed leaves nothing on show: an answer never sits under another text', async () => {
    await controller.estimateStatement('t', 'SELECT 1');
    api.session.estimate.mockRejectedValueOnce({ message: 'boom' });
    expect(await controller.estimateStatement('t', 'SELECT 2')).toBeNull();
    expect(store.getState().estimates).toEqual({});
    await controller.estimateStatement('t', 'SELECT 1');
    api.session.estimate.mockResolvedValueOnce({ state: 'skipped', reason: 'cancelled' });
    expect(await controller.estimateStatement('t', 'SELECT 4')).toBeNull();
    expect(store.getState().estimates).toEqual({});
    api.session.estimate.mockResolvedValueOnce({ state: 'skipped', reason: 'off' });
    expect(await controller.estimateStatement('t', 'SELECT 3')).toBeNull();
    expect(store.getState().estimates).toEqual({});
  });

  it('clearing a tab forgets what it showed', async () => {
    await controller.estimateStatement('t', 'SELECT 1');
    controller.clearEstimate('t');
    expect(store.getState().estimates).toEqual({});
  });
});

describe('the statement that is estimated', () => {
  const dialect = getDialect('bigquery');
  const stateOf = (doc: string, anchor: number, head = anchor) => EditorState.create({ doc, selection: { anchor, head } });

  it('is the one under the cursor, with where it starts in the document', () => {
    const doc = 'SELECT 1;\n\nSELECT 2 FROM t;';
    expect(lint.statementToEstimate(dialect, stateOf(doc, 3))).toEqual({ text: 'SELECT 1', start: 0 });
    const second = lint.statementToEstimate(dialect, stateOf(doc, doc.length - 3));
    expect(second).toEqual({ text: 'SELECT 2 FROM t', start: 11 });
    expect(doc.slice(second!.start, second!.start + second!.text.length)).toBe('SELECT 2 FROM t');
  });

  it('a selection that holds one statement is that statement; one that holds several is none', () => {
    const doc = 'SELECT 1;\n\nSELECT 2;';
    expect(lint.statementToEstimate(dialect, stateOf(doc, 11, 19))).toEqual({ text: 'SELECT 2', start: 11 });
    expect(lint.statementToEstimate(dialect, stateOf(doc, 0, doc.length))).toBeNull();
  });

  it('nothing under the cursor is nothing to estimate', () => {
    expect(lint.statementToEstimate(dialect, stateOf('', 0))).toBeNull();
    expect(lint.statementToEstimate(dialect, stateOf('SELECT 1;\n\n\n\n', 12))).toBeNull();
  });
});

describe('the lint source', () => {
  const dialect = getDialect('bigquery');
  const doc = 'SELECT 1 FROM a;\n\nSELECT 2 FROM b;';
  const viewAt = (anchor: number) => ({ state: EditorState.create({ doc, selection: { anchor } }) });

  it('marks the statement the server says is wrong', async () => {
    api.session.estimate.mockResolvedValue({ state: 'error', error: { message: 'Syntax error at [1:8]', inStatement: true } });
    const source = lint.estimateSource('t', dialect);
    const marks = await source(viewAt(3));
    expect(marks).toHaveLength(1);
    expect(marks[0]!.from).toBeGreaterThanOrEqual(0);
    expect(marks[0]!.to).toBeLessThanOrEqual(16);
  });

  it('a slow older run that comes back after a newer one does not wipe what the newer one marked', async () => {
    const source = lint.estimateSource('t', dialect);
    // the second statement is remembered with an error in the text, so its run answers at once
    api.session.estimate.mockResolvedValueOnce({ state: 'error', error: { message: 'bad b', inStatement: true } });
    await controller.estimateStatement('t', 'SELECT 2 FROM b');
    // run A: the cursor is in the first statement, a miss that takes long
    let slow!: (r: EstimateResponse) => void;
    api.session.estimate.mockReturnValueOnce(new Promise((resolve) => (slow = resolve)));
    const view = { state: EditorState.create({ doc, selection: { anchor: 3 } }) };
    const older = source(view);
    // run B: the cursor moved to the second statement; the editor applies its mark
    view.state = EditorState.create({ doc, selection: { anchor: doc.length - 2 } });
    const marks = await source(view);
    expect(marks).toHaveLength(1);
    view.state = view.state.update(setDiagnostics(view.state, marks as Diagnostic[])).state;
    slow({ state: 'ok', bytes: 1 });
    // A is stale: it hands back what the editor shows instead of an empty list
    const kept = await older;
    expect(kept).toHaveLength(1);
    expect(kept[0]!.message).toBe('bad b');
  });
});
