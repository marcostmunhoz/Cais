import type { Shape } from '../../core';
import type { ptBR } from './pt-BR';

/** Area "mainScripts", English. */
export const en: Shape<typeof ptBR> = {
  nameRequired: 'Enter the script name.',
  nameTooLong: (p) => `The name can have up to ${p.max} characters.`,
  nameTaken: (p) => `A script with this name already exists in ${p.project}.`,
  nameTakenHere: 'A script with this name already exists in this project.',
  projectNotFound: 'Project not found.',
  notFound: 'Script not found.',
  agentsCannotEdit: 'Agents do not edit scripts.',
  otherProject: 'The script belongs to another project.',
  environmentNotInProject: 'Environment not found in this project.',
  inconsistent: (p) => {
    const parts = [
      p.duplicates ? `${p.duplicates} with a repeated name in the same project` : '',
      p.orphans ? `${p.orphans} from a project that no longer exists` : '',
    ].filter(Boolean);
    return `The file scripts.json has inconsistent scripts (${parts.join('; ')}). They were kept.`;
  },
};
