import { describe, expect, it } from 'vitest';
import { capabilitiesOf, connectionTargetKey, initialModeFor, sameTarget } from '@shared/engines';

describe('engine capabilities', () => {
  it('MySQL takes the three modes and grid editing', () => {
    expect(capabilitiesOf('mysql')).toEqual({ modes: ['read-only', 'transaction', 'autocommit'], gridEdit: true });
  });
  it('the initial mode follows production and what the engine accepts', () => {
    const mysql = capabilitiesOf('mysql');
    expect(initialModeFor(mysql, true)).toBe('read-only');
    expect(initialModeFor(mysql, false)).toBe('autocommit');
    expect(initialModeFor({ modes: ['read-only'], gridEdit: false }, false)).toBe('read-only');
    expect(initialModeFor({ modes: ['transaction', 'read-only'], gridEdit: false }, false)).toBe('transaction');
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
