import { createFormat, type Shape } from '../../core';
import type { ptBR } from './pt-BR';

const f = createFormat('en');

/** Area "registry", English. */
export const en: Shape<typeof ptBR> = {
  duplicate: 'Duplicate',
  duplicateTitle: 'Opens a new environment with these settings',
  duplicateOf: (p) => `Copy of ${p.source}. Review and save to create the new environment.`,
  duplicateSourceBlocked:
    'The source environment is blocked (changed outside Cais, or not reviewed yet). Check host, port, credential, the production flag and agent access before saving the copy.',
  renameProject: (p) => `Rename project ${p.name}`,
  renameProjectTitle: 'Rename project',
  dialogTitle: 'Registry',
  close: 'Close',
  sections: {
    environments: 'Environments',
    credentials: 'Credentials',
  },
  newEnvironment: 'New environment',
  newCredential: 'New credential',
  pickEnvironment: 'Pick an environment or create a new one.',
  pickCredential: 'Pick a credential or create a new one.',
  row: {
    blocked: 'blocked',
    freeWrites: 'free writes',
    freeReads: 'free reads',
    password: 'password',
    iam: 'IAM',
  },
  save: 'Save',
  saved: 'Saved',
  delete: 'Delete',
  confirmDelete: 'Confirm delete',
  cancel: 'Cancel',
  credential: {
    name: 'Name',
    namePlaceholder: 'e.g. root dev',
    kind: 'Type',
    kindLabel: 'Credential type',
    password: 'User and password',
    iam: 'Google IAM via gcloud',
    username: 'User',
    secret: 'Password',
    secretKeep: 'leave empty to keep it',
    secretHint: 'The password is encrypted in the system vault and never comes back to this screen.',
    account: 'gcloud account',
    accountPlaceholder: 'name@company.com',
    impersonate: 'Impersonate service account (optional)',
    impersonatePlaceholder: 'sa@project.iam.gserviceaccount.com',
    dbUser: 'Database user',
    dbUserHint: 'Filled in from the account. You can edit it.',
    usedBy: (p) => `Used in ${f.count(p.count, { one: 'environment', other: 'environments' })}`,
  },
  environment: {
    project: 'Project',
    newProject: 'New project…',
    newProjectLabel: 'Name of the new project',
    newProjectPlaceholder: 'Project name',
    name: 'Environment name',
    namePlaceholder: 'dev, hml, pro…',
    host: 'Host',
    port: 'Port',
    database: 'Default database (optional)',
    credential: 'Credential',
    noCredential: '(no credential)',
    newCredential: 'New credential…',
    production: 'Production',
    productionHint: 'Opens in read-only and asks for confirmation to use auto-commit.',
    agents: 'Agent access',
    testMissing: 'Fill in host, port and credential to test.',
    connected: (p) => `Connected · version ${p.version}`,
    invalidPort: 'Enter a valid port (1 to 65535).',
    notEditable: (p) =>
      `The environment ${p.name} uses the ${p.engine} engine, which has no edit form in this registry yet. It can be deleted from here.`,
    notDuplicable: (p) =>
      `The environment ${p.name} uses the ${p.engine} engine, which has no form in this registry yet: it cannot be duplicated.`,
    testing: 'Testing…',
    test: 'Test connection',
    blocked:
      'This environment is blocked (changed outside Cais, or not reviewed since the registry protection was created): nothing connects to it, neither you nor agents. Check host, port, credential, the production flag and agent access, and save to unblock it.',
  },
  levelHint: {
    locked:
      'The system vault is not available: without it Cais cannot protect the registry, and agents stay at "Everything needs approval".',
    productionFreeReads:
      'Agent reads run right away, production data included. Writes on production always need your approval and then your Commit.',
    productionApproveAll:
      'Every agent read and write needs your approval. Reads can be allowed for 15 minutes from the request itself. On production, writes always need approval.',
    'approve-all': 'Every agent read and write needs your approval in Cais.',
    'free-reads': 'Agent reads run right away. Writes need your approval and then your Commit.',
    'free-reads-writes': (p) =>
      `Agent reads and writes run right away. A write runs in a transaction and commits by itself when there is no warning and it affects up to ${f.formatNumber(p.count)} rows; otherwise it waits for you. Everything goes to the trail.`,
  },
};
