import { describe, expect, it } from 'vitest';
import { completionCandidates, referencedDatabases, resolveTable, type Candidate } from '@shared/completion';
import { getDialect } from '@shared/dialects/registry';
import { allTables } from '@shared/dialects/scope';
import type { Engine } from '@shared/model';
import type { SchemaColumn, SchemaTable, SchemaTree } from '@shared/results';

const col = (name: string, type = 'int', key?: SchemaColumn['key']): SchemaColumn => ({ name, type, nullable: true, ...(key ? { key } : {}) });
const table = (name: string, columns: SchemaColumn[], type: SchemaTable['type'] = 'table'): SchemaTable => ({ name, type, columns });

const tree: SchemaTree = {
  databases: [
    {
      name: 'shop',
      tables: [
        table('cards', [col('id', 'int', 'PRI'), col('status', 'varchar(20)'), col('company_id'), col('created_at', 'datetime')]),
        table('companies', [col('id', 'int', 'PRI'), col('name', 'varchar(80)'), col('national_id', 'varchar(14)')]),
        table('v_cards', [col('id'), col('status', 'varchar(20)')], 'view'),
        table('Orders', [col('id', 'int', 'PRI'), col('total', 'decimal(10,2)')]),
      ],
    },
    { name: 'loja', tables: [table('users', [col('id', 'int', 'PRI'), col('login', 'varchar(40)')])] },
  ],
};
const words = { table: 'tabela', view: 'view', database: 'banco' };

function offer(marked: string, options: { engine?: Engine; tree?: SchemaTree | undefined; database?: string | null } = {}): Candidate[] {
  const offset = marked.indexOf('|');
  const sql = offset === -1 ? marked : marked.slice(0, offset) + marked.slice(offset + 1);
  const dialect = getDialect(options.engine ?? 'mysql');
  return completionCandidates({
    tree: 'tree' in options ? options.tree : tree,
    database: 'database' in options ? options.database! : 'shop',
    analysis: dialect.analyze(sql),
    offset,
    words,
  });
}
const labels = (list: Candidate[], kind?: Candidate['kind']): string[] => list.filter((c) => !kind || c.kind === kind).map((c) => c.label);
const top = (list: Candidate[]): Candidate[] => {
  const best = Math.max(...list.map((c) => c.boost));
  return list.filter((c) => c.boost === best);
};

describe('unqualified columns', () => {
  it('the columns of the table of the FROM, where the library offered none', () => {
    const list = offer('SELECT * FROM cards WHERE sta|');
    expect(labels(list, 'column')).toEqual(['id', 'status', 'company_id', 'created_at']);
    expect(list.find((c) => c.label === 'status')).toMatchObject({ detail: 'varchar(20)', parts: ['status'], kind: 'column' });
    expect(list.find((c) => c.label === 'id')!.detail).toBe('int · PK');
  });

  it('also when the FROM is after the cursor', () => {
    expect(labels(offer('SELECT sta| FROM cards'), 'column')).toContain('status');
    expect(labels(offer('SELECT | FROM cards c JOIN companies co ON co.id = c.company_id'), 'column')).toContain('national_id');
  });

  it('no fallback to the other tables of the database', () => {
    expect(labels(offer('SELECT | FROM'), 'column')).toEqual([]);
    expect(labels(offer('SELECT |'), 'column')).toEqual([]);
    expect(labels(offer('SELECT | FROM unknown_table'), 'column')).toEqual([]);
    // the columns of a table that is not in this statement stay out
    expect(labels(offer('SELECT * FROM cards WHERE |'), 'column')).not.toContain('national_id');
  });

  it('a column of two joined tables is one option per table, qualified, with the table in the detail', () => {
    const list = offer('SELECT * FROM cards c JOIN companies co ON co.id = c.company_id WHERE |');
    const ids = list.filter((c) => c.kind === 'column' && c.label === 'id');
    expect(ids.map((c) => c.parts)).toEqual([['c', 'id'], ['co', 'id']]);
    expect(ids.map((c) => c.detail)).toEqual(['c · int', 'co · int']);
    // the columns only one of them has stay plain
    expect(list.find((c) => c.label === 'national_id')!.parts).toEqual(['national_id']);
    expect(list.find((c) => c.label === 'status')!.parts).toEqual(['status']);
  });

  it('without an alias the table name qualifies; a self-join qualifies by alias', () => {
    const list = offer('SELECT * FROM cards JOIN v_cards ON 1 WHERE |');
    expect(list.filter((c) => c.label === 'id').map((c) => c.parts)).toEqual([['cards', 'id'], ['v_cards', 'id']]);
    const self = offer('SELECT * FROM cards a JOIN cards b ON 1 WHERE |');
    expect(self.filter((c) => c.label === 'status').map((c) => c.parts)).toEqual([['a', 'status'], ['b', 'status']]);
  });

  it('matches names without telling cases apart when only one table fits', () => {
    expect(labels(offer('SELECT * FROM CARDS WHERE |'), 'column')).toContain('status');
    expect(labels(offer('SELECT * FROM orders WHERE |'), 'column')).toContain('total');
    // a name the schema has twice, in two cases, is not guessed
    const twice: SchemaTree = { databases: [{ name: 'shop', tables: [table('Cards', [col('a')]), table('cards', [col('b')])] }] };
    expect(labels(offer('SELECT * FROM CARDS WHERE |', { tree: twice }), 'column')).toEqual([]);
    expect(labels(offer('SELECT * FROM cards WHERE |', { tree: twice }), 'column')).toEqual(['b']);
  });

  it('tables of another database by their path, tables of the current database by their name', () => {
    expect(labels(offer('SELECT * FROM loja.users u WHERE |'), 'column')).toEqual(['id', 'login']);
    expect(labels(offer('SELECT * FROM users WHERE |'), 'column')).toEqual([]);
    expect(labels(offer('SELECT * FROM users WHERE |', { database: 'loja' }), 'column')).toEqual(['id', 'login']);
    expect(labels(offer('SELECT * FROM cards WHERE |', { database: null }), 'column')).toEqual([]);
  });

  it('UPDATE, DELETE and INSERT complete the columns of their table', () => {
    expect(labels(offer('UPDATE cards SET | = 1'), 'column')).toContain('status');
    expect(labels(offer('UPDATE cards x SET x.status = 1, | = 2'), 'column')).toContain('company_id');
    expect(labels(offer('DELETE FROM cards WHERE |'), 'column')).toContain('status');
    expect(labels(offer('INSERT INTO cards (|) VALUES (1)'), 'column')).toContain('status');
  });

  it('a subquery offers its own tables first and the query around it after', () => {
    const list = offer('SELECT * FROM cards WHERE company_id IN (SELECT id FROM companies WHERE |)');
    const own = list.find((c) => c.label === 'national_id')!;
    const outer = list.find((c) => c.label === 'status')!;
    expect(own.boost).toBeGreaterThan(outer.boost);
    // an `id` both have is qualified, the inner one first
    expect(list.filter((c) => c.label === 'id').map((c) => c.parts)).toEqual([['companies', 'id'], ['cards', 'id']]);
    // a derived table does not see the query around it
    expect(labels(offer('SELECT * FROM cards, (SELECT id FROM companies WHERE |) d'), 'column')).not.toContain('status');
  });

  it('a CTE name has no columns to offer, and its body completes from its own tables', () => {
    expect(labels(offer('WITH w AS (SELECT * FROM cards) SELECT | FROM w'), 'column')).toEqual([]);
    expect(labels(offer('WITH w AS (SELECT * FROM cards WHERE |) SELECT * FROM w'), 'column')).toContain('status');
  });

  it('nothing while the schema has not loaded', () => {
    expect(offer('SELECT * FROM cards WHERE |', { tree: undefined })).toEqual([]);
  });
});

describe('what comes first', () => {
  it('after FROM the tables of the current database, then the databases', () => {
    const list = offer('SELECT * FROM |');
    expect(labels(top(list))).toEqual(['cards', 'companies', 'v_cards', 'Orders']);
    expect(list.filter((c) => c.kind === 'database').map((c) => [c.label, c.detail])).toEqual([['shop', 'banco'], ['loja', 'banco']]);
    expect(Math.max(...list.filter((c) => c.kind === 'database').map((c) => c.boost))).toBeLessThan(top(list)[0]!.boost);
    expect(list.find((c) => c.label === 'v_cards')).toMatchObject({ kind: 'view', detail: 'view' });
    expect(list.find((c) => c.label === 'cards')).toMatchObject({ kind: 'table', detail: 'tabela' });
    expect(list.some((c) => c.kind === 'column')).toBe(false);
  });

  it('after WHERE the columns, then the names of the statement, then the tables', () => {
    const list = offer('SELECT * FROM cards c WHERE |');
    expect(new Set(top(list).map((c) => c.kind))).toEqual(new Set(['column']));
    const alias = list.find((c) => c.kind === 'alias')!;
    expect(alias).toMatchObject({ label: 'c', detail: 'cards' });
    const column = list.find((c) => c.label === 'status')!;
    const tableOption = list.find((c) => c.kind === 'table' && c.label === 'companies')!;
    expect(column.boost).toBeGreaterThan(alias.boost);
    expect(alias.boost).toBeGreaterThan(tableOption.boost);
  });

  it('where neither is next (a keyword is) the tables stay at the bottom', () => {
    const list = offer('SELECT * FROM cards |');
    expect(list.every((c) => c.boost < 0)).toBe(true);
    expect(list.some((c) => c.kind === 'column')).toBe(false);
  });
});

describe('a table of the statement', () => {
  it('is offered once in a column position, whatever it was written with', () => {
    const list = offer('SELECT * FROM cards WHERE |');
    expect(list.filter((c) => c.label === 'cards')).toHaveLength(1);
    // the other tables of the database stay, low
    expect(list.find((c) => c.label === 'companies')!.boost).toBeLessThan(0);
  });
});

describe('after a dot', () => {
  it('an alias, a table of the statement, a table of the database: their columns', () => {
    expect(labels(offer('SELECT * FROM cards c WHERE c.|')).slice(0, 4)).toEqual(['id', 'status', 'company_id', 'created_at']);
    expect(labels(offer('SELECT * FROM cards WHERE cards.|'))).toContain('status');
    expect(labels(offer('SELECT * FROM cards WHERE companies.|'))).toContain('national_id');
    expect(labels(offer('SELECT * FROM cards c WHERE C.|'))).toContain('status');
  });

  it('the alias of an UPDATE (the library did not read it)', () => {
    expect(labels(offer('UPDATE cards x SET x.|'))).toContain('status');
    expect(labels(offer('UPDATE cards x JOIN companies co ON co.id = x.company_id SET co.|'))).toContain('national_id');
  });

  it('a database: its tables; a database and a table: its columns', () => {
    expect(labels(offer('SELECT * FROM loja.|'))).toEqual(['users']);
    expect(labels(offer('SELECT * FROM shop.|'))).toEqual(['cards', 'companies', 'v_cards', 'Orders']);
    expect(labels(offer('SELECT loja.users.|'))).toEqual(['id', 'login']);
    expect(labels(offer('SELECT SHOP.CARDS.|'))).toContain('status');
  });

  it('what is not in the schema offers nothing', () => {
    expect(offer('SELECT nope.|')).toEqual([]);
    expect(offer('SELECT shop.nope.|')).toEqual([]);
    expect(offer('SELECT w.| FROM (SELECT 1 AS a) w')).toEqual([]);
  });

  it('an alias of the outer query inside a subquery', () => {
    expect(labels(offer('SELECT * FROM cards c WHERE EXISTS (SELECT 1 FROM companies co WHERE co.id = c.|)'))).toContain('company_id');
  });
});

describe('BigQuery', () => {
  const bq: SchemaTree = {
    databases: [
      { name: 'vendas', tables: [table('pedidos', [col('id', 'INT64'), col('valor', 'NUMERIC')]), table('eventos', [col('id', 'INT64'), col('tipo', 'STRING')])] },
      { name: 'logs', tables: [table('acessos', [col('ip', 'STRING')])] },
    ],
  };
  const bigquery = (marked: string, database: string | null = null) => offer(marked, { engine: 'bigquery', tree: bq, database });

  it('columns of dataset.table, of a backticked path (project dropped), of the default dataset', () => {
    expect(labels(bigquery('SELECT * FROM vendas.pedidos WHERE |'), 'column')).toEqual(['id', 'valor']);
    expect(labels(bigquery('SELECT * FROM `meu-projeto.vendas.pedidos` p WHERE |'), 'column')).toEqual(['id', 'valor']);
    expect(labels(bigquery('SELECT * FROM `vendas.pedidos` WHERE |'), 'column')).toEqual(['id', 'valor']);
    expect(labels(bigquery('SELECT * FROM pedidos WHERE |', 'vendas'), 'column')).toEqual(['id', 'valor']);
    expect(labels(bigquery('SELECT * FROM pedidos WHERE |', null), 'column')).toEqual([]);
  });

  it('a dataset and a table of two datasets that share a column name: qualified', () => {
    const list = bigquery('SELECT | FROM vendas.pedidos p JOIN vendas.eventos e USING (id)');
    expect(list.filter((c) => c.label === 'id').map((c) => c.parts)).toEqual([['p', 'id'], ['e', 'id']]);
    expect(labels(list, 'column')).toContain('tipo');
  });

  it('the path inside backticks completes by parts', () => {
    expect(labels(bigquery('SELECT * FROM `vendas.|`'))).toEqual(['pedidos', 'eventos']);
    expect(labels(bigquery('SELECT * FROM `vendas.pedidos.|`'))).toEqual(['id', 'valor']);
  });

  it('a full path with the project: after `project.dataset.` come the dataset\'s tables, the project dropped', () => {
    expect(labels(bigquery('SELECT * FROM `meu-projeto.vendas.|`'))).toEqual(['pedidos', 'eventos']);
    expect(labels(bigquery('SELECT * FROM `meu-projeto.vendas.pe|`'))).toEqual(['pedidos', 'eventos']);
    expect(labels(bigquery('SELECT * FROM meu-projeto.vendas.|'))).toEqual(['pedidos', 'eventos']);
    expect(labels(bigquery('SELECT * FROM `meu-projeto`.`vendas`.|'))).toEqual(['pedidos', 'eventos']);
    expect(labels(bigquery('SELECT * FROM proj.vendas.|'))).toEqual(['pedidos', 'eventos']);
    // a table after the project: its columns
    expect(labels(bigquery('SELECT * FROM `meu-projeto.vendas.pedidos.|`'))).toEqual(['id', 'valor']);
    expect(labels(bigquery('SELECT * FROM `meu-projeto.nada.|`'))).toEqual([]);
  });
});

describe('the datasets a statement names', () => {
  const bq: SchemaTree = { databases: [{ name: 'vendas', tables: [] }, { name: 'Logs', tables: [] }] };
  it('by path, by backticked path and by the default dataset, as the tree spells them', () => {
    const refs = allTables(getDialect('bigquery').analyze('SELECT * FROM vendas.a JOIN `proj.logs.b` ON 1 JOIN c ON 1 JOIN other.d ON 1'));
    expect(referencedDatabases(bq, 'vendas', refs).sort()).toEqual(['Logs', 'vendas']);
    expect(referencedDatabases(bq, null, refs).sort()).toEqual(['Logs', 'vendas']);
    expect(referencedDatabases(undefined, 'vendas', refs)).toEqual([]);
  });
});

describe('resolving a table', () => {
  it('by path or by the current database', () => {
    expect(resolveTable(tree, 'shop', ['cards'])?.database).toBe('shop');
    expect(resolveTable(tree, 'shop', ['loja', 'users'])?.table.name).toBe('users');
    expect(resolveTable(tree, null, ['cards'])).toBeUndefined();
    expect(resolveTable(tree, 'shop', ['nope'])).toBeUndefined();
  });
});
