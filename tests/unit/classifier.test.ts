import { describe, expect, it } from 'vitest';
import { classify, identifiers, warnings } from '@shared/dialects/mysql/classifier';

const ro = (sql: string) => classify(sql).allowedInReadOnly;

describe('classify: read-only allow list', () => {
  it.each([
    'SELECT 1',
    '  select * from t',
    '-- note\nSELECT 1',
    '/* c */ # d\nSELECT 1',
    '(SELECT 1) UNION (SELECT 2)',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'WITH RECURSIVE a(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM a WHERE n<3), b AS (SELECT 2) SELECT * FROM a',
    'TABLE t',
    'VALUES ROW(1,2)',
    'SHOW TABLES',
    'DESCRIBE t',
    'DESC t',
    'HELP contents',
    'USE db',
    'EXPLAIN SELECT 1',
    'EXPLAIN FORMAT=JSON SELECT 1',
    'EXPLAIN ANALYZE SELECT * FROM t',
    'SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci',
    'SET CHARACTER SET utf8mb4',
    'SET @autocommit_note = 1',
    'SET @a = 1, @b = 2',
    'SET @a := 1',
    'EXPLAIN t',
    "SET @a = 1, @b = 'x'",
    'SET @a := (SELECT 1, 2)',
    'SET NAMES utf8mb4',
    'COMMIT',
    'ROLLBACK',
    "SELECT 'FOR UPDATE'",
    'SELECT 1 INTO @v',
  ])('allows %s', (sql) => {
    expect(ro(sql)).toBe(true);
  });

  it.each([
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'REPLACE INTO t VALUES (1)',
    'WITH x AS (SELECT 1) UPDATE t SET a = 1',
    'WITH x AS (SELECT 1) DELETE FROM t',
    'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x',
    'SELECT * FROM t FOR UPDATE',
    'SELECT * FROM t FOR SHARE',
    'SELECT * FROM t LOCK IN SHARE MODE',
    "SELECT * INTO OUTFILE '/tmp/x' FROM t",
    "SELECT * FROM t INTO DUMPFILE '/tmp/x'",
    'EXPLAIN ANALYZE UPDATE t SET a = 1',
    'SET autocommit = 0',
    'SET @@autocommit = 1',
    'SET SESSION autocommit=0',
    'SET @a = 1, autocommit = 0',
    'SET NAMES utf8mb4, @@session.transaction_read_only = 0',
    'SET NAMES utf8mb4, transaction_read_only = 0',
    'SET NAMES utf8mb4; ',
    'SET @a = 1, @@session.transaction_read_only = 0',
    'SET @a = 1, SESSION transaction_read_only = 0',
    'SET NAMES utf8mb4 COLLATE x, @a = 1',
    'SET CHARACTER SET utf8mb4, @a = 1',
    'SET TRANSACTION READ WRITE',
    'SET GLOBAL TRANSACTION READ WRITE',
    'SET @@global.tx_read_only = 0',
    'SET @x = (SELECT 1 LOCK IN SHARE MODE)',
    'SET @x = (SELECT id FROM t FOR UPDATE)',
    "SELECT 1.INTO DUMPFILE '/tmp/x'",
    "SELECT 1 FROM t WHERE id=1.INTO DUMPFILE '/tmp/x'",
    'SELECT * FROM t WHERE id=1.FOR UPDATE',
    'SELECT * FROM t WHERE id=.5FOR UPDATE',
    'SELECT * FROM t WHERE id=1e0FOR UPDATE',
    'SELECT * FROM t WHERE id=0x1FOR UPDATE',
    "SELECT 1 FROM t WHERE 1 --\u00a0x INTO DUMPFILE '/tmp/x'",
    "SELECT 1 INTO/**/OUTFILE '/tmp/x'",
    "SELECT 1 INTO\n  OUTFILE '/tmp/x'",
    'SELECT * FROM t WHERE id=1 /*!50000 FOR UPDATE */',
    'SELECT * FROM t WHERE id=1 /*!99999 FOR UPDATE */',
    'SELECT * FROM t WHERE id=1 for share skip locked',
    'SELECT * FROM t FOR UPDATE NOWAIT',
    'COMMIT RELEASE',
    'ROLLBACK RELEASE',
    'COMMIT AND CHAIN RELEASE',
    'EXPLAIN UPDATE t SET a = 1',
    'EXPLAIN DELETE FROM t WHERE id = 1',
    'EXPLAIN FORMAT=TREE INSERT INTO t VALUES (1)',
    'EXPLAIN REPLACE INTO t VALUES (1)',
    "SELECT '\\' INTO DUMPFILE '/tmp/x' -- '",
    "SELECT 'a\\', 'b' INTO OUTFILE '/tmp/x'",
    "SELECT '\\'' FOR UPDATE",
    '\u00a0DELETE FROM t',
    '\ufeffDELETE FROM t',
    'SET GLOBAL read_only = 0',
    'SET SESSION TRANSACTION READ WRITE',
    'SET @@sql_mode = ""',
    'START TRANSACTION READ WRITE',
    'BEGIN',
    'CREATE TABLE t (a int)',
    'DROP TABLE t',
    'TRUNCATE t',
    'CALL p()',
    'LOAD DATA INFILE "x" INTO TABLE t',
    'KILL 1',
    'FLUSH TABLES',
    'GRANT ALL ON *.* TO x',
    '',
    '-- only a comment',
  ])('refuses %s', (sql) => {
    const c = classify(sql);
    expect(c.allowedInReadOnly).toBe(false);
    expect(c.reason).toBeTruthy();
  });
});

describe('classify: kinds and flags', () => {
  it('finds the verb after a CTE', () => {
    expect(classify('WITH x AS (SELECT 1) UPDATE t SET a = 1')).toMatchObject({ kind: 'write', verb: 'UPDATE' });
    expect(classify('WITH x AS (SELECT 1) SELECT 1')).toMatchObject({ kind: 'read', verb: 'SELECT' });
  });

  it('marks implicit commit statements', () => {
    for (const sql of [
      'CREATE TABLE a (id int)',
      'ALTER TABLE a ADD b int',
      'DROP TABLE a',
      'RENAME TABLE a TO b',
      'TRUNCATE a',
      'GRANT SELECT ON a TO b',
      'REVOKE SELECT ON a FROM b',
      'LOCK TABLES a READ',
      'UNLOCK TABLES',
      'ANALYZE TABLE a',
      'CHECK TABLE a',
      'OPTIMIZE TABLE a',
      'REPAIR TABLE a',
      'FLUSH PRIVILEGES',
      'RESET MASTER',
      'LOAD INDEX INTO CACHE a',
      'CACHE INDEX a IN k',
    ]) {
      expect(classify(sql).implicitCommit, sql).toBe(true);
    }
    expect(classify('INSERT INTO a VALUES (1)').implicitCommit).toBe(false);
    expect(classify('SELECT 1').implicitCommit).toBe(false);
  });

  it('flags transaction control', () => {
    expect(classify('BEGIN').transactionControl).toBe('begin');
    expect(classify('start transaction').transactionControl).toBe('begin');
    expect(classify('COMMIT').transactionControl).toBe('commit');
    expect(classify('ROLLBACK').transactionControl).toBe('rollback');
    expect(classify('SET autocommit=0').transactionControl).toBe('set-transaction');
    expect(classify('SET @x = 1').transactionControl).toBeNull();
    expect(classify('SET @autocommit_note = 1').transactionControl).toBeNull();
    expect(classify('SET SESSION TRANSACTION READ ONLY').transactionControl).toBe('set-transaction');
  });

  it('distinguishes SET @x from SET autocommit', () => {
    expect(classify('SET @x = 1')).toMatchObject({ kind: 'session', allowedInReadOnly: true });
    expect(classify('SET autocommit = 1')).toMatchObject({ kind: 'session', allowedInReadOnly: false });
  });

  it('treats USE as a session statement that changes the database', () => {
    expect(classify('USE x')).toMatchObject({ kind: 'session', changesDatabase: true });
  });

  it('is not fooled by keywords in strings, identifiers or comments', () => {
    expect(ro("SELECT 'x' AS `into outfile`")).toBe(true);
    expect(ro('SELECT 1 /* FOR UPDATE */')).toBe(true);
    expect(ro('SELECT 1 -- FOR UPDATE')).toBe(true);
  });

  it('reads executable comments as code but refuses them in read-only', () => {
    // versioned: the server may skip the content, so the classification cannot be trusted
    expect(classify('/*!40101 SET NAMES utf8mb4 */')).toMatchObject({ kind: 'session', allowedInReadOnly: false, executableComment: 'versioned' });
    expect(classify('/*!40101 SET autocommit=0 */').transactionControl).toBe('set-transaction');
  });

  it('refuses transaction and autocommit SETs and RELEASE in every mode', () => {
    for (const sql of [
      'SET autocommit = 1',
      'SET SESSION TRANSACTION READ ONLY',
      'SET @@session.transaction_read_only = 1',
      'SET NAMES utf8mb4, @@session.autocommit = 0',
      'COMMIT RELEASE',
      'ROLLBACK RELEASE',
    ]) {
      expect(classify(sql).alwaysRefuse, sql).toBeTruthy();
    }
    expect(classify('COMMIT AND NO RELEASE').alwaysRefuse).toBeUndefined();
    expect(classify('SET @autocommit_note = 1').alwaysRefuse).toBeUndefined();
  });

  it('knows which statements commit implicitly (temporary tables do not)', () => {
    for (const sql of [
      'SET PASSWORD = \'x\'',
      'CREATE USER a', 'ALTER USER a', 'DROP USER a', 'RENAME USER a TO b', 'CREATE ROLE r', 'DROP ROLE r',
      'INSTALL PLUGIN p SONAME \'x\'', 'UNINSTALL PLUGIN p', 'INSTALL COMPONENT \'x\'', 'UNINSTALL COMPONENT \'x\'',
      'START REPLICA', 'START SLAVE', 'STOP REPLICA', 'STOP SLAVE',
      'CHANGE REPLICATION SOURCE TO SOURCE_HOST=\'h\'', 'CHANGE MASTER TO MASTER_HOST=\'h\'',
      'LOCK INSTANCE FOR BACKUP', 'CLONE LOCAL DATA DIRECTORY = \'/x\'', 'XA START \'a\'', 'SHUTDOWN',
    ]) {
      expect(classify(sql).implicitCommit, sql).toBe(true);
    }
    expect(classify('CREATE TEMPORARY TABLE t (a int)').implicitCommit).toBe(false);
    expect(classify('DROP TEMPORARY TABLE t').implicitCommit).toBe(false);
    expect(classify('CREATE TABLE t (a int)').implicitCommit).toBe(true);
  });

  it('EXPLAIN is allowed for reads only, with a specific message for writes', () => {
    expect(ro('EXPLAIN ANALYZE UPDATE t SET a = 1')).toBe(false);
    expect(ro('EXPLAIN FORMAT=TREE DELETE FROM t')).toBe(false);
    expect(ro('EXPLAIN ANALYZE SELECT 1')).toBe(true);
    expect(ro('EXPLAIN SELECT 1')).toBe(true);
    expect(classify('EXPLAIN UPDATE t SET a = 1').reason).toBe(
      'EXPLAIN de comando de escrita não roda em somente leitura. Use o modo Transação: o EXPLAIN não altera nada.',
    );
  });

  it('the danger scan holds under both backslash rules (NO_BACKSLASH_ESCAPES on or off)', () => {
    // with backslash escapes the quote after \ is literal, without them the string ends there
    expect(ro("SELECT '\\' INTO DUMPFILE '/tmp/x' -- '")).toBe(false);
    expect(ro("SELECT 1 FROM t WHERE a = '\\' OR 1 INTO OUTFILE '/tmp/x' OR a = '\\'")).toBe(false);
    expect(ro("SELECT '\\' FOR UPDATE")).toBe(false);
    expect(ro("SELECT 'a\\'' , 'INTO DUMPFILE'")).toBe(false); // ambiguous between the two modes: refused
    expect(ro("SELECT 'INTO DUMPFILE', 'FOR UPDATE'")).toBe(true); // plainly inside strings: allowed
  });
});

describe('classify: agent bypasses', () => {
  it.each([
    '/*!99999 SELECT 1 */ KILL 123',
    '/*!999999 SELECT 1 */ SET GLOBAL max_connections = 1',
    '/*M! SELECT 1 */ SET GLOBAL offline_mode = ON',
    '/*!99999 SELECT 1 */ DROP TABLE t',
    '/*!99999 SELECT 1 */ COMMIT',
    'SELECT * FROM t FOR/*!99999 x*/UPDATE',
    "SELECT 1 INTO/*!99999 x*/OUTFILE '/tmp/x'",
    'EXPLAIN /*!99999 x */ ANALYZE UPDATE t SET a = 1',
    'SELECT /*! 1 */',
  ])('refuses executable comments in read-only: %s', (sql) => {
    const c = classify(sql);
    expect(c.allowedInReadOnly).toBe(false);
    expect(c.executableComment).toBeDefined();
  });

  it('flags versioned comments as a possible implicit commit', () => {
    expect(classify('/*!99999 SELECT 1 */ CREATE TABLE x (i INT)')).toMatchObject({ executableComment: 'versioned', implicitCommit: true });
  });

  it.each([
    'SET NAMES latin1',
    'SET NAMES gbk',
    'SET NAMES binary',
    "SET NAMES 'sjis'",
    'SET NAMES DEFAULT',
    'SET NAMES utf8',
    'SET CHARACTER SET ascii',
    'SET CHARSET latin1',
    'SET NAMES utf8mb4 COLLATE latin1_swedish_ci',
  ])('refuses client character sets other than utf8mb4: %s', (sql) => {
    expect(ro(sql)).toBe(false);
  });

  it.each(['SET NAMES utf8mb4', "SET NAMES 'utf8mb4'", 'SET NAMES `UTF8MB4` COLLATE utf8mb4_0900_ai_ci', 'SET CHARSET utf8mb4'])(
    'still allows %s',
    (sql) => expect(ro(sql)).toBe(true),
  );

  it.each([
    'SET `autocommit` = 1',
    'SET SESSION `autocommit` = 0',
    'SET @@session.`autocommit` = 0',
    'SET @@session . autocommit = 0',
    'SET @@session./**/autocommit = 0',
    'SET @@`autocommit` = 0',
    'SET `completion_type` = 1',
    "SET 'autocommit' = 1",
    'SET @a = 1, `transaction_read_only` = 0',
    'SET LOCAL transaction_isolation = 1',
  ])('refuses disguised transaction variables in every mode: %s', (sql) => {
    const c = classify(sql);
    expect(c.alwaysRefuse).toBeDefined();
    expect(c.transactionControl).toBe('set-transaction');
  });

  it('keeps user variables named like transaction variables', () => {
    expect(classify('SET @autocommit = 1').alwaysRefuse).toBeUndefined();
  });

  it.each(['COMMIT AND CHAIN', 'COMMIT WORK AND CHAIN', 'ROLLBACK AND CHAIN', 'commit and chain no release'])(
    '%s opens a transaction (refused outside Transação)',
    (sql) => {
      expect(classify(sql)).toMatchObject({ allowedInReadOnly: false, transactionControl: 'begin' });
    },
  );

  it('COMMIT AND NO CHAIN stays a plain commit', () => {
    expect(classify('COMMIT AND NO CHAIN')).toMatchObject({ allowedInReadOnly: true, transactionControl: 'commit' });
  });

  it('CALL and EXECUTE may commit (DDL inside)', () => {
    expect(classify('CALL p()').implicitCommit).toBe(true);
    expect(classify('EXECUTE s').implicitCommit).toBe(true);
  });

  it.each([
    "SELECT asynchronous_connection_failover_add_source('ch1','10.9.9.9',3306,'',50)",
    "SELECT group_replication_set_as_primary('x')",
    "SELECT keyring_key_generate('k','AES',32)",
    "SELECT `audit_log_filter_set_filter`('f','{}')",
    "SELECT version_tokens_set('a=1')",
    "SELECT service_get_write_locks('ns','l',0)",
    "SELECT WAIT_FOR_EXECUTED_GTID_SET('x', 10)",
    "SET @x = (SELECT source_pos_wait('f', 4))",
  ])('refuses server-state functions in read-only: %s', (sql) => {
    expect(ro(sql)).toBe(false);
  });

  it('lists the functions a statement calls', () => {
    expect(classify("SELECT GET_LOCK ('a', 1), sleep(1), `load_file`('/x')").functions).toEqual(
      expect.arrayContaining(['GET_LOCK', 'SLEEP', 'LOAD_FILE']),
    );
  });

  it('flags SET_VAR and MAX_EXECUTION_TIME hints', () => {
    expect(classify('SELECT /*+ SET_VAR(max_execution_time=0) */ SLEEP(55)').setVarHint).toBe(true);
    expect(classify('SELECT /*+ MAX_EXECUTION_TIME(0) */ 1').setVarHint).toBe(true);
    expect(classify('SELECT /*+ NO_INDEX(t) */ 1').setVarHint).toBeUndefined();
  });

  it('reads strings under NO_BACKSLASH_ESCAPES too', () => {
    // with NO_BACKSLASH_ESCAPES the string ends at x\ and the server runs SET GLOBAL
    expect(ro("SET @a = 'x\\', GLOBAL max_connections = 43, @b = 'y'")).toBe(false);
    expect(ro('SET @a = "x\\", GLOBAL max_connections = 43, @b = "y"')).toBe(false);
    expect(ro("SET @a = 'it\\'s'")).toBe(true);
  });
});

describe('warnings and identifiers', () => {
  it.each([
    ['UPDATE t SET a = 1 WHERE 1', 'UPDATE com WHERE sempre verdadeiro'],
    ['UPDATE t SET a = 1 WHERE TRUE', 'UPDATE com WHERE sempre verdadeiro'],
    ['DELETE FROM t WHERE id = id', 'DELETE com WHERE sempre verdadeiro'],
    ['DELETE FROM t WHERE id = 5 OR 1 = 1', 'DELETE com WHERE sempre verdadeiro'],
    ["UPDATE t SET a = 1 WHERE id = 5 OR ('a' = 'a')", 'UPDATE com WHERE sempre verdadeiro'],
    ['DELETE FROM t /*!99999 WHERE id = 1 */', 'DELETE sem WHERE'],
    ['DELETE t FROM t JOIN u ON u.id = t.id', 'DELETE sem WHERE'],
  ])('%s → %s', (sql, alert) => {
    expect(warnings(sql)).toContain(alert);
  });

  it('no alert for an ordinary WHERE', () => {
    expect(warnings('UPDATE t SET a = 1 WHERE id = 5 AND b = 2')).toEqual([]);
  });

  it('alerts on executable comments', () => {
    expect(warnings('UPDATE t SET a = 1 /*M! WHERE id = 5 */ WHERE id = 6').join()).toMatch(/Comentário executável/);
  });

  it('sees digit- and $-leading table names', () => {
    expect(identifiers('INSERT INTO 1log VALUES (1); INSERT INTO $audit VALUES (2)')).toEqual(expect.arrayContaining(['1log', '$audit']));
  });
});
