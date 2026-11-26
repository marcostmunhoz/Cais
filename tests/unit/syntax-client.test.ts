import { EditorState } from '@codemirror/state';
import { describe, expect, it, vi } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import { createSyntaxCheck, type SyntaxReply, type SyntaxRequest, type SyntaxWorkerLike } from '../../src/renderer/lib/syntax/client';
import { PASS_STATEMENTS, syntaxDiagnostics } from '../../src/renderer/lib/syntax/lint';
import { checkMysql } from '../../src/renderer/lib/syntax/mysql';

/** A worker that answers with the real check, a tick later (the way a worker does). */
class FakeWorker implements SyntaxWorkerLike {
  onmessage: ((e: { data: SyntaxReply }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: SyntaxRequest[] = [];
  terminated = false;
  silent = false;
  postMessage(m: SyntaxRequest): void {
    this.sent.push(m);
    if (this.silent) return;
    setTimeout(() => this.onmessage?.({ data: { id: m.id, issues: checkMysql(m.text) } }), 0);
  }
  terminate(): void {
    this.terminated = true;
  }
}

describe('the syntax check client', () => {
  it('asks the worker once for a text, and answers the next time from memory', async () => {
    const worker = new FakeWorker();
    const make = vi.fn(() => worker);
    const check = createSyntaxCheck(make);
    const first = await check('SELECT * FRM t');
    expect(first).toHaveLength(1);
    expect(await check('SELECT * FRM t')).toEqual(first);
    expect(await check('SELECT 1')).toEqual([]);
    expect(make).toHaveBeenCalledTimes(1);
    expect(worker.sent.map((m) => m.text)).toEqual(['SELECT * FRM t', 'SELECT 1']);
  });

  it('answers several texts that are in flight together, each to its own', async () => {
    const check = createSyntaxCheck(() => new FakeWorker());
    const [a, b, c] = await Promise.all([check('SELECT * FRM a'), check('SELECT 1'), check('SELECT * FRM c')]);
    expect([a.length, b.length, c.length]).toEqual([1, 0, 1]);
  });

  it('answers "no issue" when the worker cannot start', async () => {
    const make = vi.fn(() => {
      throw new Error('no workers here');
    });
    const check = createSyntaxCheck(make);
    expect(await check('SELECT * FRM t')).toEqual([]);
    expect(await check('SELECT * FRM u')).toEqual([]);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('answers "no issue" when the worker fails, and stops asking it', async () => {
    const worker = new FakeWorker();
    worker.silent = true;
    const make = vi.fn(() => worker);
    const check = createSyntaxCheck(make);
    const pending = check('SELECT * FRM t');
    worker.onerror?.(new Error('boom'));
    expect(await pending).toEqual([]);
    expect(worker.terminated).toBe(true);
    expect(await check('SELECT * FRM u')).toEqual([]);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('gives up on a statement the worker does not answer, restarts the worker, and does not ask that statement again', async () => {
    const hung = new FakeWorker();
    hung.silent = true;
    const fresh = new FakeWorker();
    const workers = [hung, fresh];
    const make = vi.fn(() => workers.shift()!);
    const check = createSyntaxCheck(make, 20);
    expect(await check('SELECT * FRM t')).toEqual([]);
    expect(hung.terminated).toBe(true);
    // the next statement goes to a new worker
    expect(await check('SELECT * FRM u')).toHaveLength(1);
    expect(make).toHaveBeenCalledTimes(2);
    // the one that hung is remembered as "no issue"
    expect(await check('SELECT * FRM t')).toEqual([]);
    expect(fresh.sent.map((m) => m.text)).toEqual(['SELECT * FRM u']);
  });

  it('sends one statement at a time, and the time limit counts from when the worker starts on it', async () => {
    const worker = new FakeWorker();
    const check = createSyntaxCheck(() => worker, 50);
    const answers = Promise.all(['SELECT * FRM a', 'SELECT * FRM b', 'SELECT * FRM c'].map((t) => check(t)));
    expect(worker.sent).toHaveLength(1);
    expect((await answers).map((r) => r.length)).toEqual([1, 1, 1]);
    expect(worker.sent).toHaveLength(3);
  });

  it('does not ask again for texts it has seen, however many statements a script has', async () => {
    const worker = new FakeWorker();
    const check = createSyntaxCheck(() => worker);
    const texts = Array.from({ length: 40 }, (_, i) => `SELECT ${i}`);
    for (let pass = 0; pass < 3; pass++) await Promise.all(texts.map((t) => check(t)));
    expect(worker.sent).toHaveLength(40);
  });

  it('drops what nobody waits for any more before it reaches the worker', async () => {
    const worker = new FakeWorker();
    const check = createSyntaxCheck(() => worker);
    const old = new AbortController();
    const stale = ['SELECT * FRM a', 'SELECT * FRM b', 'SELECT * FRM c'].map((t) => check(t, old.signal));
    const shared = check('SELECT * FRM c', new AbortController().signal);
    old.abort();
    expect((await Promise.all(stale)).map((r) => r.length)).toEqual([1, 0, 1]);
    expect((await shared).length).toBe(1);
    // the first was already with the worker; "c" stayed because a live pass asked for it too; "b" never left
    expect(worker.sent.map((m) => m.text)).toEqual(['SELECT * FRM a', 'SELECT * FRM c']);
    // a dropped text is asked again later
    expect(await check('SELECT * FRM b')).toHaveLength(1);
  });
});

describe('how much of a document one pass reads', () => {
  const dialect = getDialect('mysql');
  const doc = Array.from({ length: 400 }, (_, i) => `SELECT * FRM t${i}`).join(';\n');
  const statements = doc.split(';\n');
  const at = (text: string) => doc.indexOf(text);

  it('only the statement under the cursor and the ones in view, up to a limit', async () => {
    const asked: string[] = [];
    const check = async (text: string) => {
      asked.push(text);
      return checkMysql(text);
    };
    const cursor = at('SELECT * FRM t200') + 3;
    const state = EditorState.create({ doc, selection: { anchor: cursor } });
    const view = [{ from: at('SELECT * FRM t10;'), to: at('SELECT * FRM t13;') }];
    const out = await syntaxDiagnostics(state, { dialect, check, message: (m) => m }, { ranges: view });
    expect(asked[0]).toBe('SELECT * FRM t200');
    expect(asked.sort()).toEqual(['SELECT * FRM t10', 'SELECT * FRM t11', 'SELECT * FRM t12', 'SELECT * FRM t13', 'SELECT * FRM t200'].sort());
    expect(out).toHaveLength(5);
    // no view given: the cursor's statement and then the first ones, never past the limit
    asked.length = 0;
    await syntaxDiagnostics(state, { dialect, check, message: (m) => m });
    expect(asked).toHaveLength(PASS_STATEMENTS);
    expect(asked[0]).toBe('SELECT * FRM t200');
    expect(statements.length).toBe(400);
  });

  it('a long script costs the worker nothing on the next pass (cursor moves, same statements)', async () => {
    const worker = new FakeWorker();
    const check = createSyntaxCheck(() => worker);
    const state = (anchor: number) => EditorState.create({ doc, selection: { anchor } });
    const view = [{ from: 0, to: at('SELECT * FRM t60;') }];
    await syntaxDiagnostics(state(5), { dialect, check, message: (m) => m }, { ranges: view });
    const first = worker.sent.length;
    expect(first).toBe(PASS_STATEMENTS);
    await syntaxDiagnostics(state(20), { dialect, check, message: (m) => m }, { ranges: view });
    await syntaxDiagnostics(state(at('SELECT * FRM t3;')), { dialect, check, message: (m) => m }, { ranges: view });
    expect(worker.sent.length).toBe(first);
  });
});

describe('the diagnostics of a document', () => {
  const dialect = getDialect('mysql');
  const run = (marked: string, check = async (text: string) => checkMysql(text)) => {
    const head = marked.indexOf('|');
    const doc = marked.replace('|', '');
    const state = EditorState.create({ doc, selection: { anchor: head === -1 ? doc.length : head } });
    return syntaxDiagnostics(state, { dialect, check, message: (m) => `erro: ${m}` });
  };

  it('marks the first error of each statement where the parser stopped, in the position of the document', async () => {
    const doc = 'SELECT 1;\nSELECT * FRM t;\nSELECT 2;\nUPDATE t SET WHERE a = 1';
    const out = await run(`|${doc}`);
    expect(out.map((d) => doc.slice(d.from, d.to))).toEqual(['FRM', 'a']);
    expect(out[0]).toMatchObject({ severity: 'error' });
    expect(out[0]!.message).toMatch(/^erro: 'FRM' is not valid/);
  });

  it('an unfinished statement under the cursor is not marked while the cursor is at its end', async () => {
    expect(await run('SELECT * FROM t WHERE|')).toEqual([]);
    expect(await run('SELECT * FROM t WHERE |')).toEqual([]);
    // the cursor went elsewhere: it is an error now
    const away = await run('SELECT 1;\n|SELECT * FROM t WHERE');
    expect(away).toHaveLength(1);
    const before = await run('SELECT * FROM t WHERE|;\nSELECT 2');
    expect(before).toEqual([]);
    const moved = await run('|SELECT * FROM t WHERE');
    expect(moved).toHaveLength(1);
  });

  it('an error in the middle of the statement the person is typing is marked at once', async () => {
    const out = await run('SELECT * FRM t WHERE a =|');
    expect(out).toHaveLength(1);
  });

  it('a script with a DELIMITER line is read statement by statement, the client line is not a statement', async () => {
    const doc = 'DELIMITER $$\nSELECT * FRM t$$\nDELIMITER ;\nSELECT 1';
    const out = await run(`|${doc}`);
    expect(out.map((d) => doc.slice(d.from, d.to))).toEqual(['FRM']);
  });
});
