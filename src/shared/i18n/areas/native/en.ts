import { createFormat, type Shape } from '../../core';
import type { ptBR } from './pt-BR';

const f = createFormat('en');

/** Area "native", English. */
export const en: Shape<typeof ptBR> = {
  ok: 'OK',
  debugRefused: 'Cais: debugging options are not accepted.',
  startupFailed: 'Could not start Cais',
  installDone: 'Command installed',
  installFailed: 'Could not install the command',
  notification: {
    title: 'Cais',
    pendingMany: (p) => `Agent requests: ${f.formatNumber(p.count)} waiting for you`,
    awaitingCommit: (p) => `Agent write waiting for your Commit on ${p.environment}`,
    commitUncertain: (p) => `Agent auto-commit with an uncertain result on ${p.environment}: check the database`,
    pendingOne: (p) => `Agent request: ${p.mode === 'write' ? 'write' : 'read'} on ${p.environment}`,
  },
};
