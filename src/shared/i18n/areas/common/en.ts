import type { Shape } from '../../core';
import type { ptBR } from './pt-BR';

/** Area "common", English. */
export const en: Shape<typeof ptBR> = {
  copySuffix: '(copy)',
  copySuffixN: (p) => `(copy ${p.n})`,
};
