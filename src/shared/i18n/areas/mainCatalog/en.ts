import { createFormat, type Shape } from '../../core';
import type { ptBR } from './pt-BR';

const f = createFormat('en');

/** Area "mainCatalog", English. */
export const en: Shape<typeof ptBR> = {
  projectNameRequired: 'Enter the project name.',
  projectExists: (p) => `A project named "${p.name}" already exists.`,
  projectNotFound: 'Project not found.',
  environmentNameRequired: 'Enter the environment name.',
  environmentExists: (p) => `The project already has an environment named "${p.name}".`,
  slashInName: 'The name cannot contain "/": the project/environment address agents use would be ambiguous.',
  duplicateBlocked: (p) =>
    p.count === 1
      ? `The environment ${p.names} is blocked. Review and save it in the registry before duplicating the project.`
      : `The environments ${p.names} are blocked. Review and save each one in the registry before duplicating the project.`,
  environmentUntrusted:
    'This environment was changed outside Cais. Review host, port and credential in the registry and save it before connecting.',
  projectHasEnvironments: (p) => `The project still has environments: ${p.names}. Delete the environments first.`,
  projectHasScripts: (p) => `The project has ${f.count(p.count, { one: 'script', other: 'scripts' })}.`,
  hostRequired: 'Enter the host.',
  credentialRequired: 'Choose a credential.',
  credentialNameRequired: 'Enter the credential name.',
  credentialExists: (p) => `A credential named "${p.name}" already exists.`,
  usernameRequired: 'Enter the user.',
  passwordRequired: 'Enter the password.',
  vaultUnavailable:
    'The system password vault is not available. The password was not saved (Cais never stores a password in plain text).',
  gcloudAccountRequired: 'Enter the gcloud account.',
  dbUsernameRequired: 'Enter the database user.',
  credentialInUse: (p) => `The credential is in use by: ${p.names}.`,
  integrity: {
    sealCreated: (p) =>
      'The registry protection was just created (seal.json did not exist, was removed or cannot be opened). ' +
      `Since there is no way to know whether anything changed, ${p.count === 1 ? 'the environment stays blocked and marked' : 'the environments stay blocked and marked'} as production (${p.names}) ` +
      `until you open the registry, review host, port, credential, the production mark and agent access, and save ${p.count === 1 ? 'the environment' : 'each one'}. Agent access went back to "${p.approveAll}".`,
    waiting: (p) =>
      `${p.names} ${p.count === 1 ? 'still needs' : 'still need'} review in the registry: ${p.count === 1 ? 'it stays' : 'they stay'} blocked until you save.`,
    tampered: (p) =>
      `The registry was changed outside Cais (${p.names}). For safety, ` +
      `${p.count === 1 ? 'the environment was blocked, marked' : 'the environments were blocked, marked'} as production and set to agent access "${p.approveAll}". ` +
      'Nothing connects to them until you review host, port and credential in the registry and save.',
  },
};
