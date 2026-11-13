// Optional live suite against a real BigQuery project. It is not part of `npm run check`:
//
//   CAIS_BQ_LIVE_PROJECT=<sandbox project id> CAIS_BQ_LIVE_TOKEN=$(gcloud auth print-access-token) npm run live:bigquery
//
// The token comes from the environment: this suite never runs gcloud. It only reads (dry runs, SELECTs on public
// data, metadata, a cancel). Without both variables every test is skipped. Optional: CAIS_BQ_LIVE_DATASET, a
// dataset of that project whose statements may be dry-run against (DML and DDL are only ever dry-run, never run).
import { describe, expect, it } from 'vitest';
import { classify } from '@shared/dialects/bigquery';
import { createBigqueryDriver } from '@main/drivers/bigquery';
import type { BigqueryConnectParams } from '@main/drivers/types';

const project = process.env.CAIS_BQ_LIVE_PROJECT;
const token = process.env.CAIS_BQ_LIVE_TOKEN;
const live = !!project && !!token;
const dataset = process.env.CAIS_BQ_LIVE_DATASET ?? 'cais_live_dataset';

const driver = createBigqueryDriver({});
const params = (over: Partial<BigqueryConnectParams> = {}): BigqueryConnectParams => ({
  engine: 'bigquery',
  project: project ?? 'unset-project',
  accessToken: token ?? '',
  origin: 'person',
  ...over,
});

const SHAKESPEARE = '`bigquery-public-data.samples.shakespeare`';

// The same classes as the dialect's unit corpus: [statement, what the server should call it when it can tell].
const corpus: [string, string][] = [
  ['SELECT 1', 'SELECT'],
  ['select 1 as a', 'SELECT'],
  ['(SELECT 1)', 'SELECT'],
  ['WITH a AS (SELECT 1 AS x) SELECT x FROM a', 'SELECT'],
  ['FROM UNNEST([1, 2, 3]) AS n |> WHERE n > 1', 'SELECT'],
  [`SELECT word FROM ${SHAKESPEARE} LIMIT 3`, 'SELECT'],
  ["SELECT ';' AS semicolon", 'SELECT'],
  ['SELECT 1 -- DROP TABLE t', 'SELECT'],
  [`INSERT INTO \`${dataset}.t\` (a) VALUES (1)`, 'INSERT'],
  [`UPDATE \`${dataset}.t\` SET a = 1 WHERE TRUE`, 'UPDATE'],
  [`DELETE FROM \`${dataset}.t\` WHERE TRUE`, 'DELETE'],
  [`MERGE \`${dataset}.t\` T USING \`${dataset}.s\` S ON T.id = S.id WHEN MATCHED THEN DELETE`, 'MERGE'],
  [`TRUNCATE TABLE \`${dataset}.t\``, 'TRUNCATE_TABLE'],
  [`CREATE TABLE \`${dataset}.t\` (a INT64)`, 'CREATE_TABLE'],
  ['CREATE TEMP TABLE t AS SELECT 1', 'CREATE_TABLE_AS_SELECT'],
  [`DROP TABLE \`${dataset}.t\``, 'DROP_TABLE'],
  ['DECLARE x INT64 DEFAULT 1', 'SCRIPT'],
  ['BEGIN SELECT 1; END', 'SCRIPT'],
  ['IF TRUE THEN SELECT 1; END IF', 'SCRIPT'],
  ['SELECT 1; SELECT 2', 'SCRIPT'],
  ['BEGIN TRANSACTION', 'BEGIN_TRANSACTION'],
  ['COMMIT TRANSACTION', 'COMMIT_TRANSACTION'],
  [`CALL \`${dataset}.p\`()`, 'CALL'],
  ["EXECUTE IMMEDIATE 'SELECT 1'", 'SCRIPT'],
  ["EXPORT DATA OPTIONS(uri='gs://nowhere/x*.csv', format='CSV') AS SELECT 1", 'EXPORT_DATA'],
  ['ASSERT 1 = 1', 'ASSERT'],
  ['#legacySQL\nSELECT 1', 'SELECT'],
];

describe.skipIf(!live)('BigQuery live: what the server says about each statement', () => {
  it('a statement the classifier lets through is always a SELECT to the server (the two layers agree)', async () => {
    const disagreements: string[] = [];
    const report: string[] = [];
    for (const [sql, expected] of corpus) {
      const session = await driver.open(params());
      const prepared = await session.prepare!(sql);
      await session.close();
      const allowed = classify(sql).allowedInReadOnly;
      const server = prepared.serverKind ?? (prepared.error ? `error:${prepared.error.code}` : 'none');
      report.push(`${allowed ? 'allow ' : 'refuse'} | server=${server} | expected=${expected} | ${sql.replace(/\n/g, ' ')}`);
      // the safety property: the classifier allows only what the server reads as SELECT (an error means it never runs)
      if (allowed && prepared.serverKind !== undefined && prepared.serverKind !== 'SELECT') disagreements.push(sql);
      // the server saying SELECT for something the classifier refuses is a missed query, not a danger: only reported
    }
    console.log(report.join('\n'));
    expect(disagreements).toEqual([]);
  });

  it('the dry run gives the statementType of a plain SELECT and a byte estimate', async () => {
    const session = await driver.open(params());
    const prepared = await session.prepare!(`SELECT word FROM ${SHAKESPEARE}`);
    expect(prepared.error).toBeUndefined();
    expect(prepared.serverKind).toBe('SELECT');
    expect(prepared.bytesEstimated).toBeGreaterThan(0);
    await session.close();
  });
});

describe.skipIf(!live)('BigQuery live: reading', () => {
  it('runs a SELECT and reads the pages up to the cap, then more with a refetch and no new job', async () => {
    const session = await driver.open(params());
    const sql = 'SELECT n FROM UNNEST(GENERATE_ARRAY(1, 25000)) AS n ORDER BY n';
    const first = await session.execute(sql, { maxRows: 12_000 });
    expect(first.error).toBeUndefined();
    expect(first.rows).toHaveLength(12_000);
    expect(first.truncated).toBe(true);
    expect(first.columns![0]).toMatchObject({ name: 'n', type: 'INT64' });
    expect(first.rows![0]).toEqual(['1']);
    expect(first.stats?.jobId).toBeTruthy();
    const again = await session.execute(sql, { maxRows: 50_000, refetch: true });
    expect(again.error).toBeUndefined();
    expect(again.rows).toHaveLength(25_000);
    expect(again.truncated).toBeUndefined();
    expect(again.stats?.jobId).toBe(first.stats?.jobId);
    await session.close();
  });

  it('reads the value types the way the driver says', async () => {
    const session = await driver.open(params());
    const r = await session.execute(
      `SELECT 9223372036854775807 AS i, NUMERIC '1.5' AS num, 2.5 AS f, TRUE AS b, TIMESTAMP '2026-10-01 09:12:44.123456+00' AS ts,
              DATE '2026-10-01' AS d, B'ab' AS bytes, STRUCT(1 AS a, [1, 2] AS xs) AS s, [1, 2] AS arr`,
      { maxRows: 10 },
    );
    expect(r.error).toBeUndefined();
    const row = r.rows![0]!;
    expect(row[0]).toBe('9223372036854775807');
    expect(row[1]).toBe('1.5');
    expect(row[2]).toBe(2.5);
    expect(row[3]).toBe('true');
    expect(row[4]).toBe('2026-10-01 09:12:44.123456 UTC');
    expect(row[5]).toBe('2026-10-01');
    expect(row[6]).toEqual({ kind: 'binary', hex: '6162', length: 2 });
    expect(JSON.parse(row[7] as string)).toEqual({ a: '1', xs: ['1', '2'] });
    expect(row[8]).toBe('["1","2"]');
    expect(r.columns!.map((c) => c.type)).toEqual(['INT64', 'NUMERIC', 'FLOAT64', 'BOOL', 'TIMESTAMP', 'DATE', 'BYTES', 'STRUCT<a INT64, xs ARRAY<INT64>>', 'ARRAY<INT64>']);
    await session.close();
  });

  it('refuses a statement the server reads as another type, without running it', async () => {
    const session = await driver.open(params());
    const r = await session.execute('CREATE TEMP TABLE cais_live_t AS SELECT 1', { maxRows: 10 });
    expect(r.error?.code).toBe('REFUSED');
    await session.close();
  });

  it('a very low maximumBytesBilled fails without cost', async () => {
    const session = await driver.open(params());
    const r = await session.execute(`SELECT * FROM ${SHAKESPEARE}`, { maxRows: 10, maxBytesBilled: 1 });
    expect(r.error?.code).toBe('bytesBilledLimitExceeded');
    expect(r.stats?.bytesBilled ?? 0).toBe(0);
    await session.close();
  });

  it('a table that does not exist is a notFound with a message', async () => {
    const session = await driver.open(params());
    const r = await session.execute(`SELECT * FROM \`${project}.cais_live_does_not_exist.t\``, { maxRows: 10 });
    expect(r.error?.code).toBe('notFound');
    expect(r.error!.message.length).toBeGreaterThan(0);
    await session.close();
  });

  it('a syntax error is an invalid query with the server text', async () => {
    const session = await driver.open(params());
    const r = await session.execute('SELEC 1', { maxRows: 10 });
    expect(r.error?.code).toBe('invalidQuery');
    expect(r.error!.detail).toBeTruthy();
    await session.close();
  });

  it('a token the server does not accept is an error and not a loop', async () => {
    const session = await driver.open(params({ accessToken: 'not-a-token' }));
    const r = await session.execute('SELECT 1', { maxRows: 10 });
    expect(r.error).toBeDefined();
    await session.close();
  });
});

describe.skipIf(!live)('BigQuery live: metadata and control', () => {
  it('lists the datasets (the sandbox may have none)', async () => {
    const tree = await driver.introspect(params());
    expect(Array.isArray(tree.databases)).toBe(true);
  });

  it('test() passes with a good token and the jobs.create permission', async () => {
    expect((await driver.test(params())).serverVersion).toBe('BigQuery');
  });

  it('useDatabase: a dataset that is not there is an error', async () => {
    const session = await driver.open(params());
    const r = await session.useDatabase('cais_live_does_not_exist');
    expect(r.error?.code).toBe('notFound');
    await session.close();
  });

  it('cancel stops a long query', async () => {
    const session = await driver.open(params());
    const running = session.execute(
      'SELECT COUNT(*) FROM UNNEST(GENERATE_ARRAY(1, 2000000000)) a CROSS JOIN UNNEST(GENERATE_ARRAY(1, 1000)) b',
      { maxRows: 10 },
    );
    await new Promise((r) => setTimeout(r, 4000));
    await session.cancel();
    const r = await running;
    expect(r.error?.code).toBe('CANCELLED');
    await session.close();
  });
});
