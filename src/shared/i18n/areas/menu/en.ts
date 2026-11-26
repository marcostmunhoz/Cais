import type { Shape } from '../../core';
import type { ptBR } from './pt-BR';

/** Area "menu", English (macOS menus use title case). */
export const en: Shape<typeof ptBR> = {
  app: 'Cais',
  about: 'About Cais',
  installCli: 'Install cais Command in Terminal',
  hide: 'Hide Cais',
  hideOthers: 'Hide Others',
  unhide: 'Show All',
  quit: 'Quit Cais',
  file: 'File',
  edit: 'Edit',
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  pasteAndMatchStyle: 'Paste and Match Style',
  delete: 'Delete',
  selectAll: 'Select All',
  view: 'View',
  toggleFullScreen: 'Toggle Full Screen',
  reload: 'Reload',
  toggleDevTools: 'Toggle Developer Tools',
  help: 'Help',
  window: 'Window',
  minimize: 'Minimize',
  zoom: 'Zoom',
};
