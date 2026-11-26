import type { Shape } from '../../core';
import type { ptBR } from './pt-BR';

/** Area "editor", English. */
export const en: Shape<typeof ptBR> = {
  ariaLabel: 'SQL editor',
  tableDetail: 'table',
  viewDetail: 'view',
  databaseDetail: { database: 'database', dataset: 'dataset' },
  syntaxError: (p) => `Possible syntax error: ${p.message}`,
  codemirror: {
    controlCharacter: 'Control character',
    completions: 'Completions',
    selectionDeleted: 'Selection deleted',
  },
};
