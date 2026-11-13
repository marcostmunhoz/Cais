import type { Shape } from '../../core';
import type { ptBR } from './pt-BR';

/** Area "tabs", English. */
export const en: Shape<typeof ptBR> = {
  strip: 'Query tabs',
  removedEnvironment: 'Removed environment',
  unsaved: 'Unsaved changes',
  transactionOpen: 'Transaction open',
  close: (p) => `Close tab ${p.label}`,
  newTab: 'New tab',
  newTabTitle: 'New tab (Cmd+T)',
};
