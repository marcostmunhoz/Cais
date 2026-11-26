/** Keyboard shortcut labels per platform: symbols on macOS, spelled-out keys elsewhere. */
export type ShortcutId = 'run' | 'cancel' | 'save' | 'saveAs' | 'newTab' | 'open' | 'closeTab' | 'runAll' | 'deleteRows';

const MAC: Record<ShortcutId, string> = {
  run: '⌘↵',
  cancel: '⌘.',
  save: '⌘S',
  saveAs: '⇧⌘S',
  newTab: '⌘T',
  open: '⌘O',
  closeTab: '⌘W',
  runAll: '⇧⌘↵',
  deleteRows: '⌫',
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
  deleteRows: 'Delete',
};

export function shortcutText(id: ShortcutId, platform: string): string {
  return (platform === 'darwin' ? MAC : OTHER)[id];
}

/**
 * Whether a key press is the "mark the selected rows for deletion" shortcut of the grid (text: `deleteRows`): Delete on
 * every system, and also Backspace on macOS, where that key is the one labelled delete. Never with a modifier.
 */
export function isDeleteRowsKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, platform: string): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return e.key === 'Delete' || (platform === 'darwin' && e.key === 'Backspace');
}
