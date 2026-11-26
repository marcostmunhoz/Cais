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
    accessTokenFailed: (p) => `gcloud did not generate the access token for the account ${p.account}. ${p.detail}`,
  },
  bigquery: {
    noResponse: 'No response from bigquery.googleapis.com. Is the VPN on? Check the proxy as well.',
    unexpectedResponse: 'BigQuery answered in a format Cais does not recognize.',
    modeNotSupported: 'BigQuery only reads in this version: the session is always Read-only.',
    refusedType: (p) => `Read-only: BigQuery read this statement as ${p.type}, not as a query (SELECT).`,
    resultExpired: 'The result of this query is no longer available. Run the query again.',
    refusedUnknown: 'Read-only: BigQuery did not say what kind of statement this is.',
    datasetNotFound: (p) => `The dataset ${p.name} does not exist in this project, or the account cannot see it.`,
    datasetInvalid: 'Invalid dataset name: letters, digits and underscores only.',
    hintJobUser: 'The account needs the roles/bigquery.jobUser role on the project.',
    hintDataViewer: 'To read the tables, the account needs roles/bigquery.dataViewer on the datasets.',
    error: {
      accessDenied: 'BigQuery denied access. The account needs the roles/bigquery.jobUser role on the project and roles/bigquery.dataViewer on the datasets the query reads.',
      unauthenticated: 'BigQuery did not accept the account token. Run `gcloud auth login` in the terminal and try again.',
      notFound: 'BigQuery did not find the project, dataset or table. Check the name and whether the account can see it.',
      invalidQuery: (p) => `BigQuery refused the statement: ${p.detail}`,
      bytesBilledLimitExceeded:
        'The query would read more bytes than the environment limit allows. BigQuery did not run it and nothing was billed.',
      quotaExceeded: 'The BigQuery quota ran out. Wait a moment or check the project quotas in Google Cloud.',
      rateLimitExceeded: 'BigQuery limited the pace of queries. Wait a moment and try again.',
      responseTooLarge: 'The result is too large for BigQuery to return. Ask for fewer columns or rows.',
      backendError: 'BigQuery failed on its side. Try again in a moment.',
      stopped: 'BigQuery stopped the query.',
      timeout: 'The query went over the time limit and BigQuery stopped it.',
    },
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
  skillInstall: {
    sourceMissing: 'The skill file that ships with Cais was not found or is not the Cais skill. Reinstall Cais, or read it with "cais llm skill".',
    notDirectory: (p) => `${p.path} already exists and is not a folder (or is a link), so Cais did not touch it.`,
    notFile: (p) => `${p.path} already exists and is not a regular file (or is a link), so Cais did not touch it.`,
    notOurFile: (p) => `${p.path} already exists and is not the Cais skill (not our file), so Cais did not touch it.`,
    failed: (p) => `Could not install the skill at ${p.path}: ${p.reason}.`,
    noPermission: 'no permission',
    installed: (p) => `Skill installed at ${p.path}.`,
    updated: (p) => `Skill updated at ${p.path}.`,
    alreadyUpToDate: (p) => `The skill at ${p.path} is already up to date.`,
  },
};
