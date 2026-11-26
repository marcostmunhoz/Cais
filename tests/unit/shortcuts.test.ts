import { describe, expect, it } from 'vitest';
import { isDeleteRowsKey, shortcutText, type ShortcutId } from '@shared/shortcuts';

const IDS: ShortcutId[] = ['run', 'cancel', 'save', 'saveAs', 'newTab', 'open', 'closeTab', 'runAll', 'deleteRows'];

describe('shortcutText', () => {
  it('uses symbols on macOS', () => {
    expect(shortcutText('run', 'darwin')).toBe('⌘↵');
    expect(shortcutText('cancel', 'darwin')).toBe('⌘.');
    expect(shortcutText('saveAs', 'darwin')).toBe('⇧⌘S');
    expect(shortcutText('runAll', 'darwin')).toBe('⇧⌘↵');
  });

  it('spells out Ctrl elsewhere', () => {
    expect(shortcutText('run', 'linux')).toBe('Ctrl+Enter');
    expect(shortcutText('cancel', 'win32')).toBe('Ctrl+.');
    expect(shortcutText('saveAs', 'linux')).toBe('Ctrl+Shift+S');
    expect(shortcutText('runAll', 'linux')).toBe('Ctrl+Shift+Enter');
  });

  it('has a distinct label for every id on both sides', () => {
    for (const platform of ['darwin', 'linux']) {
      const labels = IDS.map((id) => shortcutText(id, platform));
      expect(new Set(labels).size).toBe(IDS.length);
    }
  });
});

describe('isDeleteRowsKey', () => {
  const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it('matches the shortcut text: Delete everywhere, and Backspace on macOS where the key is labelled delete', () => {
    expect(shortcutText('deleteRows', 'linux')).toBe('Delete');
    expect(isDeleteRowsKey(key('Delete'), 'linux')).toBe(true);
    expect(isDeleteRowsKey(key('Delete'), 'darwin')).toBe(true);
    expect(shortcutText('deleteRows', 'darwin')).toBe('⌫');
    expect(isDeleteRowsKey(key('Backspace'), 'darwin')).toBe(true);
    expect(isDeleteRowsKey(key('Backspace'), 'linux')).toBe(false);
  });

  it('never with a modifier, and never for other keys', () => {
    for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
      expect(isDeleteRowsKey(key('Delete', mods), 'linux')).toBe(false);
      expect(isDeleteRowsKey(key('Backspace', mods), 'darwin')).toBe(false);
    }
    expect(isDeleteRowsKey(key('x'), 'darwin')).toBe(false);
  });
});
