import type { Shape } from '../../core';
import type { ptBR } from './pt-BR';

/** Area "mainIpc", English. */
export const en: Shape<typeof ptBR> = {
  invalidData: 'The data sent is invalid.',
  unexpected: 'Unexpected error.',
  unauthorizedOrigin: 'Unauthorized origin.',
  blockedCredentialTest:
    'This credential is used by a blocked environment (changed outside Cais or not reviewed yet). Review and save the environment before testing.',
  trail: {
    environmentCopied: (p) => `Environment created (copy of ${p.source}); agent access: ${p.level}.`,
    projectRenamed: (p) => `Project renamed: ${p.from} → ${p.to}.`,
    environmentCreated: (p) => `Environment created; agent access: ${p.level}.`,
    environmentCreatedProduction: (p) => `Environment created (production); agent access: ${p.level}.`,
    environmentChanged: (p) => `Environment changed: ${p.changes}.`,
    changeProduction: (p) => `production: ${p.from} → ${p.to}`,
    changeAgentLevel: (p) => `agent access: ${p.from} → ${p.to}`,
    changeName: (p) => `name: ${p.from} → ${p.to}`,
    changeProject: (p) => `project: ${p.from} → ${p.to}`,
    yes: 'yes',
    no: 'no',
    environmentReleased: 'Environment reviewed and released by the person (it was blocked).',
    environmentDeleted: 'Environment deleted.',
    agentAccessOn: 'Agent access turned on.',
    agentAccessOff: 'Agent access turned off.',
  },
};
