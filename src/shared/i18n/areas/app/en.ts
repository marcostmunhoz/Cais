import type { Shape } from '../../core';
import type { ptBR } from './pt-BR';

/** Area "app", English. */
export const en: Shape<typeof ptBR> = {
  noEnvironments: {
    title: 'No environments yet',
    text: 'Add a credential and an environment to get started.',
    action: 'Add',
  },
  noTabs: {
    title: 'No open tabs',
    text: 'Pick an environment in the sidebar or open a new tab.',
    action: 'New tab',
  },
  noticeDismiss: 'Got it',
};
