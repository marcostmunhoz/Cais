import { describe, expect, it } from 'vitest';
import { MySqlLexer } from 'dt-sql-parser/dist/lib/mysql/MySqlLexer';
import { MySQL } from 'dt-sql-parser/dist/parser/mysql';
import { checkMysql, MAX_CHECKED_LENGTH, shouldCheck, UNREADABLE_NAMES } from '../../src/renderer/lib/syntax/mysql';
import { buildDelete, buildInsert, buildUpdate, buildUpdateLocated } from '@shared/dialects/mysql/literals';
import { INVALID_MYSQL, VALID_MYSQL } from '../support/mysql-corpus';

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split('\n').length;

describe('MySQL syntax check: valid statements', () => {
  // the first time the grammar reads each kind of statement it builds its tables: the whole corpus takes seconds
  it('flags none of the corpus of valid MySQL 8.4 statements', { timeout: 60_000 }, () => {
    const flagged = VALID_MYSQL.map((sql) => ({ sql, issues: checkMysql(sql) })).filter((r) => r.issues.length > 0);
    expect(flagged.map((r) => `${r.sql} => ${r.issues[0]!.message}`)).toEqual([]);
  });

  it('reads the statements of the test suites of the project too (the ones that are not meant to be refused)', () => {
    for (const sql of [
      "UPDATE agent_items SET status = 'x' WHERE id = 1",
      "INSERT INTO people (name, email) VALUES ('Zed', 'z@x.com')",
      'SELECT c.id, c.status, c.created_at, co.name FROM cards c JOIN companies co ON co.id = c.company_id WHERE c.status = 1',
      'DELETE FROM lv_bulk WHERE id = 1 LIMIT 1',
    ]) {
      expect(checkMysql(sql), sql).toEqual([]);
    }
  });
});

describe('MySQL syntax check: errors', () => {
  it.each(INVALID_MYSQL)('flags "$sql" on line $line', ({ sql, line }) => {
    const [issue] = checkMysql(sql);
    expect(issue, 'an issue').toBeDefined();
    expect(lineOf(sql, issue!.from)).toBe(line);
    expect(issue!.to).toBeGreaterThan(issue!.from);
    expect(issue!.to).toBeLessThanOrEqual(sql.length);
    expect(issue!.message.length).toBeGreaterThan(0);
  });

  it('gives only the first error: the ones after it are the parser recovering', () => {
    expect(checkMysql('SELECT a,, b FRM t WHERE')).toHaveLength(1);
  });

  it('puts the range on the word the parser stopped at', () => {
    const sql = 'SELECT * FRM t';
    const [issue] = checkMysql(sql);
    expect(sql.slice(issue!.from, issue!.to)).toBe('FRM');
  });

  it('an unfinished statement is flagged on its last word', () => {
    const sql = 'SELECT * FROM t WHERE';
    const [issue] = checkMysql(sql);
    expect(sql.slice(issue!.from, issue!.to)).toBe('WHERE');
    expect(issue!.message).toMatch(/incomplete/i);
  });

  it('counts columns in characters, not in UTF-16 units (an emoji before the error)', () => {
    const sql = "SELECT '😀😀' AS x, a b c FROM t";
    const [issue] = checkMysql(sql);
    expect(issue).toBeDefined();
    expect(sql.slice(issue!.from, issue!.to)).toBe('c');
  });

  it('puts a multi-line statement error on the right line and column', () => {
    const sql = 'SELECT a,\n       b\nFROM t\nWHERE a = = 1';
    const [issue] = checkMysql(sql);
    expect(lineOf(sql, issue!.from)).toBe(4);
    expect(sql.slice(issue!.from, issue!.to)).toBe('1');
  });
});

describe('what the grammar reads wrong is not asked', () => {
  it('names that are keywords for it and not for MySQL', () => {
    for (const sql of ['SELECT type FROM t', 'SELECT t.type, off FROM t', 'UPDATE t SET old = 1 WHERE type = 2', 'INSERT INTO t (type, a) VALUES (1, 2)']) {
      expect(shouldCheck(sql), sql).toBe(false);
      expect(checkMysql(sql), sql).toEqual([]);
    }
  });

  it('the same words as functions are read (CAST, EXTRACT)', () => {
    expect(shouldCheck('SELECT CAST(a AS CHAR), EXTRACT(YEAR FROM d) FROM t')).toBe(true);
    expect(checkMysql('SELECT CAST(a AS CHAR), EXTRACT(YEAR FROM d) FROM t')).toEqual([]);
    expect(checkMysql('SELECT CAST(a AS CHAR) FRM t')).toHaveLength(1);
  });

  it('syntax it does not cover: MATCH AGAINST, JSON_TABLE, NOWAIT, executable comments', () => {
    for (const sql of [
      'SELECT * FROM t WHERE MATCH(a) AGAINST ("x" IN BOOLEAN MODE)',
      'SELECT * FROM JSON_TABLE(\'[]\', "$[*]" COLUMNS (a INT PATH "$.a")) AS jt',
      'SELECT * FROM t WHERE id = 1 FOR UPDATE NOWAIT',
      'SELECT /*!50000 1 */',
      'SELECT /*M! 1 */',
    ]) {
      expect(shouldCheck(sql), sql).toBe(false);
    }
  });

  it('only queries and row changes are read; DDL, SET, SHOW and routines are the server\'s', () => {
    for (const sql of ['CREATE TABLE t (a INT,, b INT)', 'DROP TABLE', 'SET @a = ', 'SHOW TABLES FRM x', 'CREATE PROCEDURE p () BEGIN SELEC 1; END', 'GRANT SELECT ON', 'ALTER TABLE', '-- only a comment', '']) {
      expect(shouldCheck(sql), sql).toBe(false);
      expect(checkMysql(sql), sql).toEqual([]);
    }
    for (const sql of ['SELECT 1', 'WITH x AS (SELECT 1) SELECT * FROM x', '(SELECT 1) UNION (SELECT 2)', 'INSERT INTO t VALUES (1)', 'REPLACE INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t', 'TABLE t', 'VALUES ROW(1)']) {
      expect(shouldCheck(sql), sql).toBe(true);
    }
  });

  it('a statement too long to be worth the time is not read', () => {
    const long = `INSERT INTO t (a) VALUES ${'(1),'.repeat(MAX_CHECKED_LENGTH / 4)}(1) SELEC`;
    expect(long.length).toBeGreaterThan(MAX_CHECKED_LENGTH);
    expect(checkMysql(long)).toEqual([]);
  });
});

// The non-reserved keywords of MySQL 8.4 may all be names. The grammar misses some; the list the lint skips (UNREADABLE_NAMES) is
// rebuilt here from its own vocabulary, so changing the version of dt-sql-parser shows what to add or drop.
const RESERVED = new Set(
  (
    'ACCESSIBLE ADD ALL ALTER ANALYZE AND AS ASC ASENSITIVE BEFORE BETWEEN BIGINT BINARY BLOB BOTH BY CALL CASCADE CASE CHANGE CHAR CHARACTER ' +
    'CHECK COLLATE COLUMN CONDITION CONSTRAINT CONTINUE CONVERT CREATE CROSS CUBE CUME_DIST CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP ' +
    'CURRENT_USER CURSOR DATABASE DATABASES DAY_HOUR DAY_MICROSECOND DAY_MINUTE DAY_SECOND DEC DECIMAL DECLARE DEFAULT DELAYED DELETE DENSE_RANK ' +
    'DESC DESCRIBE DETERMINISTIC DISTINCT DISTINCTROW DIV DOUBLE DROP DUAL EACH ELSE ELSEIF EMPTY ENCLOSED ESCAPED EXCEPT EXISTS EXIT EXPLAIN ' +
    'FALSE FETCH FIRST_VALUE FLOAT FLOAT4 FLOAT8 FOR FORCE FOREIGN FROM FULLTEXT FUNCTION GENERATED GET GRANT GROUP GROUPING GROUPS HAVING ' +
    'HIGH_PRIORITY HOUR_MICROSECOND HOUR_MINUTE HOUR_SECOND IF IGNORE IN INDEX INFILE INNER INOUT INSENSITIVE INSERT INT INT1 INT2 INT3 INT4 INT8 ' +
    'INTEGER INTERSECT INTERVAL INTO IO_AFTER_GTIDS IO_BEFORE_GTIDS IS ITERATE JOIN JSON_TABLE KEY KEYS KILL LAG LAST_VALUE LATERAL LEAD LEADING ' +
    'LEAVE LEFT LIKE LIMIT LINEAR LINES LOAD LOCALTIME LOCALTIMESTAMP LOCK LONG LONGBLOB LONGTEXT LOOP LOW_PRIORITY MASTER_BIND ' +
    'MASTER_SSL_VERIFY_SERVER_CERT MATCH MAXVALUE MEDIUMBLOB MEDIUMINT MEDIUMTEXT MIDDLEINT MINUTE_MICROSECOND MINUTE_SECOND MOD MODIFIES NATURAL ' +
    'NOT NO_WRITE_TO_BINLOG NTH_VALUE NTILE NULL NUMERIC OF ON OPTIMIZE OPTIMIZER_COSTS OPTION OPTIONALLY OR ORDER OUT OUTER OUTFILE OVER PARTITION ' +
    'PERCENT_RANK PRECISION PRIMARY PROCEDURE PURGE RANGE RANK READ READS READ_WRITE REAL RECURSIVE REFERENCES REGEXP RELEASE RENAME REPEAT REPLACE ' +
    'REQUIRE RESIGNAL RESTRICT RETURN REVOKE RIGHT RLIKE ROW ROWS ROW_NUMBER SCHEMA SCHEMAS SECOND_MICROSECOND SELECT SENSITIVE SEPARATOR SET SHOW ' +
    'SIGNAL SMALLINT SPATIAL SPECIFIC SQL SQLEXCEPTION SQLSTATE SQLWARNING SQL_BIG_RESULT SQL_CALC_FOUND_ROWS SQL_SMALL_RESULT SSL STARTING STORED ' +
    'STRAIGHT_JOIN SYSTEM TABLE TERMINATED THEN TINYBLOB TINYINT TINYTEXT TO TRAILING TRIGGER TRUE UNDO UNION UNIQUE UNLOCK UNSIGNED UPDATE USAGE ' +
    'USE USING UTC_DATE UTC_TIME UTC_TIMESTAMP VALUES VARBINARY VARCHAR VARCHARACTER VARYING VIRTUAL WHEN WHERE WHILE WINDOW WITH WRITE XOR ' +
    'YEAR_MONTH ZEROFILL MANUAL PARALLEL QUALIFY TABLESAMPLE'
  ).split(' '),
);

describe('the keywords the grammar cannot read as names', () => {
  // `SELECT <word> FROM t` is the probe: each of the words the grammar cannot read fails it, and a parse that fails is slow (tens of ms)
  it('are exactly the ones the lint skips', { timeout: 60_000 }, () => {
    const parser = new MySQL();
    const vocabulary = MySqlLexer['vocabulary']; // private in the typings, the list of the keywords the lexer knows
    const words: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const literal = vocabulary.getLiteralName(i);
      if (literal && /^'[A-Za-z_][A-Za-z_0-9]*'$/.test(literal)) words.push(literal.slice(1, -1));
    }
    expect(words.length).toBeGreaterThan(500);
    const failing = words
      .filter((w) => !RESERVED.has(w))
      .filter((w) => parser.validate(`SELECT ${w.toLowerCase()} FROM t`).length > 0)
      .sort();
    expect(failing).toEqual([...UNREADABLE_NAMES].sort());
  });
});

describe('MySQL syntax check: what the grid generates', () => {
  const bin = (hex: string) => ({ kind: 'binary' as const, hex, length: hex.length / 2 });
  const columns = [
    { column: 'id', type: 'int', value: 7 },
    { column: 'name', type: 'varchar(40)', value: "O'Brien \\ (x)" },
    { column: 'note', type: 'text', value: null },
    { column: 'raw', type: 'varbinary(16)', value: bin('00ff10') },
    { column: 'flags', type: 'bit(8)', value: bin('05') },
    { column: 'doc', type: 'json', value: '{"a": [1, 2, {"b": null}]}' },
    { column: 'price', type: 'decimal(10,2)', value: '12.50' },
    { column: 'born', type: 'date', value: '2020-01-31' },
    { column: 'seen', type: 'datetime', value: '2020-01-31 10:00:00' },
    { column: 'ts', type: 'timestamp', value: '2020-01-31 10:00:00' },
  ];
  const key = [{ column: 'id', type: 'int', value: 7 }];
  const set = columns.slice(1);

  it('reads the INSERTs, with and without the key, one row or several, and the all-defaults one', () => {
    const statements = [
      buildInsert({ database: 'app', table: 'people', columns: columns.map(({ column, type }) => ({ column, type })), rows: [columns.map((c) => c.value), columns.map((c) => c.value)] }),
      buildInsert({ database: 'app', table: 'people', columns: columns.map(({ column, type }) => ({ column, type })), rows: [columns.map((c) => c.value)] }),
      buildInsert({ database: 'app', table: 'people', columns: set.map(({ column, type }) => ({ column, type })), rows: [set.map((c) => c.value)] }),
      buildInsert({ database: 'app', table: 'people', columns: [], rows: [[]] }),
      buildInsert({ database: 'app', table: 'people', columns: [], rows: [[], []] }),
    ];
    for (const sql of statements) expect(checkMysql(sql), sql).toEqual([]);
  });

  it('reads the UPDATEs and DELETEs', () => {
    const statements = [
      buildUpdate({ database: 'app', table: 'people', set, where: key }),
      buildUpdateLocated({ database: 'app', table: 'people', set: [set[0]!], where: key }).sql,
      buildDelete({ database: 'app', table: 'people', where: key }),
    ];
    for (const sql of statements) expect(checkMysql(sql), sql).toEqual([]);
  });

  it('still flags an empty () that is a real mistake', () => {
    expect(checkMysql('INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a = (')).not.toEqual([]);
    expect(checkMysql('SELECT * FROM t WHERE a IN ()')).not.toEqual([]);
  });
});
