import { createFormat, type Shape } from '../../core';
import type { ptBR } from './pt-BR';

const f = createFormat('en');

/** Area "scripts", English. */
export const en: Shape<typeof ptBR> = {
  ago: {
    justNow: 'just now',
    minutes: (p) => `${f.formatNumber(p.n)} ${p.n === 1 ? 'minute' : 'minutes'} ago`,
    hours: (p) => `${f.formatNumber(p.n)} ${p.n === 1 ? 'hour' : 'hours'} ago`,
    days: (p) => `${f.formatNumber(p.n)} ${p.n === 1 ? 'day' : 'days'} ago`,
  },
  neverRan: 'not run yet',
  ranIn: (p) => `ran on ${p.environment} ${p.ago}`,
  removedEnvironment: 'removed environment',
};
