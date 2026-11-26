import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { sql, SQLDialect } from '@codemirror/lang-sql';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import type { Engine } from '@shared/model';
import type { SchemaTree } from '@shared/results';
import { CODEMIRROR_DIALECTS } from '../../src/renderer/lib/codemirrorDialects';
import { schemaCompletion, statementAround } from '../../src/renderer/lib/completion';

const tree: SchemaTree = {
  databases: [
    {
      name: 'shop',
      tables: [
        { name: 'cards', type: 'table', columns: [{ name: 'id', type: 'int', nullable: false, key: 'PRI' }, { name: 'status', type: 'varchar(20)', nullable: true }, { name: 'order', type: 'int', nullable: true }, { name: 'created at', type: 'datetime', nullable: true }] },
        { name: 'we`ird', type: 'table', columns: [{ name: 'x', type: 'int', nullable: true }] },
        { name: 'companies', type: 'table', columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'text', nullable: true }] },
      ],
    },
  ],
};
const words = { table: 'tabela', view: 'view', database: 'banco' };

/** The state the editor builds (the language plus the schema source), with the cursor where the `|` is. */
function stateOf(marked: string, engine: Engine = 'mysql'): { state: EditorState; pos: number } {
  const dialect = getDialect(engine);
  const base = CODEMIRROR_DIALECTS[dialect.codemirrorDialect];
  const withKeywords = SQLDialect.define({ ...base.spec, keywords: `${base.spec.keywords ?? ''} ${dialect.keywords.join(' ').toLowerCase()}` });
  const source = schemaCompletion({ dialect, tree, database: 'shop', words });
  const pos = marked.indexOf('|');
  const state = EditorState.create({
    doc: pos === -1 ? marked : marked.slice(0, pos) + marked.slice(pos + 1),
    extensions: [sql({ dialect: withKeywords, upperCaseKeywords: true }), withKeywords.language.data.of({ autocomplete: source })],
  });
  return { state, pos };
}

/** What every source of the language answers at the cursor, merged: the schema one and the keywords one. */
async function ask(marked: string, explicit = false, engine: Engine = 'mysql'): Promise<{ from: number; options: CompletionResult['options'] } | null> {
  const { state, pos } = stateOf(marked, engine);
  const results: CompletionResult[] = [];
  for (const source of state.languageDataAt<(c: CompletionContext) => CompletionResult | null | Promise<CompletionResult | null>>('autocomplete', pos)) {
    const r = await source(new CompletionContext(state, pos, explicit));
    if (r) results.push(r);
  }
  if (results.length === 0) return null;
  return { from: results[0]!.from, options: results.flatMap((r) => r.options) };
}
const names = (r: { options: readonly { label: string }[] } | null): string[] => (r ? r.options.map((o) => o.label) : []);

describe('the schema source on an editor state', () => {
  it('columns of the FROM where the library alone gave only keywords', async () => {
    const r = await ask('SELECT * FROM cards WHERE sta|');
    expect(r!.from).toBe('SELECT * FROM cards WHERE '.length);
    const status = r!.options.find((o) => o.label === 'status')!;
    expect(status).toMatchObject({ type: 'property', detail: 'varchar(20)' });
    expect(names(r)).toContain('SELECT');
  });

  it('after a dot, with nothing typed yet', async () => {
    const r = await ask('SELECT * FROM cards c WHERE c.|');
    expect(names(r)).toContain('status');
    expect(r!.from).toBe('SELECT * FROM cards c WHERE c.'.length);
  });

  it('no list for no word, unless asked for', async () => {
    expect(await ask('SELECT * FROM cards WHERE |')).toBeNull();
    expect(names(await ask('SELECT * FROM cards WHERE |', true))).toContain('status');
  });

  it('quotes a name that is not a plain word, and a word the language reserves', async () => {
    const r = await ask('SELECT * FROM cards WHERE |', true);
    expect(r!.options.find((o) => o.label === 'created at')).toMatchObject({ apply: '`created at`' });
    expect(r!.options.find((o) => o.label === 'order')).toMatchObject({ apply: '`order`' });
    expect(r!.options.find((o) => o.label === 'status')!.apply).toBeUndefined();
    const tables = await ask('SELECT * FROM we|');
    expect(tables!.options.find((o) => o.label === 'we`ird')).toMatchObject({ apply: '`we``ird`' });
  });

  it('a qualified column of two tables is inserted with its qualifier', async () => {
    const r = await ask('SELECT i| FROM cards c JOIN companies co ON 1');
    const ids = r!.options.filter((o) => o.label === 'id');
    expect(ids.map((o) => o.apply)).toEqual(['c.id', 'co.id']);
    expect(ids.map((o) => o.detail)).toEqual(['c · int', 'co · int']);
  });

  it('inside backticks the name goes in without its own quotes, and the closing quote is added only when missing', async () => {
    const open = await ask('SELECT * FROM `ca|');
    expect(open!.from).toBe('SELECT * FROM `'.length);
    expect(open!.options.find((o) => o.label === 'cards')).toMatchObject({ apply: 'cards`' });
    const closed = await ask('SELECT * FROM `ca|`');
    expect(closed!.options.find((o) => o.label === 'cards')!.apply).toBeUndefined();
    const escaped = await ask('SELECT * FROM `we|');
    expect(escaped!.options.find((o) => o.label === 'we`ird')).toMatchObject({ apply: 'we``ird`' });
  });

  it('not in a string, a comment or a quoted text', async () => {
    expect(names(await ask("SELECT 'sta|' FROM cards"))).not.toContain('status');
    expect(names(await ask('SELECT * FROM cards -- sta|'))).not.toContain('status');
    expect(names(await ask('SELECT * FROM cards /* sta| */'))).not.toContain('status');
  });

  it('the statement of the cursor decides, not the whole script', async () => {
    const r = await ask('SELECT * FROM companies;\nSELECT * FROM cards WHERE sta|;\nSELECT * FROM companies');
    expect(names(r)).toContain('status');
    expect(names(r)).not.toContain('name');
  });

  it('a cursor after the delimiter starts a new statement', async () => {
    const r = await ask('SELECT * FROM cards; sta|');
    expect(names(r)).not.toContain('status');
    expect(names(r)).toContain('START');
  });

  it('a cursor in the blanks after the last word still belongs to the statement', async () => {
    expect(names(await ask('SELECT * FROM cards WHERE   |', true))).toContain('status');
    expect(names(await ask('SELECT * FROM cards WHERE\n  |', true))).toContain('status');
  });

  it('a statement with a DELIMITER block around reads the statement of the cursor', async () => {
    const r = await ask('DELIMITER $$\nSELECT * FROM cards WHERE sta|$$\nDELIMITER ;');
    expect(names(r)).toContain('status');
  });

  it('BigQuery: the same source, its own rules for names', async () => {
    const r = await ask('SELECT * FROM shop.cards WHERE sta|', false, 'bigquery');
    expect(names(r)).toContain('status');
    const quoted = await ask('SELECT * FROM `shop.ca|', false, 'bigquery');
    expect(quoted!.options.find((o) => o.label === 'cards')).toMatchObject({ apply: 'cards`' });
    expect(quoted!.from).toBe('SELECT * FROM `shop.'.length);
    // a full path with the project: the dataset's tables, typed or not
    const path = await ask('SELECT * FROM `meu-projeto.shop.|`', false, 'bigquery');
    expect(names(path)).toEqual(expect.arrayContaining(['cards', 'companies']));
    expect(path!.from).toBe('SELECT * FROM `meu-projeto.shop.'.length);
    const typed = await ask('SELECT * FROM `meu-projeto.shop.ca|', false, 'bigquery');
    expect(typed!.options.find((o) => o.label === 'cards')).toMatchObject({ apply: 'cards`' });
  });
});

describe('the statement the cursor is typing in', () => {
  const dialect = getDialect('mysql');
  const around = (marked: string) => {
    const { state, pos } = stateOf(marked);
    return statementAround(state, dialect, pos);
  };
  it('inside, in the blanks before the delimiter and at the end', () => {
    expect(around('SELECT 1|; SELECT 2')).toMatchObject({ text: 'SELECT 1', start: 0 });
    expect(around('SELECT 1 |; SELECT 2')).toMatchObject({ start: 0 });
    expect(around('SELECT 1; SELECT 2|')).toMatchObject({ text: 'SELECT 2', start: 10 });
    expect(around('SELECT 1; SELECT 2  |')).toMatchObject({ text: 'SELECT 2  ', start: 10 });
  });
  it('none after the delimiter, before the first statement, or in an empty document', () => {
    expect(around('SELECT 1;| SELECT 2')).toBeNull();
    expect(around('SELECT 1;\n\n|\nSELECT 2')).toBeNull();
    expect(around('|')).toBeNull();
    expect(around('  |  SELECT 1')).toBeNull();
  });
});
