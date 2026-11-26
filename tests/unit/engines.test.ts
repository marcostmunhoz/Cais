import { describe, expect, it } from 'vitest';
import { capabilitiesOf, connectionTargetKey, fixedModeOf, GIB, initialModeFor, isBigqueryDatasetId, isGcpProjectId, sameTarget } from '@shared/engines';
import { engineVersionLabel, getDialect } from '@shared/dialects/registry';

describe('engine capabilities', () => {
  it('MySQL takes the three modes and grid editing', () => {
    expect(capabilitiesOf('mysql')).toEqual({ modes: ['read-only', 'transaction', 'autocommit'], gridEdit: true, lazyColumns: false, dryRun: false });
  });
  it('the initial mode follows production and what the engine accepts', () => {
    const mysql = capabilitiesOf('mysql');
    expect(initialModeFor(mysql, true)).toBe('read-only');
    expect(initialModeFor(mysql, false)).toBe('autocommit');
    expect(initialModeFor({ modes: ['read-only'], gridEdit: false }, false)).toBe('read-only');
    expect(initialModeFor({ modes: ['transaction', 'read-only'], gridEdit: false }, false)).toBe('transaction');
  });
});

describe('the mode picker', () => {
  it('an engine with one mode has nothing to pick: that mode is fixed', () => {
    expect(fixedModeOf(capabilitiesOf('bigquery'))).toBe('read-only');
    expect(fixedModeOf({ modes: ['autocommit'], gridEdit: false })).toBe('autocommit');
  });
  it('an engine with more than one mode has a picker, and none is fixed', () => {
    expect(fixedModeOf(capabilitiesOf('mysql'))).toBeNull();
    expect(fixedModeOf({ modes: ['read-only', 'transaction'], gridEdit: false })).toBeNull();
  });
  it('an engine with no mode at all is not a badge either', () => {
    expect(fixedModeOf({ modes: [], gridEdit: false })).toBeNull();
  });
});

describe('connection target', () => {
  const a = { host: 'h', port: 3306, credentialId: 'c' };
  it('compares host, port and credential', () => {
    expect(sameTarget(a, { ...a })).toBe(true);
    expect(sameTarget(a, { ...a, host: 'x' })).toBe(false);
    expect(sameTarget(a, { ...a, port: 3307 })).toBe(false);
    expect(sameTarget(a, { ...a, credentialId: 'd' })).toBe(false);
    expect(connectionTargetKey(a)).not.toBe(connectionTargetKey({ host: 'h3306', port: 0, credentialId: 'c' }));
  });
});

describe('BigQuery engine', () => {
  it('only reads: one mode, no grid editing', () => {
    expect(capabilitiesOf('bigquery')).toEqual({ modes: ['read-only'], gridEdit: false, lazyColumns: true, dryRun: true });
    expect(initialModeFor(capabilitiesOf('bigquery'), false)).toBe('read-only');
    expect(initialModeFor(capabilitiesOf('bigquery'), true)).toBe('read-only');
  });

  const bq = { engine: 'bigquery' as const, gcpProject: 'my-project-1', credentialId: 'c', maxBytesBilled: 100 * GIB };
  it('compares the project, the byte limit and the credential', () => {
    expect(sameTarget(bq, { ...bq })).toBe(true);
    expect(sameTarget(bq, { ...bq, gcpProject: 'other-project' })).toBe(false);
    expect(sameTarget(bq, { ...bq, maxBytesBilled: 10 * GIB })).toBe(false);
    expect(sameTarget(bq, { ...bq, maxBytesBilled: undefined })).toBe(false);
    expect(sameTarget(bq, { ...bq, credentialId: 'd' })).toBe(false);
    expect(connectionTargetKey({ ...bq, maxBytesBilled: undefined })).toBe(connectionTargetKey({ engine: 'bigquery', gcpProject: 'my-project-1', credentialId: 'c' }));
  });

  it('a MySQL target is never the same as a BigQuery one', () => {
    expect(sameTarget(bq, { host: 'my-project-1', port: 0, credentialId: 'c' })).toBe(false);
  });

  it('knows a Google Cloud project id', () => {
    for (const ok of ['my-project-1', 'abcdef', 'a'.repeat(30), 'example.com:my-project', 'sub.example.com:proj-123']) expect(isGcpProjectId(ok), ok).toBe(true);
    for (const bad of ['', 'short', 'a'.repeat(31), 'My-Project', '1project', 'project-', 'my_project', 'my project', 'ex ample.com:proj1', ':project', 'example:project1', 'a/b-project', '../x-project', 'proj\n-1']) {
      expect(isGcpProjectId(bad), bad).toBe(false);
    }
  });

  it('knows a dataset id', () => {
    expect(isBigqueryDatasetId('sales_2026')).toBe(true);
    for (const bad of ['', 'a-b', 'a.b', 'a b', 'a/b', '`x`', 'x'.repeat(1025)]) expect(isBigqueryDatasetId(bad), bad).toBe(false);
  });
});

describe('what the interface asks the engine for', () => {
  it('each engine has its own word for the namespace and says whether columns are read per dataset', () => {
    expect(getDialect('mysql').databaseTerm).toBe('database');
    expect(getDialect('bigquery').databaseTerm).toBe('dataset');
    expect(capabilitiesOf('mysql').lazyColumns).toBe(false);
    expect(capabilitiesOf('bigquery').lazyColumns).toBe(true);
  });

  it('the server version is shown with the engine name, and an engine without one shows its name once', () => {
    expect(engineVersionLabel('mysql', '8.4.0')).toBe('MySQL 8.4.0');
    expect(engineVersionLabel('bigquery', 'BigQuery')).toBe('BigQuery');
  });
});
