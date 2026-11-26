// settings.json and "Estimate while typing": an optional preference of the person, outside the agent seal.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Seal } from '@main/store/seal';
import { SettingsStore } from '@main/store/settings';
import { FakeVault } from '@main/store/vault';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cais-settings-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = () => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));

describe('estimateAsYouType', () => {
  it('is off with no file and with a file written before the field existed', async () => {
    const none = new SettingsStore(dir);
    await none.load();
    expect(none.estimateAsYouType).toBe(false);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, agentAccess: false }));
    const old = new SettingsStore(dir);
    await old.load();
    expect(old.estimateAsYouType).toBe(false);
    expect(old.notice).toBeUndefined();
  });

  it('is kept across runs and does not touch the agent switch', async () => {
    const s = new SettingsStore(dir);
    await s.load();
    await s.setEstimateAsYouType(true);
    expect(file()).toEqual({ version: 1, agentAccess: false, estimateAsYouType: true });
    const again = new SettingsStore(dir);
    await again.load();
    expect(again.estimateAsYouType).toBe(true);
    expect(again.agentAccess).toBe(false);
    await again.setEstimateAsYouType(false);
    expect(file().estimateAsYouType).toBe(false);
  });

  it('turning agent access on or off keeps the preference, and the other way round', async () => {
    const s = new SettingsStore(dir);
    await s.load();
    await s.setEstimateAsYouType(true);
    await s.setAgentAccess(true);
    expect(file()).toEqual({ version: 1, agentAccess: true, estimateAsYouType: true });
    await s.setAgentAccess(false);
    expect(file()).toEqual({ version: 1, agentAccess: false, estimateAsYouType: true });
    await s.setAgentAccess(true);
    await s.setEstimateAsYouType(false);
    expect(file()).toEqual({ version: 1, agentAccess: true, estimateAsYouType: false });
  });

  it('is outside the seal: a sealed "on" stays on after the preference changes, and the preference needs no signature', async () => {
    const seal = new Seal(dir, new FakeVault());
    await seal.load();
    const s = new SettingsStore(dir, seal);
    await s.load();
    await s.setAgentAccess(true);
    await s.setEstimateAsYouType(true);
    const seal2 = new Seal(dir, new FakeVault());
    await seal2.load();
    const next = new SettingsStore(dir, seal2);
    await next.load();
    expect(next.agentAccess).toBe(true);
    expect(next.tampered).toBe(false);
    expect(next.estimateAsYouType).toBe(true);
    // written by hand: it counts as written (the switch gives agents nothing), and the agent switch is still checked
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, agentAccess: true, estimateAsYouType: false }));
    const edited = new SettingsStore(dir, seal2);
    await edited.load();
    expect(edited.estimateAsYouType).toBe(false);
    expect(edited.agentAccess).toBe(true);
  });

  it('a value that is not a boolean sets the file aside, like any other bad field', async () => {
    writeFileSync(join(dir, 'settings.json'), '{"version":1,"agentAccess":false,"estimateAsYouType":"yes"}');
    const bad = new SettingsStore(dir);
    await bad.load();
    expect(bad.estimateAsYouType).toBe(false);
    expect(bad.notice).toContain('settings.json');
  });
});
