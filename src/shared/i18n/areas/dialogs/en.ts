import { createFormat, type Shape } from '../../core';
import type { ptBR } from './pt-BR';

const f = createFormat('en');

/** Area "dialogs", English. */
export const en: Shape<typeof ptBR> = {
  projectName: {
    renameTitle: 'Rename project',
    duplicateTitle: 'Duplicate project',
    label: 'Project name',
    rename: 'Rename',
    duplicate: 'Duplicate',
    cancel: 'Cancel',
    duplicateHint: (p) => `Copies every environment of ${p.source}, with the same credential. Scripts are not copied.`,
    renameHint: 'Agent grants for this project are revoked and pending requests expire, because the project/environment address changes.',
  },
  cancel: 'Cancel',
  commit: 'Commit',
  rollback: 'Rollback',
  closeTransaction: {
    title: 'Open transaction',
    heading: 'This tab has an open transaction',
    body: (p) =>
      `${f.count(p.count, { one: 'statement is', other: 'statements are' })} not committed yet. Choose what to do before closing the tab. Rollback undoes everything.`,
  },
  quit: {
    title: 'Open transactions',
    heading: 'There are open transactions',
    body: (p) =>
      `${f.count(p.count, { one: 'tab has an open transaction', other: 'tabs have an open transaction' })}. Choose what to do before quitting. Rollback undoes everything.`,
  },
  tabPicker: {
    title: 'New tab',
    placeholder: 'Project · environment (e.g. shop pro)',
    searchLabel: 'Search environment',
    listLabel: 'Environments',
    production: 'Production',
    empty: 'No environment found',
  },
  closeDirty: {
    title: 'Unsaved changes',
    heading: 'Save the changes to the script?',
    body: (p) => `Script ${p.name} has changes that are not saved yet.`,
    discard: 'Discard',
    save: 'Save',
  },
  scriptName: {
    renameTitle: 'Rename script',
    saveTitle: 'Save script',
    rename: 'Rename',
    save: 'Save',
    label: 'Script name',
  },
  scriptPicker: {
    title: 'Open script',
    placeholder: 'Project · script name',
    searchLabel: 'Search script',
    listLabel: 'Scripts',
    agent: 'agent',
    noScripts: 'No saved script',
    empty: 'No script found',
  },
};
