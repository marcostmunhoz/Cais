import type { Shape } from '../../core';
import type { ptBR } from './pt-BR';

/** Area "editor", English. */
export const en: Shape<typeof ptBR> = {
  ariaLabel: 'SQL editor',
  tableDetail: 'table',
  viewDetail: 'view',
  databaseDetail: 'database',
  codemirror: {
    controlCharacter: 'Control character',
    completions: 'Completions',
    selectionDeleted: 'Selection deleted',
  },
};
