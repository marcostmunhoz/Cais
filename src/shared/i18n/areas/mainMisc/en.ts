import type { Shape } from '../../core';
import type { ptBR } from './pt-BR';

/** Area "mainMisc", English. */
export const en: Shape<typeof ptBR> = {
  credentialNotFound: 'Credential not found.',
  sealRecreated:
    'The protection key was recreated (seal.json removed or unreadable): the trail before this point can no longer be verified.',
  credentialNoPassword: (p) => `The credential "${p.name}" has no saved password.`,
  driver: {
    noResponse: (p) => `No response from ${p.host}:${p.port}. Is the VPN on?`,
    iamRefused:
      'IAM login refused. Check that the IAM user exists on the instance and that the account has permission to log in to Cloud SQL.',
    passwordRefused: 'User or password refused.',
    readOnly: 'The session is read-only.',
    cancelled: 'Query cancelled.',
    lost: 'Connection lost.',
    unknown: 'Unknown error',
    autocommitTurnedOn:
      'The statement turned on the session’s autocommit (for example inside a procedure): what it wrote is already committed. Cais put the session back in Transaction.',
    cancelFailed: (p) => `Could not cancel the query: ${p.message}`,
  },
  gcloud: {
    timeout: 'gcloud took too long to respond.',
    notFound: 'gcloud not found. Install the Google Cloud SDK or open Cais from the terminal.',
    listFailed: (p) => `Could not list the gcloud accounts. ${p.detail}`,
    listUnexpected: 'Unexpected response from gcloud when listing the accounts.',
    reauth: (p) => `The account ${p.account} needs to sign in again: run \`gcloud auth login ${p.account}\` in the terminal.`,
    tokenFailed: (p) => `gcloud did not generate the login token for the account ${p.account}. ${p.detail}`,
    noToken: (p) => `gcloud did not return a token for the account ${p.account}.`,
  },
  store: {
    unreadable: (p) => `The file ${p.name} was unreadable and was set aside at ${p.aside}. Cais opened without that data.`,
    agentAccessTampered:
      'Agent access was on without Cais having turned it on (settings.json changed or protection recreated) and was turned off. Turn it on again in the Agents panel if you want.',
  },
  cliInstall: {
    targetMissing: 'The command file was not found in this app. Run the build and try again.',
    notOurLink: (p) => `${p.path} already exists and is not a Cais link.`,
    otherProgram: (p) => `${p.path} already points to another program.`,
    dirFailed: (p) => `${p.dir}: ${p.reason}`,
    noPermission: 'no permission',
    failed: (p) => `Could not install the cais command. ${p.failures}`,
    alreadyInstalled: (p) => `The cais command was already installed at ${p.path}.`,
    installed: (p) => `cais command installed at ${p.path}.`,
    notOnPath: (p) => `The folder ${p.dir} is not on the terminal PATH: add it to use the command.`,
  },
};
