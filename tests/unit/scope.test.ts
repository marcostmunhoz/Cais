import { describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import { allTables, completionContext, tablesAt } from '@shared/dialects/scope';
import type { Engine } from '@shared/model';

/** Reads `sql` with `|` standing for the cursor and returns what the position sees. */
function at(engine: Engine, marked: string) {
  const offset = marked.indexOf('|');
  const sql = marked.replace('|', '');
  const analysis = getDialect(engine).analyze(sql);
  const visible = tablesAt(analysis, offset).map((v) => `${v.depth}:${v.ref.path.join('.')}${v.ref.alias ? ` ${v.ref.alias}` : ''}`);
  return { visible, context: completionContext(analysis, offset), all: allTables(analysis).map((r) => r.path.join('.')) };
}
const mysql = (marked: string) => at('mysql', marked);
const bigquery = (marked: string) => at('bigquery', marked);

describe('tables a MySQL position sees', () => {
  it('reads FROM and JOIN with aliases, with and without AS, and paths', () => {
    expect(mysql('SELECT * FROM cards c JOIN loja.users AS u ON u.id = c.uid WHERE |').visible).toEqual(['0:cards c', '0:loja.users u']);
    expect(mysql('SELECT * FROM `cais_test`.`cards` WHERE |').visible).toEqual(['0:cais_test.cards']);
    expect(mysql('SELECT * FROM `we``ird` `a b` WHERE |').visible).toEqual(['0:we`ird a b']);
    expect(mysql('SELECT * FROM a, b bb, c AS cc WHERE |').visible).toEqual(['0:a', '0:b bb', '0:c cc']);
  });

  it('sees the tables after the cursor too', () => {
    expect(mysql('SELECT na| FROM cards c LEFT JOIN users u USING (id)').visible).toEqual(['0:cards c', '0:users u']);
    expect(mysql('SELECT | FROM cards').visible).toEqual(['0:cards']);
  });

  it('every join keyword leads to a table, whatever the modifiers', () => {
    expect(mysql('SELECT * FROM a LEFT OUTER JOIN b ON a.x = b.x NATURAL JOIN c STRAIGHT_JOIN d CROSS JOIN e WHERE |').visible).toEqual([
      '0:a', '0:b', '0:c', '0:d', '0:e',
    ]);
  });

  it('does not take the alias for a keyword of the clause that follows', () => {
    expect(mysql('SELECT * FROM cards WHERE |').visible).toEqual(['0:cards']);
    expect(mysql('SELECT * FROM cards ORDER BY |').visible).toEqual(['0:cards']);
    expect(mysql('SELECT * FROM cards LIMIT 5 OFFSET 1 FOR UPDATE |').visible).toEqual(['0:cards']);
    expect(mysql('SELECT * FROM cards USE INDEX (i) WHERE |').visible).toEqual(['0:cards']);
    expect(mysql('SELECT * FROM cards PARTITION (p0) x WHERE |').visible).toEqual(['0:cards']);
  });

  it('a subquery sees its own tables first, then the query around it', () => {
    expect(mysql('SELECT * FROM t1 WHERE a IN (SELECT x FROM t2 WHERE |)').visible).toEqual(['0:t2', '1:t1']);
    expect(mysql('SELECT * FROM t1 WHERE a IN (SELECT x FROM t2) AND |').visible).toEqual(['0:t1']);
    expect(mysql('SELECT * FROM t1 WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.a = t1.a AND (b = 1 OR |))').visible).toEqual(['0:t2', '1:t1']);
  });

  it('a derived table and a CTE body do not see the query around them', () => {
    expect(mysql('SELECT * FROM (SELECT a FROM t1 WHERE |) d JOIN t3 ON 1').visible).toEqual(['0:t1']);
    expect(mysql('WITH w AS (SELECT a FROM t1 WHERE |) SELECT * FROM w JOIN t2 ON 1').visible).toEqual(['0:t1']);
    // the outer query reads the CTE's name as a table (it has no columns to complete from)
    expect(mysql('WITH w AS (SELECT a FROM t1) SELECT | FROM w JOIN t2 ON 1').visible).toEqual(['0:w', '0:t2']);
    expect(mysql('SELECT * FROM t1, LATERAL (SELECT 1 FROM t2 WHERE |) x').visible).toEqual(['0:t2', '1:t1']);
  });

  it('the arms of a UNION are apart', () => {
    expect(mysql('SELECT a FROM t1 UNION SELECT a FROM t2 WHERE |').visible).toEqual(['0:t2']);
    expect(mysql('SELECT a FROM t1 WHERE | UNION SELECT a FROM t2').visible).toEqual(['0:t1']);
    expect(mysql('(SELECT a FROM t1) UNION ALL (SELECT a FROM t2 WHERE |)').visible).toEqual(['0:t2']);
  });

  it('FROM inside a call is not a table (EXTRACT, TRIM, SUBSTRING)', () => {
    expect(mysql("SELECT EXTRACT(YEAR FROM d), TRIM(BOTH ' ' FROM s), SUBSTRING(s FROM 2) FROM t WHERE |").visible).toEqual(['0:t']);
    expect(mysql('SELECT a IS NOT DISTINCT FROM b FROM t WHERE |').visible).toEqual(['0:t']);
  });

  it('UPDATE reads its target with the alias, and the joined tables', () => {
    expect(mysql('UPDATE cards x SET x.status = 1 WHERE |').visible).toEqual(['0:cards x']);
    expect(mysql('UPDATE cards SET | = 1').visible).toEqual(['0:cards']);
    expect(mysql('UPDATE LOW_PRIORITY IGNORE t1 a JOIN t2 b ON a.id = b.id SET |').visible).toEqual(['0:t1 a', '0:t2 b']);
    expect(mysql('UPDATE t1, t2 SET t1.a = t2.a WHERE |').visible).toEqual(['0:t1', '0:t2']);
    expect(mysql('WITH x AS (SELECT 1) UPDATE t SET | = 1').visible).toEqual(['0:t']);
    expect(mysql('SELECT * FROM t FOR UPDATE |').visible).toEqual(['0:t']);
  });

  it('DELETE and INSERT read their target', () => {
    expect(mysql('DELETE FROM cards WHERE |').visible).toEqual(['0:cards']);
    expect(mysql('DELETE x FROM cards x JOIN u ON u.id = x.id WHERE |').visible).toEqual(['0:cards x', '0:u']);
    expect(mysql('DELETE FROM a USING a JOIN b ON a.id = b.id WHERE |').visible).toEqual(['0:a', '0:a', '0:b']);
    expect(mysql('INSERT INTO cards (|) VALUES (1)').visible).toEqual(['0:cards']);
    expect(mysql('INSERT IGNORE INTO `db`.`cards` SET |').visible).toEqual(['0:db.cards']);
    expect(mysql('REPLACE INTO cards (|)').visible).toEqual(['0:cards']);
    expect(mysql('INSERT INTO cards (a) VALUES (1) ON DUPLICATE KEY UPDATE |').visible).toEqual(['0:cards']);
    // INSERT ... SELECT: the columns list sees the target, the query its own tables
    expect(mysql('INSERT INTO t1 (|) SELECT a FROM t2').visible).toEqual(['0:t1']);
    expect(mysql('INSERT INTO t1 (a) SELECT | FROM t2').visible).toEqual(['0:t2']);
  });

  it('functions and verbs that look like tables are left out', () => {
    expect(mysql("SELECT REPLACE(a, 'x', 'y') FROM t WHERE |").visible).toEqual(['0:t']);
    expect(mysql('SELECT * FROM t, JSON_TABLE(t.j, "$[*]" COLUMNS (a INT PATH "$.a")) jt WHERE |').visible).toEqual(['0:t']);
    expect(mysql('SHOW COLUMNS FROM t FROM db').all).toEqual([]);
    expect(mysql('CREATE TRIGGER x BEFORE UPDATE ON t FOR EACH ROW SET NEW.a = |').all).toEqual([]);
  });

  it('text in strings, comments and executable comments', () => {
    expect(mysql("SELECT 'FROM nope' FROM real -- FROM no\n WHERE |").visible).toEqual(['0:real']);
    expect(mysql('SELECT * FROM /* FROM no */ t WHERE |').visible).toEqual(['0:t']);
    expect(mysql('SELECT /*!50000 * */ FROM t WHERE |').visible).toEqual(['0:t']);
  });

  it('an unfinished statement still gives its tables', () => {
    expect(mysql('SELECT * FROM cards c WHERE c.status = 1 AND |').visible).toEqual(['0:cards c']);
    expect(mysql('SELECT * FROM cards c JOIN |').visible).toEqual(['0:cards c']);
    expect(mysql('SELECT * FROM cards c WHERE (a = 1 OR (|').visible).toEqual(['0:cards c']);
    expect(mysql('').visible).toEqual([]);
  });

  it('the same table twice keeps both aliases (self-join)', () => {
    expect(mysql('SELECT * FROM emp a JOIN emp b ON b.boss = a.id WHERE |').visible).toEqual(['0:emp a', '0:emp b']);
  });
});

describe('tables a BigQuery position sees', () => {
  it('reads dataset.table, backticked paths and drops the project', () => {
    expect(bigquery('SELECT * FROM vendas.pedidos p WHERE |').visible).toEqual(['0:vendas.pedidos p']);
    expect(bigquery('SELECT * FROM `meu-projeto.vendas.pedidos` AS p WHERE |').visible).toEqual(['0:vendas.pedidos p']);
    expect(bigquery('SELECT * FROM `vendas`.`pedidos` WHERE |').visible).toEqual(['0:vendas.pedidos']);
    expect(bigquery('SELECT * FROM `vendas.pedidos` p JOIN `logs.acessos` a ON 1 WHERE |').visible).toEqual(['0:vendas.pedidos p', '0:logs.acessos a']);
    expect(bigquery('SELECT * FROM pedidos WHERE |').visible).toEqual(['0:pedidos']);
  });

  it('keeps UNNEST and table functions out of the list and still reads what comes before', () => {
    expect(bigquery('SELECT * FROM vendas.pedidos p, UNNEST(p.tags) AS tag WHERE |').visible).toEqual(['0:vendas.pedidos p']);
  });

  it('lists the tables of the whole statement, for the datasets it names', () => {
    const { all } = bigquery('WITH w AS (SELECT * FROM vendas.pedidos) SELECT * FROM w JOIN `logs.acessos` ON 1 WHERE |');
    expect([...all].sort()).toEqual(['logs.acessos', 'vendas.pedidos', 'w']);
  });

  it('subqueries and CTEs are scoped like in MySQL', () => {
    expect(bigquery('SELECT * FROM a.t1 WHERE x IN (SELECT y FROM a.t2 WHERE |)').visible).toEqual(['0:a.t2', '1:a.t1']);
    expect(bigquery('WITH w AS (SELECT * FROM a.t1 WHERE |) SELECT * FROM w').visible).toEqual(['0:a.t1']);
  });
});

describe('what a position is typing and waiting for', () => {
  it('a word being typed, with where it starts', () => {
    const { context } = mysql('SELECT * FROM cards WHERE sta|');
    expect(context).toMatchObject({ qualifier: [], typed: 'sta', from: 26, expects: 'column' });
  });

  it('after a dot: the names before it', () => {
    expect(mysql('SELECT c.sta| FROM cards c').context).toMatchObject({ qualifier: ['c'], typed: 'sta', expects: 'column' });
    expect(mysql('SELECT c.| FROM cards c').context).toMatchObject({ qualifier: ['c'], typed: '' });
    expect(mysql('SELECT * FROM loja.cards.| ').context).toMatchObject({ qualifier: ['loja', 'cards'] });
    expect(mysql('SELECT * FROM `loja`.|').context).toMatchObject({ qualifier: ['loja'], expects: 'column' });
  });

  it('after a table word the next name is a table, after a clause word a column', () => {
    expect(mysql('SELECT * FROM |').context.expects).toBe('table');
    expect(mysql('SELECT * FROM car|').context.expects).toBe('table');
    expect(mysql('SELECT * FROM a JOIN |').context.expects).toBe('table');
    expect(mysql('SELECT * FROM a, |').context.expects).toBe('table');
    expect(mysql('UPDATE |').context.expects).toBe('table');
    expect(mysql('INSERT INTO |').context.expects).toBe('table');
    expect(mysql('DELETE FROM |').context.expects).toBe('table');
    expect(mysql('SELECT * FROM a WHERE |').context.expects).toBe('column');
    expect(mysql('SELECT * FROM a WHERE x = 1 AND |').context.expects).toBe('column');
    expect(mysql('SELECT * FROM a WHERE x = |').context.expects).toBe('column');
    expect(mysql('SELECT |').context.expects).toBe('column');
    expect(mysql('SELECT a, |').context.expects).toBe('column');
    expect(mysql('SELECT * FROM a GROUP BY b, |').context.expects).toBe('column');
    expect(mysql('SELECT COUNT(|').context.expects).toBe('column');
    expect(mysql('UPDATE t SET a = 1, |').context.expects).toBe('column');
    expect(mysql('SELECT * FROM a JOIN b ON |').context.expects).toBe('column');
  });

  it('after a finished name the next word is a keyword or an alias, and at the start of a statement too', () => {
    expect(mysql('SELECT * FROM cards |').context.expects).toBe('any');
    expect(mysql('SELECT * FROM cards c |').context.expects).toBe('any');
    expect(mysql('SEL|').context.expects).toBe('any');
    expect(mysql('SELECT 1; |').context.expects).toBe('any');
    expect(mysql('SELECT * FROM (SELECT 1) |').context.expects).toBe('any');
  });

  it('inside a backtick name the text typed after the quote is what is completed', () => {
    expect(mysql('SELECT * FROM `ca|').context).toMatchObject({ typed: 'ca', from: 15, quote: { char: '`', closed: false }, expects: 'table' });
    expect(mysql('SELECT * FROM `ca|rds`').context).toMatchObject({ typed: 'ca', quote: { char: '`', closed: true } });
    // after the closing quote the name is finished
    expect(mysql('SELECT * FROM `cards`|').context).toMatchObject({ typed: '', quote: null });
  });

  it('a BigQuery path in backticks completes its last part, the parts before it are the qualifier', () => {
    expect(bigquery('SELECT * FROM `vendas.ped|').context).toMatchObject({ qualifier: ['vendas'], typed: 'ped', from: 22, quote: { closed: false } });
    expect(bigquery('SELECT * FROM `meu-projeto.vendas.|`').context).toMatchObject({ qualifier: ['meu-projeto', 'vendas'], typed: '' });
    expect(bigquery('SELECT * FROM `ven|').context).toMatchObject({ qualifier: [], typed: 'ven', expects: 'table' });
  });
});
