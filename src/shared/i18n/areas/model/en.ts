import type { Shape } from '../../core';
import type { ptBR } from './pt-BR';

/** Area "model", English. */
export const en: Shape<typeof ptBR> = {
  agentLevel: {
    'approve-all': 'Everything needs approval',
    'free-reads': 'Reads allowed, writes need approval',
    'free-reads-writes': 'Reads and writes allowed',
  },
};
