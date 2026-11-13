/** Keyboard shortcut labels per platform: symbols on macOS, spelled-out keys elsewhere. */
export type ShortcutId = 'run' | 'cancel' | 'save' | 'saveAs' | 'newTab' | 'open' | 'closeTab' | 'runAll';

const MAC: Record<ShortcutId, string> = {
  run: '⌘↵',
  cancel: '⌘.',
  save: '⌘S',
  saveAs: '⇧⌘S',
  newTab: '⌘T',
  open: '⌘O',
  closeTab: '⌘W',
  runAll: '⇧⌘↵',
};

const OTHER: Record<ShortcutId, string> = {
  run: 'Ctrl+Enter',
  cancel: 'Ctrl+.',
  save: 'Ctrl+S',
  saveAs: 'Ctrl+Shift+S',
  newTab: 'Ctrl+T',
  open: 'Ctrl+O',
  closeTab: 'Ctrl+W',
  runAll: 'Ctrl+Shift+Enter',
};

export function shortcutText(id: ShortcutId, platform: string): string {
  return (platform === 'darwin' ? MAC : OTHER)[id];
}
