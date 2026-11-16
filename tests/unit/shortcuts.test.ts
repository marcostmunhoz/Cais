import { describe, expect, it } from 'vitest';
import { shortcutText, type ShortcutId } from '@shared/shortcuts';

const IDS: ShortcutId[] = ['run', 'cancel', 'save', 'saveAs', 'newTab', 'open', 'closeTab', 'runAll'];

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
