import type { Credential, Engine, Environment } from '@shared/model';
import { m, ref } from '@shared/i18n';
import { CaisError } from '../errors';
import type { BigqueryConnectParams, ConnectParams, MysqlConnectParams } from '../drivers/types';

export interface ResolvedCredential {
  user: string;
  password?: string;
  authPlugin?: 'mysql_clear_password';
  tls: 'off' | 'required';
}

/** What BigQuery needs from a credential: an access token, and a way to ask for another. */
export interface ResolvedAccess {
  accessToken: string;
  refresh(): Promise<string>;
}

export interface CredentialSources {
  getPassword(credentialId: string): string | undefined;
  /** Cloud SQL IAM login token. */
  getToken(account: string, impersonateServiceAccount?: string): Promise<string>;
  /** OAuth access token for Google APIs; `force` skips the cache. Only BigQuery asks. */
  getAccessToken?(account: string, impersonateServiceAccount?: string, opts?: { force?: boolean }): Promise<string>;
}

/** Turns a stored credential into what the driver needs. Tokens are fetched here, never stored. */
export async function resolveCredential(credential: Credential, sources: CredentialSources, engine: 'mysql'): Promise<ResolvedCredential>;
export async function resolveCredential(credential: Credential, sources: CredentialSources, engine: 'bigquery'): Promise<ResolvedAccess>;
export async function resolveCredential(
  credential: Credential,
  sources: CredentialSources,
  engine: Engine,
): Promise<ResolvedCredential | ResolvedAccess> {
  if (engine === 'bigquery') {
    // a user and password mean nothing to BigQuery
    if (credential.kind !== 'gcloud-iam' || !sources.getAccessToken) {
      throw new CaisError(m().mainCatalog.bigqueryNeedsIam, 'invalid-credential');
    }
    const { account, impersonateServiceAccount } = credential;
    const getAccessToken = sources.getAccessToken.bind(sources);
    return {
      accessToken: await getAccessToken(account, impersonateServiceAccount),
      refresh: () => getAccessToken(account, impersonateServiceAccount, { force: true }),
    };
  }
  if (credential.kind === 'password') {
    const password = sources.getPassword(credential.id);
    if (password === undefined) {
      throw CaisError.of(ref('mainMisc.credentialNoPassword', { name: credential.name }));
    }
    return { user: credential.username, password, tls: 'off' };
  }
  const token = await sources.getToken(credential.account, credential.impersonateServiceAccount);
  return { user: credential.dbUsername, password: token, authPlugin: 'mysql_clear_password', tls: 'required' };
}

export function toConnectParams(
  target: { host: string; port: number; database?: string },
  resolved: ResolvedCredential,
): MysqlConnectParams {
  return {
    host: target.host,
    port: target.port,
    ...(target.database ? { database: target.database } : {}),
    user: resolved.user,
    ...(resolved.password !== undefined ? { password: resolved.password } : {}),
    ...(resolved.authPlugin ? { authPlugin: resolved.authPlugin } : {}),
    tls: resolved.tls,
  };
}

/** The environment's own fields that matter to a connection, as the person's form or the catalog gives them. */
export type ConnectTarget =
  | { engine: 'mysql'; host: string; port: number; credentialId: string }
  | { engine: 'bigquery'; gcpProject: string; maxBytesBilled?: number; credentialId: string };

/**
 * The connection parameters of an environment (or of a draft), by engine. `database` overrides the default
 * database or dataset. `origin` labels BigQuery jobs: the person's tabs or an agent.
 */
export async function connectParamsFor(
  target: ConnectTarget | Environment,
  database: string | undefined,
  deps: { getCredential(id: string): Credential | undefined; sources: CredentialSources; origin: 'person' | 'agent' },
): Promise<ConnectParams> {
  const credential = deps.getCredential(target.credentialId);
  if (!credential) throw new CaisError(m().mainMisc.credentialNotFound);
  if (target.engine === 'bigquery') {
    const access = await resolveCredential(credential, deps.sources, 'bigquery');
    const params: BigqueryConnectParams = {
      engine: 'bigquery',
      project: target.gcpProject,
      accessToken: access.accessToken,
      refresh: access.refresh,
      ...(target.maxBytesBilled !== undefined ? { maxBytesBilled: target.maxBytesBilled } : {}),
      ...(database ? { defaultDataset: database } : {}),
      origin: deps.origin,
    };
    return params;
  }
  const resolved = await resolveCredential(credential, deps.sources, 'mysql');
  return toConnectParams({ host: target.host, port: target.port, database }, resolved);
}
