// Optional live suite against a real BigQuery project. It is not part of `npm run check`.
//
// How to run (a sandbox project of your own; the token is the one from your own gcloud, which you run; this suite never does):
//
//   export CAIS_BQ_LIVE_PROJECT=<project id>
//   export CAIS_BQ_LIVE_TOKEN=$(gcloud auth print-access-token)
//   npm run live:bigquery
//
// The token lasts about an hour (a 401 means generate another). Without both variables every test is skipped. The account
// needs roles/bigquery.jobUser on the project (and roles/bigquery.dataViewer on the datasets it reads). It only reads:
// dry runs and queries without a table (0 bytes), metadata and a cancel; the SELECT on a public table runs only with a
// 1-byte cap and is refused without charge. DML and DDL are only ever dry-run.
//
// Optional variables:
//   CAIS_BQ_LIVE_DATASET   a dataset of that project (default cais_live_dataset) used by the DML and DDL statements of the
//                          corpus. It must exist, with tables t (id INT64, a INT64) and s (id INT64) and a procedure p(),
//                          or the server answers notFound and the test only records it.
//   CAIS_BQ_LIVE_ROUTINE   "dataset.routine": a persistent scalar function of one INT64 argument, for example created with
//                          CREATE FUNCTION my_dataset.f(x INT64) AS (x + 1). Turns on the routines test.
//   CAIS_BQ_LIVE_VIEW      "dataset.view": a view whose definition calls that routine, for example created with
//                          CREATE VIEW my_dataset.v AS SELECT my_dataset.f(1) AS a. Turns on the test that checks the
//                          server lists a routine reached only through a view (docs/seguranca.md says why it matters).
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
  ['SELECT * FROM UNNEST([1, 2, 3]) AS n |> WHERE n > 1', 'SELECT'],
  [`FROM ${SHAKESPEARE} |> WHERE word_count > 1 |> SELECT word`, 'SELECT'],
  [`SELECT word FROM ${SHAKESPEARE} LIMIT 3`, 'SELECT'],
  ["SELECT ';' AS semicolon", 'SELECT'],
  ['SELECT 1 -- DROP TABLE t', 'SELECT'],
  [`INSERT INTO \`${dataset}.t\` (a) VALUES (1)`, 'INSERT'],
  [`UPDATE \`${dataset}.t\` SET a = 1 WHERE TRUE`, 'UPDATE'],
  [`DELETE FROM \`${dataset}.t\` WHERE TRUE`, 'DELETE'],
  [`MERGE \`${dataset}.t\` T USING \`${dataset}.s\` S ON T.id = S.id WHEN MATCHED THEN DELETE`, 'MERGE'],
  [`TRUNCATE TABLE \`${dataset}.t\``, 'TRUNCATE_TABLE'],
  [`CREATE TABLE \`${dataset}.cais_live_new\` (a INT64)`, 'CREATE_TABLE'],
  // outside a script or session the server refuses it in the dry run ("requires a script or session")
  ['CREATE TEMP TABLE t AS SELECT 1', 'error:invalid'],
  [`DROP TABLE \`${dataset}.t\``, 'DROP_TABLE'],
  ['DECLARE x INT64 DEFAULT 1', 'SCRIPT'],
  ['BEGIN SELECT 1; END', 'SCRIPT'],
  ['IF TRUE THEN SELECT 1; END IF', 'SCRIPT'],
  ['SELECT 1; SELECT 2', 'SCRIPT'],
  ['BEGIN TRANSACTION', 'BEGIN_TRANSACTION'],
  ['COMMIT TRANSACTION', 'COMMIT_TRANSACTION'],
  [`CALL \`${dataset}.p\`()`, 'SCRIPT'],
  ["EXECUTE IMMEDIATE 'SELECT 1'", 'SCRIPT'],
  ["EXPORT DATA OPTIONS(uri='gs://nowhere/x*.csv', format='CSV') AS SELECT 1", 'EXPORT_DATA'],
  ['ASSERT 1 = 1', 'ASSERT'],
  // the directive against useLegacySql: false is a 400 ("Query text specifies use_legacy_sql:true...")
  ['#legacySQL\nSELECT 1', 'error:invalid'],
  // checked against the real server: in a raw string a backslash does not escape the quote but keeps the next quote from closing it
  // (server text r'\'' is a valid 2-character string; r'\' is "Unclosed raw string literal", a syntax error)
  ["SELECT r'\\''", 'SELECT'],
  ["SELECT r'\\'", 'error:invalidQuery'],
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

  it('the raw-string rule the server follows holds, through the same dry run the driver uses (jobs.insert)', async () => {
    const session = await driver.open(params());
    expect((await session.prepare!("SELECT r'\\''")).serverKind).toBe('SELECT');
    const unclosed = await session.prepare!("SELECT r'\\'");
    expect(unclosed.serverKind).toBeUndefined();
    expect(unclosed.error?.code).toBe('invalidQuery');
    await session.close();
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

// Optional: CAIS_BQ_LIVE_ROUTINE is a persistent scalar function of one INT64 argument, as "dataset.routine" (for example my_dataset.f).
const routine = process.env.CAIS_BQ_LIVE_ROUTINE;

describe.skipIf(!live || !routine)('BigQuery live: routines in the dry run', () => {
  it('prepare() reports the routine a statement calls, as dataset.routine and without the project', async () => {
    const session = await driver.open(params());
    const prepared = await session.prepare!(`SELECT \`${routine}\`(1)`);
    expect(prepared.error).toBeUndefined();
    expect(prepared.routines).toContain(routine);
    expect(JSON.stringify(prepared)).not.toContain(project!);
    await session.close();
  });
});

// Optional: CAIS_BQ_LIVE_VIEW is "dataset.view", a view whose definition calls CAIS_BQ_LIVE_ROUTINE (for example my_dataset.v).
const view = process.env.CAIS_BQ_LIVE_VIEW;

describe.skipIf(!live || !routine || !view)('BigQuery live: a routine inside a view', () => {
  it('prepare() reports the routine the view calls when the statement only reads the view', async () => {
    const session = await driver.open(params());
    const prepared = await session.prepare!(`SELECT * FROM \`${view}\``);
    expect(prepared.error).toBeUndefined();
    expect(prepared.routines).toContain(routine);
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
    // a script the server dry-runs as SCRIPT (a CREATE TEMP TABLE fails the dry run itself, outside a session)
    const r = await session.execute('SELECT 1; SELECT 2', { maxRows: 10 });
    expect(r.error?.code).toBe('REFUSED');
    expect(r.error?.message).toContain('SCRIPT');
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
    // a safety net if the cancel ever fails: the job stops itself after a minute
    await session.applyLimits!({ maxExecutionMs: 60_000 });
    // no table, 0 bytes; GENERATE_ARRAY stops at about a million elements, so the length comes from the joins
    const running = session.execute(
      'SELECT SUM(MOD(a * b + c, 7)) FROM UNNEST(GENERATE_ARRAY(1, 1000000)) a CROSS JOIN UNNEST(GENERATE_ARRAY(1, 1000000)) b CROSS JOIN UNNEST(GENERATE_ARRAY(1, 1000)) c',
      { maxRows: 10 },
    );
    await new Promise((r) => setTimeout(r, 4000));
    await session.cancel();
    const r = await running;
    expect(r.error?.code).toBe('CANCELLED');
    await session.close();
  });
});
