import type { Shape } from '../../core';
import type { ptBR } from './pt-BR';

/** Area "text", English. */
export const en: Shape<typeof ptBR> = {
  hidden: {
    invisible: (p) => `The SQL has an invisible or text-direction character (${p.marker}). Rewrite it without that character.`,
    oddBreak: (p) => `The SQL has a line break other than \\n (${p.marker}). Use \\n only.`,
    control: (p) => `The SQL has a control character (${p.marker}). Rewrite it without that character.`,
  },
  blankLines: (p) => `⋯ ${p.count} blank lines`,
};
