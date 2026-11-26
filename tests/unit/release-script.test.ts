import { describe, expect, it } from 'vitest';
import { compareVersions, decidePath, evaluateCheck, latestVersion, parseVersion } from '../../scripts/release.mjs';

describe('versions', () => {
  it('compares numerically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.10.0')).toBeLessThan(0);
  });
  it('rejects invalid versions', () => {
    for (const v of ['1.2', 'v1.2.3', '1.2.3-rc.1', '1.2.x', '', ' 1.2.3']) expect(parseVersion(v)).toBeNull();
    expect(() => compareVersions('1.2', '1.2.3')).toThrow();
  });
  it('finds the latest v* tag numerically', () => {
    expect(latestVersion(['v0.9.0', 'v0.10.0', 'v0.1.1', 'nightly', 'v1.0'])).toBe('0.10.0');
    expect(latestVersion([])).toBeNull();
  });
});

describe('decidePath', () => {
  const base = { version: '0.2.0', packageVersion: '0.1.1', latestTag: '0.1.1', tagExists: false };
  it('already bumped goes straight to the tag', () => {
    expect(decidePath({ ...base, packageVersion: '0.2.0' })).toEqual({ path: 'tag' });
  });
  it('needs a release PR when package.json is behind', () => {
    expect(decidePath(base)).toEqual({ path: 'pr' });
  });
  it('fails when the version does not increase', () => {
    expect(decidePath({ ...base, version: '0.1.1' }).error).toMatch(/not greater/);
    expect(decidePath({ ...base, version: '0.1.0' }).error).toMatch(/not greater/);
  });
  it('fails when package.json is already past the version', () => {
    expect(decidePath({ ...base, packageVersion: '0.3.0' }).error).toMatch(/already past/);
  });
  it('fails when the tag exists', () => {
    expect(decidePath({ ...base, tagExists: true }).error).toMatch(/already exists/);
  });
  it('fails on an invalid version', () => {
    expect(decidePath({ ...base, version: '2' }).error).toMatch(/not x\.y\.z/);
  });
});

describe('evaluateCheck', () => {
  const run = (status: string, conclusion: string | null) => [{ name: 'check', status, conclusion }];
  const ci = (conclusion: string | null, status = 'completed') => [{ status, conclusion }];
  it('success', () => expect(evaluateCheck(run('completed', 'success'), ci('success')).state).toBe('ok'));
  it('skipped with a successful CI run', () =>
    expect(evaluateCheck(run('completed', 'skipped'), ci('success')).state).toBe('ok'));
  it('skipped with a failed CI run', () =>
    expect(evaluateCheck(run('completed', 'skipped'), ci('failure')).state).toBe('failed'));
  it('skipped with no CI run', () => expect(evaluateCheck(run('completed', 'skipped'), []).state).toBe('failed'));
  it('pending', () => expect(evaluateCheck(run('in_progress', null), ci(null, 'in_progress')).state).toBe('pending'));
  it('failure', () => expect(evaluateCheck(run('completed', 'failure'), ci('failure')).state).toBe('failed'));
  it('cancelled', () => expect(evaluateCheck(run('completed', 'cancelled'), ci('cancelled')).state).toBe('failed'));
  it('missing', () => {
    expect(evaluateCheck([], ci('success')).state).toBe('missing');
    expect(evaluateCheck(undefined, undefined).state).toBe('missing');
  });
});
