import { describe, expect, it } from 'vitest';
import { bigqueryDialect as d, classify, identifiers, splitStatements, appendStatements, agentCodeProblem } from '@shared/dialects/bigquery';
import { lex } from '@shared/dialects/bigquery/lexer';
import { GOOGLESQL_KEYWORDS } from '@shared/dialects/bigquery/keywords';

const ro = (sql: string) => classify(sql).allowedInReadOnly;
const texts = (sql: string) => splitStatements(sql).map((s) => s.text);
const kinds = (tokens: ReturnType<typeof lex>) => tokens.map((t) => `${t.kind}:${t.text}`);

describe('lexer', () => {
  it('reads strings of every form and prefix', () => {
    const cases: [string, number][] = [
      ["'a'", 1],
      ['"a"', 1],
      ["'''a'b'''", 1],
      ['"""a"b"""', 1],
      ["r'a\\d'", 1],
      ["R'a'", 1],
      ["b'a'", 1],
      ['B"a"', 1],
      ["rb'a'", 1],
      ["bR'a'", 1],
      ['Br"""a"""', 1],
      ["'it''s'", 2], // adjacent literals, not an escaped quote
    ];
    for (const [sql, n] of cases) expect(lex(sql).filter((t) => t.kind === 'string'), sql).toHaveLength(n);
    expect(lex("'a\\'b'")).toHaveLength(1);
    expect(lex('"a\\"b"')).toHaveLength(1);
    expect(lex("'''a\\''''")).toHaveLength(1);
  });
  it('does not take a prefix glued to a longer word', () => {
    expect(kinds(lex("bar'x'"))).toEqual(['word:bar', "string:'x'"]);
    expect(kinds(lex("xr'x'"))).toEqual(['word:xr', "string:'x'"]);
  });
  it('reads raw strings with and without a backslash as an open question, under both rules', () => {
    expect(lex("r'\\''", true)).toHaveLength(1);
    expect(lex("r'\\''", false).length).toBeGreaterThan(1);
    expect(lex("r'a\\d'", false)).toHaveLength(1);
  });
  it('reads backtick names, with escapes and whole paths', () => {
    expect(lex('`a\\`b`')).toHaveLength(1);
    expect(lex('`proj.ds.t`')).toHaveLength(1);
    expect(lex('`a\\`b`', false).length).toBeGreaterThan(1);
  });
  it('reads the three comment forms; dashes need no space; block comments do not nest', () => {
    expect(kinds(lex('--x\n1'))).toEqual(['comment:--x', 'number:1']);
    expect(kinds(lex('#x\n1'))).toEqual(['comment:#x', 'number:1']);
    expect(kinds(lex('/* a /* b */ c */'))).toEqual(['comment:/* a /* b */', 'word:c', 'punct:*', 'punct:/']);
    expect(lex('-- a\r1').map((t) => t.kind)).toEqual(['comment', 'number']);
  });
  it('reads numbers, parameters and system variables', () => {
    expect(kinds(lex('0xFF 1.5e-3 .5 7. @p ? @@time_zone @@a.b'))).toEqual([
      'number:0xFF', 'number:1.5e-3', 'number:.5', 'number:7.', 'param:@p', 'punct:?', 'sysvar:@@time_zone', 'sysvar:@@a.b',
    ]);
  });
  it('marks what has no end', () => {
    expect(lex("'abc")[0]!.closed).toBe(false);
    expect(lex('/* abc')[0]!.closed).toBe(false);
    expect(lex('`abc')[0]!.closed).toBe(false);
    expect(lex("'''abc''")[0]!.closed).toBe(false);
  });
});

describe('splitStatements', () => {
  it('splits on ; outside strings, comments and names', () => {
    expect(texts("SELECT ';'; SELECT \";\"; SELECT `a;b`; -- ;\nSELECT 1 /* ; */; # ;\nSELECT 3")).toEqual([
      "SELECT ';'", 'SELECT ";"', 'SELECT `a;b`', 'SELECT 1', 'SELECT 3',
    ]);
  });
  it('keeps ; inside triple-quoted and raw strings', () => {
    expect(texts("SELECT '''a;\nb'''; SELECT r'a;b'; SELECT 1")).toHaveLength(3);
  });
  it('gives positions: start, end without the delimiter, rangeEnd with it', () => {
    const sql = '  SELECT 1 ;\n-- c\nSELECT 2';
    const [a, b] = splitStatements(sql);
    expect(a).toEqual({ text: 'SELECT 1', start: 2, end: 10, rangeEnd: 12 });
    expect(sql.slice(b!.start, b!.end)).toBe('SELECT 2');
    expect(b!.rangeEnd).toBe(sql.length);
  });
  it('ignores empty statements and comment-only text', () => {
    expect(texts(';;  ;')).toEqual([]);
    expect(texts('-- only a comment')).toEqual([]);
  });
  it('keeps every script block whole', () => {
    const blocks = [
      'BEGIN SELECT 1; SELECT 2; END',
      'BEGIN SELECT 1; EXCEPTION WHEN ERROR THEN SELECT 2; END',
      'IF TRUE THEN SELECT 1; ELSEIF FALSE THEN SELECT 2; ELSE SELECT 3; END IF',
      'LOOP SELECT 1; BREAK; END LOOP',
      'WHILE x < 3 DO SET x = x + 1; END WHILE',
      'REPEAT SET x = x + 1; UNTIL x > 3 END REPEAT',
      'FOR r IN (SELECT 1 AS a) DO SELECT r.a; END FOR',
      'CASE x WHEN 1 THEN SELECT 1; ELSE SELECT 2; END CASE',
      'l: BEGIN SELECT 1; END l',
      'BEGIN IF TRUE THEN BEGIN SELECT 1; END; END IF; SELECT 2; END',
      'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END',
      'CREATE OR REPLACE PROCEDURE ds.p(x INT64) OPTIONS(description="a") BEGIN DECLARE y INT64; SET y = x; END',
    ];
    for (const b of blocks) {
      expect(texts(`${b}; SELECT 9`), b).toEqual([b, 'SELECT 9']);
      expect(texts(b), b).toEqual([b]);
    }
  });
  it('does not open a block for transaction control', () => {
    expect(texts('BEGIN; SELECT 1; COMMIT')).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(texts('BEGIN TRANSACTION; SELECT 1; ROLLBACK TRANSACTION')).toEqual(['BEGIN TRANSACTION', 'SELECT 1', 'ROLLBACK TRANSACTION']);
    expect(texts('begin transaction;\nselect 1;\ncommit;')).toEqual(['begin transaction', 'select 1', 'commit']);
    expect(texts('BEGIN -- c\n;SELECT 1')).toEqual(['BEGIN', 'SELECT 1']);
    expect(texts('START TRANSACTION; SELECT 1')).toEqual(['START TRANSACTION', 'SELECT 1']);
  });
  it('does not open a block for CASE expressions or the IF function', () => {
    expect(texts('SELECT CASE WHEN a THEN 1 ELSE 2 END; SELECT 2')).toEqual(['SELECT CASE WHEN a THEN 1 ELSE 2 END', 'SELECT 2']);
    expect(texts('SELECT IF(a, 1, 2); SELECT 2')).toEqual(['SELECT IF(a, 1, 2)', 'SELECT 2']);
    expect(texts('SELECT CASE WHEN a THEN CASE WHEN b THEN 1 END END; SELECT 2')).toHaveLength(2);
    expect(texts('SELECT (CASE a WHEN 1 THEN 2 END); SELECT 2')).toHaveLength(2);
    expect(texts('SELECT begin, loop FROM t; SELECT 2')).toHaveLength(2);
  });
  it('handles expressions inside blocks', () => {
    const b = 'BEGIN SELECT CASE WHEN a THEN IF(b, 1, 2) ELSE 3 END; IF x THEN SELECT 1; END IF; END';
    expect(texts(`${b}; SELECT 2`)).toEqual([b, 'SELECT 2']);
  });
  it('a block that is never closed takes the rest of the text', () => {
    expect(texts('BEGIN SELECT 1; DROP TABLE x;')).toEqual(['BEGIN SELECT 1; DROP TABLE x;']);
  });
  it('is not fooled by block words in strings, names and comments', () => {
    expect(texts("SELECT 'BEGIN'; SELECT `END`; -- BEGIN\nSELECT 3")).toHaveLength(3);
    expect(texts('/* BEGIN */ SELECT 1; SELECT 2')).toHaveLength(2);
  });
  it('splits at ; even when parentheses are left open', () => {
    expect(texts('SELECT (1; SELECT 2')).toEqual(['SELECT (1', 'SELECT 2']);
  });
  it('end of statement list: a trailing statement without ; is returned', () => {
    expect(texts('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });
});

describe('appendStatements', () => {
  const apply = (doc: string, text: string) => {
    const { changes, selection } = appendStatements(doc, text);
    // all positions refer to the original text and apply together, in order (as CodeMirror does)
    let out = '';
    let at = 0;
    for (const c of changes) {
      out += doc.slice(at, c.from) + c.insert;
      at = c.from;
    }
    out += doc.slice(at);
    return { out, selected: out.slice(selection.from, selection.to) };
  };
  it('ends an unterminated statement and appends after a blank line', () => {
    const { out, selected } = apply('SELECT 1', 'SELECT 2;');
    expect(out).toBe('SELECT 1;\n\nSELECT 2;');
    expect(selected).toBe('SELECT 2;');
    expect(texts(out)).toEqual(['SELECT 1', 'SELECT 2']);
  });
  it('keeps a trailing comment out of the way', () => {
    const { out } = apply('SELECT 1 -- note', 'SELECT 2;');
    expect(texts(out)).toEqual(['SELECT 1', 'SELECT 2']);
  });
  it('does not add a second ; and handles empty and newline-ended documents', () => {
    expect(apply('SELECT 1;', 'SELECT 2;').out).toBe('SELECT 1;\n\nSELECT 2;');
    expect(apply('', 'SELECT 2;').out).toBe('SELECT 2;');
    expect(apply('SELECT 1;\n', 'SELECT 2;').out).toBe('SELECT 1;\n\nSELECT 2;');
  });
  it('ends an unterminated block statement', () => {
    expect(texts(apply('BEGIN SELECT 1; END', 'SELECT 2;').out)).toEqual(['BEGIN SELECT 1; END', 'SELECT 2']);
  });
});

describe('classify: what passes in read-only', () => {
  it.each([
    'SELECT 1',
    '  select * from `p.d.t`',
    '-- note\nSELECT 1',
    '/* c */ # d\nSELECT 1',
    'SELECT 1;',
    'SELECT 1; -- done',
    '(SELECT 1)',
    '((SELECT 1))',
    '(SELECT 1) UNION ALL (SELECT 2)',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'WITH RECURSIVE a AS (SELECT 1 UNION ALL SELECT n + 1 FROM a WHERE n < 3), b AS (SELECT 2) SELECT * FROM a',
    'WITH `x` AS (SELECT 1) (SELECT * FROM x)',
    'FROM t |> WHERE x > 1 |> SELECT x',
    'FROM `proj.ds.t` |> DROP y |> ASSERT x > 0 |> CALL f()',
    "SELECT 'DROP TABLE x; DELETE FROM y'",
    'SELECT "a;b", `c;d` FROM t',
    "SELECT '''a;\nDROP TABLE x;'''",
    "SELECT r'a;b\\d'",
    'SELECT 1 /* ; DROP TABLE x */',
    'SELECT CASE WHEN a THEN 1 END',
    'SELECT IF(a, 1, 2)',
    'SELECT @p, ?, @@time_zone',
    'SELECT 0xFF, 1e3',
    'SELECT commit, begin, update FROM t',
    'SELECT * FROM my-project.ds.t',
    'SELECT * FROM region-us.INFORMATION_SCHEMA.TABLES',
    'SELECT * FROM ds.INFORMATION_SCHEMA.COLUMNS',
    'SELECT 1 AS drop',
  ])('allows %s', (sql) => {
    const c = classify(sql);
    expect(c.allowedInReadOnly, sql).toBe(true);
    expect(c.kind).toBe('read');
    expect(c.implicitCommit).toBe(false);
    expect(c.transactionControl).toBeNull();
  });
  it('reports the verb of a query', () => {
    expect(classify('select 1').verb).toBe('SELECT');
    expect(classify('with a as (select 1) select * from a').verb).toBe('WITH');
    expect(classify('from t |> select x').verb).toBe('FROM');
    expect(classify('(select 1)').verb).toBe('SELECT');
  });
});

describe('classify: corpus by class', () => {
  const cases: [string, string, string][] = [
    // [sql, kind, verb]
    ['INSERT INTO t VALUES (1)', 'write', 'INSERT'],
    ['insert t (a) select 1', 'write', 'INSERT'],
    ['UPDATE t SET a = 1 WHERE TRUE', 'write', 'UPDATE'],
    ['DELETE FROM t WHERE TRUE', 'write', 'DELETE'],
    ['DELETE t WHERE TRUE', 'write', 'DELETE'],
    ['MERGE t USING s ON t.id = s.id WHEN MATCHED THEN DELETE', 'write', 'MERGE'],
    ['TRUNCATE TABLE t', 'write', 'TRUNCATE'],
    ['CREATE TABLE t (a INT64)', 'ddl', 'CREATE'],
    ['CREATE TEMP TABLE t AS SELECT 1', 'ddl', 'CREATE'],
    ['CREATE OR REPLACE VIEW v AS SELECT 1', 'ddl', 'CREATE'],
    ['ALTER TABLE t ADD COLUMN b INT64', 'ddl', 'ALTER'],
    ['DROP TABLE t', 'ddl', 'DROP'],
    ['UNDROP SCHEMA d', 'ddl', 'UNDROP'],
    ['BEGIN', 'transaction-control', 'BEGIN'],
    ['BEGIN;', 'transaction-control', 'BEGIN'],
    ['BEGIN TRANSACTION', 'transaction-control', 'BEGIN'],
    ['start transaction', 'transaction-control', 'START'],
    ['COMMIT', 'transaction-control', 'COMMIT'],
    ['COMMIT TRANSACTION', 'transaction-control', 'COMMIT'],
    ['ROLLBACK', 'transaction-control', 'ROLLBACK'],
    ['rollback transaction;', 'transaction-control', 'ROLLBACK'],
    ['BEGIN SELECT 1; END', 'other', 'BEGIN'],
    ['DECLARE x INT64', 'other', 'DECLARE'],
    ['SET x = 1', 'other', 'SET'],
    ['SET (a, b) = (1, 2)', 'other', 'SET'],
    ['IF TRUE THEN SELECT 1; END IF', 'other', 'IF'],
    ['LOOP SELECT 1; END LOOP', 'other', 'LOOP'],
    ['WHILE TRUE DO SELECT 1; END WHILE', 'other', 'WHILE'],
    ['REPEAT SELECT 1; UNTIL TRUE END REPEAT', 'other', 'REPEAT'],
    ['FOR r IN (SELECT 1) DO SELECT 1; END FOR', 'other', 'FOR'],
    ['CASE WHEN TRUE THEN SELECT 1; END CASE', 'other', 'CASE'],
    ['l: BEGIN SELECT 1; END l', 'other', 'LABEL'],
    ['CALL ds.p()', 'other', 'CALL'],
    ["EXECUTE IMMEDIATE 'DROP TABLE x'", 'other', 'EXECUTE'],
    ["EXPORT DATA OPTIONS(uri='gs://b/*') AS SELECT 1", 'other', 'EXPORT'],
    ["LOAD DATA INTO t FROM FILES(format='CSV', uris=['gs://b/x'])", 'other', 'LOAD'],
    ['GRANT `roles/viewer` ON SCHEMA d TO "user:a@b.c"', 'other', 'GRANT'],
    ['REVOKE `roles/viewer` ON SCHEMA d FROM "user:a@b.c"', 'other', 'REVOKE'],
    ['ASSERT 1 = 1', 'other', 'ASSERT'],
    ['RAISE USING MESSAGE = "x"', 'other', 'RAISE'],
    ['EXPLAIN SELECT 1', 'other', 'EXPLAIN'],
    ['SHOW TABLES', 'other', 'SHOW'],
  ];
  it.each(cases)('%s is %s', (sql, kind, verb) => {
    const c = classify(sql);
    expect(c.kind).toBe(kind);
    expect(c.verb).toBe(verb);
    expect(c.allowedInReadOnly).toBe(false);
    expect(c.implicitCommit).toBe(false);
    expect(c.reason).toMatch(/^Somente leitura: /);
    expect(c.transactionControl).toBe(
      kind === 'transaction-control' ? { BEGIN: 'begin', START: 'begin', COMMIT: 'commit', ROLLBACK: 'rollback' }[verb] : null,
    );
  });
  it('refuses DML after a WITH, by the main verb', () => {
    const c = classify('WITH a AS (SELECT 1) DELETE FROM t WHERE TRUE');
    expect(c.kind).toBe('write');
    expect(c.allowedInReadOnly).toBe(false);
  });
  it('refuses a WITH of an unknown shape and the empty statement', () => {
    expect(ro('WITH x SELECT 1')).toBe(false);
    expect(ro('WITH x AS SELECT 1')).toBe(false);
    expect(ro('WITH x AS (SELECT 1)')).toBe(false);
    expect(ro('')).toBe(false);
    expect(ro('-- only a comment')).toBe(false);
    expect(ro(';')).toBe(false);
  });
  it('refuses anything else, by default', () => {
    expect(ro('FROBNICATE t')).toBe(false);
    expect(ro('@p')).toBe(false);
    expect(ro('1')).toBe(false);
    expect(ro('(DROP TABLE t)')).toBe(false);
    expect(ro('((CALL p()))')).toBe(false);
  });
  it('reads the verb through comments and case', () => {
    expect(classify('/* a */ -- b\n # c\n dRoP table t').kind).toBe('ddl');
    expect(classify('(/* c */ DROP TABLE t)').kind).toBe('ddl');
  });
});

describe('classify: attacks', () => {
  it('ignores keywords in comments, strings and names', () => {
    expect(classify('SELECT 1 -- DROP TABLE t').kind).toBe('read');
    expect(classify('SELECT `DROP`, "DELETE", \'INSERT\' FROM `UPDATE`').kind).toBe('read');
    expect(classify('/* SELECT */ DROP TABLE t').kind).toBe('ddl');
    expect(classify("-- SELECT 1\nDELETE FROM t WHERE TRUE").kind).toBe('write');
    expect(classify('#SELECT\nDROP TABLE t').kind).toBe('ddl');
  });
  it('refuses more than one command', () => {
    for (const sql of [
      'SELECT 1; SELECT 2',
      'SELECT 1; DROP TABLE t',
      'SELECT 1;;',
      'SELECT 1; -- x\nDELETE FROM t WHERE TRUE',
      'SELECT 1;/* x */SELECT 2',
      '(SELECT 1); (SELECT 2)',
      'WITH a AS (SELECT 1) SELECT 1; SELECT 2',
    ]) {
      const c = classify(sql);
      expect(c.allowedInReadOnly, sql).toBe(false);
      expect(c.reason, sql).toContain('mais de um comando');
    }
  });
  it('a ; inside a string, name or comment is not a second command', () => {
    expect(ro("SELECT ';'")).toBe(true);
    expect(ro('SELECT `;`')).toBe(true);
    expect(ro('SELECT 1 /* ; */')).toBe(true);
    expect(ro('SELECT 1 -- ;')).toBe(true);
  });
  it('a script disguised as a query is refused', () => {
    expect(ro('BEGIN SELECT 1; DROP TABLE t; END')).toBe(false);
    expect(ro('BEGIN\nSELECT 1;\nEND')).toBe(false);
    expect(ro('IF TRUE THEN SELECT 1; END IF')).toBe(false);
    expect(ro('SELECT 1; BEGIN SELECT 2; END')).toBe(false);
    expect(ro('DECLARE x INT64; SELECT x')).toBe(false);
    expect(ro('SET x = (SELECT 1)')).toBe(false);
    expect(classify('BEGIN; DROP TABLE t').allowedInReadOnly).toBe(false);
    expect(classify('BEGIN; DROP TABLE t').transactionControl).toBeNull();
    expect(classify('BEGIN TRANSACTION; SELECT 1').transactionControl).toBeNull();
    expect(classify('COMMIT; SELECT 1').transactionControl).toBeNull();
  });
  it('tells BEGIN; and BEGIN TRANSACTION from BEGIN … END', () => {
    expect(classify('BEGIN').transactionControl).toBe('begin');
    expect(classify('BEGIN TRANSACTION').transactionControl).toBe('begin');
    expect(classify('BEGIN SELECT 1; END').transactionControl).toBeNull();
    expect(classify('BEGIN SELECT 1; END').kind).toBe('other');
    expect(classify('BEGIN TRANSACTION').kind).toBe('transaction-control');
  });
  it('a CASE expression and IF() are not scripts', () => {
    expect(ro('SELECT CASE WHEN a THEN 1 ELSE 2 END FROM t')).toBe(true);
    expect(ro('SELECT IF(a, 1, 2)')).toBe(true);
    expect(ro('SELECT * FROM t WHERE IF(a, b, c)')).toBe(true);
  });
  it('syntactically odd texts with two commands and no ; stay a query for the classifier (the server refuses them)', () => {
    // the grammar needs ";" between commands: this is a syntax error server side, and the dry run backs it up
    const c = classify('SELECT 1 DROP TABLE t');
    expect(c.kind).toBe('read');
    expect(c.allowedInReadOnly).toBe(true);
  });
  it('refuses the #legacySQL and #standardSQL directives, in any case and spacing', () => {
    for (const sql of ['#legacySQL\nSELECT 1', '#standardSQL\nSELECT 1', '#LEGACYSQL\nSELECT 1', '# legacySQL\nSELECT 1', '-- x\n#standardsql\nSELECT 1']) {
      const c = classify(sql);
      expect(c.allowedInReadOnly, sql).toBe(false);
      expect(c.legacyDirective, sql).toBe(true);
    }
    expect(classify('SELECT 1 -- #legacySQL').legacyDirective).toBeUndefined();
    expect(ro("SELECT '#legacySQL'")).toBe(true);
  });
  it('refuses EXTERNAL_QUERY in any spelling', () => {
    for (const sql of [
      "SELECT * FROM EXTERNAL_QUERY('c', 'SELECT 1')",
      "select * from external_query('c', 'x')",
      "SELECT * FROM `external_query`('c', 'x')",
      "SELECT * FROM EXTERNAL_QUERY /* c */ ('c', 'x')",
      "SELECT * FROM proj.EXTERNAL_QUERY('c', 'x')",
    ]) {
      const c = classify(sql);
      expect(c.allowedInReadOnly, sql).toBe(false);
      expect(c.externalQuery, sql).toBe(true);
    }
    expect(ro("SELECT 'EXTERNAL_QUERY'")).toBe(true);
    expect(classify("SELECT 'EXTERNAL_QUERY'").externalQuery).toBeUndefined();
  });
  it('refuses text with an unterminated string, name or comment', () => {
    for (const sql of ["SELECT 'abc", 'SELECT "abc', 'SELECT `abc', 'SELECT 1 /* abc', "SELECT '''abc'", "SELECT 1; SELECT 'x"]) {
      expect(ro(sql), sql).toBe(false);
    }
  });
  it('refuses what reads differently if a backslash does or does not escape in a raw string or between backticks', () => {
    for (const sql of ["SELECT r'\\'; DROP TABLE x; --'", "SELECT r'\\''", 'SELECT `a\\``', "SELECT rb'\\'x'"]) {
      const c = classify(sql);
      expect(c.allowedInReadOnly, sql).toBe(false);
    }
    // the same text read the same way both ways passes
    expect(ro("SELECT r'a\\d+'")).toBe(true);
    expect(ro("SELECT r'a\\\\'")).toBe(true);
    expect(ro('SELECT `a\\.b`')).toBe(true);
    expect(ro("SELECT 'a\\'b'")).toBe(true);
  });
  it('not fooled by names that look like prefixes', () => {
    expect(ro("SELECT bar'x'")).toBe(true);
  });
});

describe('classify: functions and flags', () => {
  const fns = (sql: string) => classify(sql).functions;
  it('lists the called functions in upper case, qualified as written', () => {
    expect(fns('SELECT count(*), a.b(1), ML.GENERATE_TEXT(1), `p.d.fn`(2), meu_ds.fn(3) FROM t')).toEqual(
      expect.arrayContaining(['COUNT', 'A.B', 'ML.GENERATE_TEXT', 'P.D.FN', 'MEU_DS.FN']),
    );
    expect(fns('SELECT 1')).toEqual([]);
  });
  it('does not take syntax for calls', () => {
    expect(fns('SELECT * FROM t WHERE a IN (1, 2) AND (b OR c) AND EXISTS (SELECT 1)')).toEqual([]);
    expect(fns('WITH x AS (SELECT 1) SELECT * FROM x JOIN y USING (id)')).toEqual([]);
  });
  it('flags the calls outside the built-in namespaces', () => {
    const remote = (sql: string) => classify(sql).remoteCalls ?? [];
    expect(remote('SELECT meu_ds.fn(1)')).toEqual(['MEU_DS.FN']);
    expect(remote('SELECT `proj.ds.fn`(1)')).toEqual(['PROJ.DS.FN']);
    expect(remote('SELECT proj.ds.fn(1)')).toEqual(['PROJ.DS.FN']);
    expect(remote('SELECT `ds`.`fn`(1)')).toEqual(['DS.FN']);
    expect(remote('SELECT SAFE.my_ds.fn(1)')).toEqual(['SAFE.MY_DS.FN']);
  });
  it('does not flag built-in namespaces and plain functions', () => {
    for (const sql of [
      'SELECT NET.HOST(u)',
      'SELECT net.host(u)',
      'SELECT AEAD.ENCRYPT(k, a, b)',
      'SELECT KEYS.NEW_KEYSET("AEAD_AES_GCM_256")',
      'SELECT HLL_COUNT.MERGE(s)',
      'SELECT KLL_QUANTILES.MERGE_POINT_INT64(s, 0.5)',
      'SELECT SAFE.PARSE_DATE("%Y", s)',
      'SELECT SAFE.NET.HOST(u)',
      'SELECT COUNT(*), SUM(a), IF(a, b, c), COALESCE(a, b)',
    ]) {
      expect(classify(sql).remoteCalls, sql).toBeUndefined();
    }
  });
  it('flags every ML.* and AI.* call, quoted or safe-prefixed', () => {
    for (const sql of [
      'SELECT * FROM ML.PREDICT(MODEL `ds.m`, TABLE t)',
      'SELECT ML.GENERATE_TEXT(1)',
      'SELECT AI.GENERATE(p)',
      'SELECT AI.GENERATE_BOOL(p)',
      'SELECT SAFE.ML.PREDICT(1)',
      'SELECT `ml`.`predict`(1)',
      'SELECT * FROM ml . generate_text (MODEL m, TABLE t)',
    ]) {
      expect(classify(sql).remoteCalls?.length, sql).toBeGreaterThan(0);
    }
  });
  it('flags a built-in namespace written with more parts or quoted (a dataset with that name)', () => {
    expect(classify('SELECT `net`.`host`(1)').remoteCalls).toEqual(['NET.HOST']);
    expect(classify('SELECT proj.net.host(1)').remoteCalls).toEqual(['PROJ.NET.HOST']);
  });
  it('flags a dataset routine named like a built-in namespace (judged by the full name)', () => {
    for (const [sql, name] of [
      ['SELECT net.myfn(1)', 'NET.MYFN'],
      ['SELECT bq.myfn(1)', 'BQ.MYFN'],
      ['SELECT keys.myfn(1)', 'KEYS.MYFN'],
      ['SELECT obj.myfn(1)', 'OBJ.MYFN'],
      ['SELECT SAFE.keys.myfn(1)', 'SAFE.KEYS.MYFN'],
      ['SELECT SAFE.net.myfn(1)', 'SAFE.NET.MYFN'],
    ] as const) {
      expect(classify(sql).remoteCalls, sql).toEqual([name]);
    }
  });
  it('flags DLP functions', () => {
    expect(classify('SELECT DLP_DETERMINISTIC_ENCRYPT(k, v, c)').remoteCalls).toEqual(['DLP_DETERMINISTIC_ENCRYPT']);
  });
  it('flags metadata of jobs and sessions in every spelling of the path', () => {
    for (const sql of [
      'SELECT * FROM region-us.INFORMATION_SCHEMA.JOBS',
      'SELECT * FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT',
      'SELECT * FROM `region-us.INFORMATION_SCHEMA.JOBS`',
      'SELECT * FROM `proj.region-eu.INFORMATION_SCHEMA.JOBS_BY_USER`',
      'SELECT * FROM my-proj.region-us.INFORMATION_SCHEMA.JOBS_BY_FOLDER',
      'SELECT * FROM `my-proj`.`region-us`.`INFORMATION_SCHEMA`.`JOBS`',
      'SELECT * FROM region-us.information_schema.jobs_timeline',
      'SELECT * FROM region-us.INFORMATION_SCHEMA.SESSIONS_BY_USER',
      'SELECT * FROM region-us . INFORMATION_SCHEMA /* c */ . JOBS',
      'SELECT * FROM proj-1.region-us.INFORMATION_SCHEMA.JOBS',
      'SELECT * FROM ds.INFORMATION_SCHEMA.JOBS',
      'WITH j AS (SELECT * FROM region-us.INFORMATION_SCHEMA.JOBS_BY_ORGANIZATION) SELECT * FROM j',
    ]) {
      const c = classify(sql);
      expect(c.jobsMetadata, sql).toBe(true);
      expect(c.kind).toBe('read');
    }
    for (const sql of [
      'SELECT * FROM ds.INFORMATION_SCHEMA.TABLES',
      'SELECT * FROM region-us.INFORMATION_SCHEMA.TABLE_STORAGE',
      "SELECT 'INFORMATION_SCHEMA.JOBS'",
      'SELECT * FROM jobs',
    ]) {
      expect(classify(sql).jobsMetadata, sql).toBeUndefined();
    }
  });
  it('no warnings in a read-only dialect', () => {
    expect(d.warnings('DELETE FROM t')).toEqual([]);
  });
});

describe('identifiers', () => {
  it('gives lower-case names, the parts of a quoted path and dashed project names', () => {
    const ids = identifiers('SELECT A, `b`.`C` FROM `Proj.Ds.T` JOIN my-project.ds2.t2 USING (id)');
    expect(ids).toEqual(expect.arrayContaining(['a', 'b', 'c', 'proj', 'ds', 't', 'my-project', 'ds2', 't2', 'id', 'select', 'from']));
  });
  it('does not take names from strings and comments', () => {
    const ids = identifiers("SELECT 'secret' -- hidden\n/* gone */");
    expect(ids).not.toContain('secret');
    expect(ids).not.toContain('hidden');
    expect(ids).not.toContain('gone');
  });
  it('reads both ways a backslash can go', () => {
    expect(identifiers('SELECT `a\\`b`')).toEqual(expect.arrayContaining(['a`b', 'a\\']));
  });
});

describe('agentCodeProblem', () => {
  const p = (sql: string) => agentCodeProblem(sql);
  it('passes ordinary SQL', () => {
    for (const sql of [
      'SELECT 1',
      "SELECT 'é', \"ñ\" -- ç\n, `ü`",
      '/* é */ SELECT 1',
      "SELECT r'abc', R\"abc\"",
      "SELECT 'a\\'b', \"c\\\"d\", 'e\\\\'",
      '# comment\nSELECT @p, @@time_zone, ?',
      'SELECT * FROM `my-proj.ds.t` WHERE a = 1',
      'SELECT 1 -- x\r\n, 2',
    ]) {
      expect(p(sql), sql).toBeNull();
    }
  });
  it('refuses non-ASCII in the code', () => {
    expect(p('SELECT 1 AS x')).toContain('⟨U+00A0⟩');
    expect(p('SELECT é FROM t')).toContain('⟨U+00E9⟩');
    expect(p('SELECT 1 \u{1F600}')).toContain('⟨U+1F600⟩');
  });
  it('refuses a non-ASCII function name and a quoted parameter', () => {
    expect(p('SELECT `fünc`(1)')).toContain('Function name');
    expect(p('SELECT @`é`')).toContain('Parameter name');
    expect(p("SELECT @'x'")).toContain('Parameter name');
    expect(p("SELECT ?'x'")).toContain('Parameter name');
    expect(p('SELECT * FROM `é`(1) ')).not.toBeNull();
    expect(p('SELECT * FROM `é`')).toBeNull();
  });
  it('refuses /* inside a block comment', () => {
    expect(p('/* a /* b */ SELECT 1')).toContain('/*');
    expect(p('/* a */ SELECT 1')).toBeNull();
    expect(p('/**/ SELECT 1')).toBeNull();
    expect(p('/*/* x */ SELECT 1')).not.toBeNull();
  });
  it('refuses a carriage return that ends a line comment, but not CRLF', () => {
    expect(p('SELECT 1 -- a\rb')).not.toBeNull();
    expect(p('SELECT 1 # a\r; DROP TABLE t')).not.toBeNull();
    expect(p('SELECT 1 -- a\r\nb')).toBeNull();
  });
  it('refuses strings of three quotes', () => {
    for (const sql of ["SELECT '''a'''", 'SELECT """a"""', "SELECT r'''a'''", "SELECT b'''a'''", "SELECT ''''''"]) {
      expect(p(sql), sql).toContain('Triple-quoted');
    }
    expect(p("SELECT '', ''")).toBeNull();
    expect(p("SELECT 'a'")).toBeNull();
  });
  it('refuses the #legacySQL and #standardSQL directives', () => {
    expect(p('#legacySQL\nSELECT 1')).toContain('#legacySQL');
    expect(p('#standardSQL\nSELECT 1')).toContain('#standardSQL');
    expect(p('# LegacySql\nSELECT 1')).not.toBeNull();
    expect(p('#other\nSELECT 1')).toBeNull();
  });
  it('lets raw strings through only when every reading ends them in the same place', () => {
    expect(p("SELECT r'abc'")).toBeNull();
    expect(p('SELECT r"a b"')).toBeNull();
    expect(p("SELECT r'\\d'")).toContain('Raw string');
    expect(p("SELECT r'\\''")).toContain('Raw string');
    expect(p("SELECT rb'a\\\\'")).toContain('Raw string');
  });
  it('refuses a backslash between backticks', () => {
    expect(p('SELECT `a\\`b`')).toContain('Backtick-quoted');
    expect(p('SELECT `ab`')).toBeNull();
  });
  it('refuses x glued to a quote (the highlighter reads a hex number)', () => {
    expect(p("SELECT x'41'")).not.toBeNull();
    expect(p("SELECT X'41'")).not.toBeNull();
    expect(p("SELECT 1 AS x, 'a'")).toBeNull();
  });
  it('every string it passes ends where the highlighter ends it', () => {
    // the highlighter (CodeMirror, backslash escapes on) skips a backslash and the next character in any quoted string
    const sql = "SELECT 'a\\'b', r'plain', \"q\\\"\", 'x\\'y' -- done";
    expect(p(sql)).toBeNull();
    expect(lex(sql).filter((t) => t.kind === 'string')).toHaveLength(4);
  });
  it('speaks English unless asked otherwise', () => {
    expect(agentCodeProblem("SELECT '''a'''")).toMatch(/Triple-quoted/);
    expect(agentCodeProblem("SELECT '''a'''", 'pt-BR')).toMatch(/três aspas/);
  });
});

describe('the dialect object', () => {
  it('names the engine and the editor dialect', () => {
    expect(d.engine).toBe('bigquery');
    expect(d.displayName).toBe('BigQuery');
    expect(d.codemirrorDialect).toBe('GoogleSQL');
  });
  it('has the official reserved words', () => {
    expect(d.keywords).toBe(GOOGLESQL_KEYWORDS);
    for (const w of ['SELECT', 'FROM', 'WHERE', 'QUALIFY', 'UNNEST', 'STRUCT', 'WITHIN', 'LOOKUP', 'GRAPH_TABLE']) expect(d.keywords).toContain(w);
    expect(d.keywords).not.toContain('DROP');
  });
  it('quotes names with backticks, escaping the backtick and the backslash', () => {
    expect(d.quoteIdent('t')).toBe('`t`');
    expect(d.quoteIdent('a`b')).toBe('`a\\`b`');
    expect(d.quoteIdent('a\\b')).toBe('`a\\\\b`');
    expect(d.quoteIdent('meu-projeto.ds')).toBe('`meu-projeto.ds`');
    const lexed = lex(d.quoteIdent('a`; DROP TABLE x; --'));
    expect(lexed).toHaveLength(1);
    expect(lexed[0]!.kind).toBe('ident');
    expect(lex(d.quoteIdent('a`; DROP'), false).length).toBeGreaterThan(0);
  });
  it('writes the table preview like MySQL does', () => {
    expect(d.tablePreviewSql('ds', 't')).toBe('SELECT * FROM `ds`.`t` LIMIT 100;');
    expect(d.tablePreviewSql('d`s', 't')).toBe('SELECT * FROM `d\\`s`.`t` LIMIT 100;');
    expect(ro(d.tablePreviewSql('ds', 't'))).toBe(true);
  });
  it('cannot edit: no value kinds, no literals, no UPDATE', () => {
    expect(d.valueKind('STRING')).toBe('unsupported');
    expect(d.valueKind('INT64')).toBe('unsupported');
    expect(() => d.quoteLiteral('x', 'STRING')).toThrow();
    expect(() => d.buildUpdate({ database: 'd', table: 't', set: [], where: [] })).toThrow();
    expect(() => d.buildUpdateLocated({ database: 'd', table: 't', set: [], where: [] })).toThrow();
    expect(() => d.buildInsert({ database: 'd', table: 't', columns: [], rows: [] })).toThrow();
  });
  it('has agent rules for a read-only engine', () => {
    const r = d.agentRules;
    expect(r.systemSchemas).toEqual(['information_schema']);
    expect(r.secretSchemas).toEqual([]);
    expect(r.deniedFunctions).toEqual(['EXTERNAL_QUERY', 'OBJ.FETCH_METADATA', 'OBJ.GET_ACCESS_URL', 'OBJ.MAKE_REF']);
    expect(r.writeVerbs).toEqual([]);
    expect(r.isValidDatabaseName('my_dataset1')).toBe(true);
    for (const bad of ['', 'a-b', 'a.b', 'a b', 'a`b', 'é', 'a\n', 'x'.repeat(1025)]) expect(r.isValidDatabaseName(bad), bad).toBe(false);
    expect(r.isValidDatabaseName('x'.repeat(1024))).toBe(true);
    expect(r.messages.systemSchemaWrite).toBeTruthy();
    expect(r.messages.systemSchemaRead).toBeTruthy();
  });
});
