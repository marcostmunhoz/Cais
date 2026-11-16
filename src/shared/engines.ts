// What each engine can do, for both sides: the renderer needs it too and cannot see the driver. Pure TypeScript.

import type { BigqueryEnvironment, Engine, MysqlEnvironment, SessionMode } from './model';

export interface EngineCapabilities {
  /** The session modes the engine accepts, in the order the mode picker lists them. */
  modes: readonly SessionMode[];
  /** The result grid may edit rows (UPDATE by primary key). */
  gridEdit: boolean;
  /** The schema tree lists names first and reads the columns of one database (dataset) when it is opened. */
  lazyColumns?: boolean;
  /** The engine answers a dry run (type and estimated bytes of a statement) before it runs. */
  dryRun?: boolean;
}

const CAPABILITIES: Record<Engine, EngineCapabilities> = {
  mysql: { modes: ['read-only', 'transaction', 'autocommit'], gridEdit: true, lazyColumns: false, dryRun: false },
  // BigQuery only reads in this version: no transactions, no auto-commit, no editing in the grid
  bigquery: { modes: ['read-only'], gridEdit: false, lazyColumns: true, dryRun: true },
};

export function capabilitiesOf(engine: Engine): EngineCapabilities {
  return CAPABILITIES[engine];
}

/**
 * The mode a new tab opens in: read-only in production, Auto-commit elsewhere when the engine takes it,
 * otherwise the first mode the engine accepts.
 */
export function initialModeFor(caps: EngineCapabilities, production: boolean): SessionMode {
  const { modes } = caps;
  if (production && modes.includes('read-only')) return 'read-only';
  if (!production && modes.includes('autocommit')) return 'autocommit';
  return modes[0] ?? 'read-only';
}

/** What an environment needs to tell where it connects to (MySQL without `engine` is what older callers pass). */
export type ConnectionTarget =
  | (Pick<MysqlEnvironment, 'host' | 'port' | 'credentialId'> & { engine?: 'mysql' })
  | Pick<BigqueryEnvironment, 'engine' | 'gcpProject' | 'maxBytesBilled' | 'credentialId'>;

/**
 * What identifies where an environment connects to. Two environments with the same key reach the same server
 * with the same credential. A new engine adds its own fields here, and every comparison follows.
 * BigQuery: the project jobs run in (and are billed to) and the byte limit, which bounds what a query may cost.
 */
export function connectionTargetKey(env: ConnectionTarget): string {
  if (env.engine === 'bigquery') return JSON.stringify(['bigquery', env.gcpProject, env.maxBytesBilled ?? null, env.credentialId]);
  return JSON.stringify([env.host, env.port, env.credentialId]);
}

export function sameTarget(a: ConnectionTarget, b: ConnectionTarget): boolean {
  return connectionTargetKey(a) === connectionTargetKey(b);
}

/**
 * A Google Cloud project id: 6 to 30 characters, lower-case letters, digits and hyphens, starting with a letter and
 * not ending in a hyphen; a domain-scoped project is written `example.com:my-project`.
 */
const GCP_PROJECT_ID = /^(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export function isGcpProjectId(value: string): boolean {
  return value.length <= 100 && GCP_PROJECT_ID.test(value);
}

/** A BigQuery dataset id: letters, digits and underscore, up to 1024 characters. */
export function isBigqueryDatasetId(value: string): boolean {
  return /^[A-Za-z0-9_]{1,1024}$/.test(value);
}

export const GIB = 1024 ** 3;
/** The smallest byte limit an environment takes (BigQuery bills at least 10 MB per query; below 1 GiB the limit only gets in the way). */
export const MIN_MAX_BYTES_BILLED = GIB;
