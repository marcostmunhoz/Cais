import type { Credential } from '@shared/model';
import { ref } from '@shared/i18n';
import { CaisError } from '../errors';
import type { ConnectParams } from '../drivers/types';

export interface ResolvedCredential {
  user: string;
  password?: string;
  authPlugin?: 'mysql_clear_password';
  tls: 'off' | 'required';
}

export interface CredentialSources {
  getPassword(credentialId: string): string | undefined;
  getToken(account: string, impersonateServiceAccount?: string): Promise<string>;
}

/** Turns a stored credential into what the driver needs. IAM tokens are fetched here, never stored. */
export async function resolveCredential(
  credential: Credential,
  sources: CredentialSources,
): Promise<ResolvedCredential> {
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
): ConnectParams {
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
