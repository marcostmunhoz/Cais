import { describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import { MAX_PENDING } from '@shared/agents';
import { decide, MESSAGES, type DecideInput } from '@main/agents/policy';

const dialect = getDialect('mysql');
const analyze = (sql: string) => dialect.splitStatements(sql).map((s) => ({ text: s.text, c: dialect.classify(s.text) }));

function d(sql: string, over: Partial<DecideInput> = {}) {
  return decide({ mode: 'read', production: false, statements: analyze(sql), reason: undefined, pendingCount: 0, grantActive: false, ...over });
}

describe('decide(): the policy table', () => {
  it('read outside production runs straight away', () => {
    expect(d('SELECT 1')).toEqual({ action: 'run' });
    expect(d('SHOW TABLES')).toEqual({ action: 'run' });
    expect(d('USE app; SELECT 1')).toEqual({ action: 'run' });
  });

  it('read in production without a grant asks for approval, and needs a reason', () => {
    expect(d('SELECT 1', { production: true, reason: 'conferir incidente' })).toEqual({ action: 'approve' });
    expect(d('SELECT 1', { production: true })).toMatchObject({ action: 'refuse', code: 'reason_required' });
    expect(d('SELECT 1', { production: true, reason: '   ' })).toMatchObject({ action: 'refuse', code: 'reason_required' });
  });

  it('read in production with an active grant runs straight away', () => {
    expect(d('SELECT 1', { production: true, grantActive: true })).toEqual({ action: 'run' });
  });

  it('write always asks for approval, in any environment, grant or not', () => {
    const base = { mode: 'write' as const, reason: 'corrigir' };
    expect(d("UPDATE t SET a = 1 WHERE id = 1", base)).toEqual({ action: 'approve' });
    expect(d("UPDATE t SET a = 1 WHERE id = 1", { ...base, production: true, grantActive: true })).toEqual({ action: 'approve' });
    expect(d("UPDATE t SET a = 1 WHERE id = 1", { mode: 'write' })).toMatchObject({ action: 'refuse', code: 'reason_required' });
  });

  it('a write command in read mode is refused with the --write hint, even with a reason', () => {
    for (const sql of ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t', 'SELECT * FROM t FOR UPDATE', "SELECT 1 INTO OUTFILE '/tmp/x'"]) {
      expect(d(sql, { reason: 'x' })).toEqual({ action: 'refuse', code: 'writes_in_read', message: MESSAGES.writes });
    }
    expect(MESSAGES.writes).toBe('Este SQL escreve. Peça com --write.');
  });

  it('DDL, implicit commits and transaction control are refused in both modes', () => {
    const sqls = [
      'CREATE TABLE x (a INT)', 'DROP TABLE t', 'ALTER TABLE t ADD c INT', 'TRUNCATE t', 'RENAME TABLE a TO b',
      'LOCK TABLES t WRITE', 'FLUSH TABLES', 'BEGIN', 'START TRANSACTION', 'COMMIT', 'ROLLBACK', 'SET autocommit = 0',
      'SET SESSION transaction_read_only = 0', 'COMMIT RELEASE', 'SET @@autocommit = 1', 'XA START "a"', 'SAVEPOINT a',
    ];
    for (const sql of sqls) {
      for (const mode of ['read', 'write'] as const) {
        expect(d(sql, { mode, reason: 'x' }), `${mode}: ${sql}`).toEqual({ action: 'refuse', code: 'ddl_or_transaction', message: MESSAGES.ddl });
      }
    }
    expect(MESSAGES.ddl).toBe('Agentes não rodam DDL nem controlam transação.');
  });

  it('one forbidden command anywhere in a batch refuses the whole batch', () => {
    expect(d('SELECT 1; UPDATE t SET a = 1; DROP TABLE t', { mode: 'write', reason: 'x' })).toMatchObject({ code: 'ddl_or_transaction' });
    expect(d('UPDATE t SET a = 1 WHERE id = 1; COMMIT', { mode: 'write', reason: 'x' })).toMatchObject({ code: 'ddl_or_transaction' });
  });

  it('in write mode only INSERT, REPLACE, UPDATE, DELETE and the read-only-safe commands pass', () => {
    const ok = ['INSERT INTO t VALUES (1)', 'REPLACE INTO t VALUES (1)', 'UPDATE t SET a = 1 WHERE id = 1', 'DELETE FROM t WHERE id = 1',
      'WITH x AS (SELECT 1) UPDATE t SET a = 1', 'SELECT 1', 'USE app', 'SET @a = 1'];
    for (const sql of ok) expect(d(sql, { mode: 'write', reason: 'x' }), sql).toEqual({ action: 'approve' });
    const no = ['CALL proc()', "LOAD DATA INFILE '/x' INTO TABLE t", "SELECT 1 INTO OUTFILE '/tmp/x'", 'SELECT * FROM t FOR UPDATE', 'KILL 1', 'DO SLEEP(1)', 'HANDLER t OPEN'];
    for (const sql of no) expect(d(sql, { mode: 'write', reason: 'x' }), sql).toMatchObject({ action: 'refuse' });
  });

  it('an empty SQL is refused', () => {
    expect(d('   ')).toMatchObject({ action: 'refuse', code: 'empty_sql' });
    expect(d('-- só um comentário')).toMatchObject({ action: 'refuse', code: 'empty_sql' });
  });

  it('more than 20 pending requests: the 21st that needs approval is refused, a direct read is not', () => {
    const full = { pendingCount: MAX_PENDING, reason: 'x' };
    expect(d('SELECT 1', { ...full, production: true })).toMatchObject({ action: 'refuse', code: 'queue_full' });
    expect(d('UPDATE t SET a = 1 WHERE id = 1', { ...full, mode: 'write' })).toMatchObject({ action: 'refuse', code: 'queue_full' });
    expect(d('SELECT 1', { ...full, pendingCount: MAX_PENDING - 1, production: true })).toEqual({ action: 'approve' });
    expect(d('SELECT 1', full)).toEqual({ action: 'run' });
  });

  it('the refusal order is: forbidden, then writes-in-read, then reason, then queue', () => {
    expect(d('DROP TABLE t', { production: true })).toMatchObject({ code: 'ddl_or_transaction' });
    expect(d('UPDATE t SET a = 1', { production: true })).toMatchObject({ code: 'writes_in_read' });
    expect(d('SELECT 1', { production: true, pendingCount: 99 })).toMatchObject({ code: 'reason_required' });
  });
});

describe('dialect warnings', () => {
  const w = (sql: string) => dialect.warnings(sql);
  it('flags UPDATE and DELETE without WHERE', () => {
    expect(w('UPDATE cards SET status = 1')).toEqual(['UPDATE sem WHERE']);
    expect(w('DELETE FROM cards')).toEqual(['DELETE sem WHERE']);
    expect(w('WITH x AS (SELECT 1) DELETE FROM cards')).toEqual(['DELETE sem WHERE']);
    expect(w('UPDATE t SET a = (SELECT 1 FROM u WHERE u.id = 1)')).toEqual(['UPDATE sem WHERE']);
  });
  it('stays quiet when there is a WHERE', () => {
    expect(w('UPDATE cards SET status = 1 WHERE id = 3')).toEqual([]);
    expect(w("DELETE FROM cards WHERE note = 'sem where'")).toEqual([]);
    expect(w('SELECT 1')).toEqual([]);
    expect(w('INSERT INTO t SELECT * FROM u')).toEqual([]);
    expect(w('/* where */ DELETE FROM cards')).toEqual(['DELETE sem WHERE']);
  });
});
