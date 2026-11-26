import type mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkMysql } from '../../src/renderer/lib/syntax/mysql';
import { observer } from '../support/fixture';
import { INVALID_MYSQL, VALID_MYSQL } from '../support/mysql-corpus';

// The corpora of the syntax lint (tests/support/mysql-corpus.ts) against a real MySQL 8.4: the server's own parser
// has the last word on what is valid. PREPARE reads a statement without running it (nothing is created, changed or
// locked): a syntax error is ER_PARSE_ERROR (1064); anything else (a table that does not exist, a statement that cannot be
// prepared, ER_UNSUPPORTED_PS 1295) means the server parsed it.

const ER_PARSE_ERROR = 1064;

let admin: mysql.Connection;

beforeAll(async () => {
  admin = await observer();
});
afterAll(async () => {
  await admin.end();
});

/** The server's error number for reading the statement, or 0 when it prepared. */
async function prepare(sql: string): Promise<number> {
  try {
    await admin.query('PREPARE corpus FROM ?', [sql]);
    await admin.query('DEALLOCATE PREPARE corpus');
    return 0;
  } catch (error) {
    return (error as { errno?: number }).errno ?? -1;
  }
}

describe('syntax corpus against the server', () => {
  it('every statement the lint takes for valid is valid MySQL', async () => {
    const rejected: string[] = [];
    for (const sql of VALID_MYSQL) {
      if ((await prepare(sql)) === ER_PARSE_ERROR) rejected.push(sql);
    }
    expect(rejected).toEqual([]);
  });

  it('every statement the lint takes for wrong is a syntax error for the server too', async () => {
    const accepted: string[] = [];
    for (const { sql } of INVALID_MYSQL) {
      if ((await prepare(sql)) !== ER_PARSE_ERROR) accepted.push(sql);
    }
    expect(accepted).toEqual([]);
  });

  it('what the server refuses as syntax, the lint flags (the kinds of statement it reads)', async () => {
    for (const { sql } of INVALID_MYSQL) expect(checkMysql(sql), sql).not.toEqual([]);
  });
});
