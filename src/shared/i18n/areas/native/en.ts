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
  skillDialog: {
    message: 'Install the Cais skill for agents',
    detail:
      'The skill is a text file (SKILL.md) that teaches an agent how to use the cais llm command. Cais copies it to a "cais" folder inside the folder where the agent keeps its skills, and changes nothing else. Claude Code reads its skills from ~/.claude/skills. For another agent, choose its skills folder.',
    claudeCode: 'Claude Code',
    chooseFolder: 'Choose Folder…',
    cancel: 'Cancel',
    chooseTitle: 'Choose the folder where the agent keeps its skills',
    done: 'Skill installed',
    upToDate: 'Skill already up to date',
    failed: 'Could not install the skill',
  },
  notification: {
    title: 'Cais',
    pendingMany: (p) => `Agent requests: ${f.formatNumber(p.count)} waiting for you`,
    awaitingCommit: (p) => `Agent write waiting for your Commit on ${p.environment}`,
    commitUncertain: (p) => `Agent auto-commit with an uncertain result on ${p.environment}: check the database`,
    pendingOne: (p) => `Agent request: ${p.mode === 'write' ? 'write' : 'read'} on ${p.environment}`,
  },
};
