import { createFormat } from '../../core';

const f = createFormat('pt-BR');

/** Area "scripts", pt-BR (the reference catalog: `en.ts` must follow its shape). */
export const ptBR = {
  /** How long ago something happened (`formatAgo`). */
  ago: {
    justNow: 'agora há pouco',
    minutes: (p: { n: number }) => `há ${f.formatNumber(p.n)} ${p.n === 1 ? 'minuto' : 'minutos'}`,
    hours: (p: { n: number }) => `há ${f.formatNumber(p.n)} ${p.n === 1 ? 'hora' : 'horas'}`,
    days: (p: { n: number }) => `há ${f.formatNumber(p.n)} ${p.n === 1 ? 'dia' : 'dias'}`,
  },
  /** Tooltip of a saved script (`lastRunText`). */
  neverRan: 'ainda não rodou',
  ranIn: (p: { environment: string; ago: string }) => `rodou em ${p.environment} ${p.ago}`,
  removedEnvironment: 'ambiente removido',
};
