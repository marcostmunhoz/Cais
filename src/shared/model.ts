// Core domain model shared by main and renderer. Pure TypeScript.

import { m } from './i18n';

export type Engine = 'mysql' | 'bigquery';
export type SessionMode = 'read-only' | 'transaction' | 'autocommit';

export interface Project {
  id: string;
  name: string;
  order: number;
}

/** What every engine's environment has. `defaultDatabase` is the default dataset on BigQuery. */
interface EnvironmentBase {
  id: string;
  projectId: string;
  name: string; // "dev", "hml", "pro"...
  defaultDatabase?: string;
  credentialId: string;
  production: boolean;
  /** What agents may run here without asking. Production is never 'free-reads-writes'. */
  agentLevel?: AgentLevel;
}

export interface MysqlEnvironment extends EnvironmentBase {
  engine: 'mysql';
  host: string;
  port: number;
}

export interface BigqueryEnvironment extends EnvironmentBase {
  engine: 'bigquery';
  /** The Google Cloud project where jobs run and are billed. */
  gcpProject: string;
  /** Most bytes one query may bill (bytes). Absent: no limit. */
  maxBytesBilled?: number;
}

/** One environment, by engine. The MySQL shape is what catalog.json has always held. */
export type Environment = MysqlEnvironment | BigqueryEnvironment;

/**
 * What agents may run in an environment without the person's click:
 * - approve-all: every read and write asks (schema metadata excepted);
 * - free-reads: reads run, writes ask;
 * - free-reads-writes: reads run, and writes run and commit by themselves within the limits.
 */
export type AgentLevel = 'approve-all' | 'free-reads' | 'free-reads-writes';

export const AGENT_LEVELS: readonly AgentLevel[] = ['approve-all', 'free-reads', 'free-reads-writes'];

/** The levels an environment may have: production never lets agents write by themselves. */
export function agentLevelsFor(production: boolean): readonly AgentLevel[] {
  return production ? ['approve-all', 'free-reads'] : AGENT_LEVELS;
}

/**
 * The level that counts. Production: 'free-reads' only when the person chose it, else 'approve-all' (also for
 * a production environment saved before the choice existed, or one that says 'free-reads-writes'). Outside
 * production, without a choice, free reads.
 */
export function agentLevelOf(env: Pick<Environment, 'production' | 'agentLevel'>): AgentLevel {
  if (env.production) return env.agentLevel === 'free-reads' ? 'free-reads' : 'approve-all';
  return env.agentLevel ?? 'free-reads';
}

/**
 * The person-facing name of each level, in the current locale. Getters, so the text is read where it is shown
 * (or written to the trail), never frozen at module load.
 */
export const AGENT_LEVEL_LABEL: Readonly<Record<AgentLevel, string>> = {
  get 'approve-all'() {
    return m().model.agentLevel['approve-all'];
  },
  get 'free-reads'() {
    return m().model.agentLevel['free-reads'];
  },
  get 'free-reads-writes'() {
    return m().model.agentLevel['free-reads-writes'];
  },
};

export type Credential =
  | { id: string; name: string; kind: 'password'; username: string } // password lives in secrets.json
  | {
      id: string;
      name: string;
      kind: 'gcloud-iam';
      account: string; // e-mail logged in on gcloud
      impersonateServiceAccount?: string;
      dbUsername: string; // derived from the account, editable
    };

export interface Catalog {
  version: 1;
  projects: Project[];
  environments: Environment[];
  credentials: Credential[];
}

/** What the renderer receives: the catalog plus which password credentials have a stored secret. */
export interface CatalogSnapshot extends Catalog {
  credentialsWithSecret: string[];
  /** Environments changed outside the Cais: no connection until the person reviews and saves them. */
  blockedEnvironments: string[];
  /** No system vault: nothing can be signed, so every environment stays "Everything needs approval". */
  agentLevelsLocked?: boolean;
  /** Files that were unreadable at startup and set aside (messages in the app locale). */
  notices: string[];
}

/** Persisted state of one editor tab. Text and environment only; sessions never reconnect by themselves. */
export interface TabState {
  id: string;
  environmentId: string;
  sql: string;
  database?: string | null;
  /** Saved script this tab is linked to. Dropped on restore when the script no longer exists. */
  scriptId?: string;
}

export interface TabsFile {
  version: 1;
  tabs: TabState[];
  activeTabId: string | null;
  /** Set by the loader when the file was corrupt and set aside. Never saved. */
  notice?: string;
}

export type ProjectInput = { id?: string; name: string };
export type EnvironmentInput = (Omit<MysqlEnvironment, 'id'> | Omit<BigqueryEnvironment, 'id'>) & { id?: string };
export type CredentialInput =
  | { id?: string; name: string; kind: 'password'; username: string }
  | {
      id?: string;
      name: string;
      kind: 'gcloud-iam';
      account: string;
      impersonateServiceAccount?: string;
      dbUsername: string;
    };

/** Environment fields needed to test a connection before saving it. */
export type EnvironmentDraft =
  | { engine: 'mysql'; host: string; port: number; defaultDatabase?: string; credentialId: string }
  | { engine: 'bigquery'; gcpProject: string; defaultDatabase?: string; credentialId: string; maxBytesBilled?: number };

export const PRODUCTION_NAMES = ['pro', 'prod', 'production'];

export function looksLikeProduction(environmentName: string): boolean {
  return PRODUCTION_NAMES.includes(environmentName.trim().toLowerCase());
}

/**
 * Derives the database user for IAM logins.
 * User account: part before the "@". Service account: e-mail without ".gserviceaccount.com".
 */
export function deriveIamUsername(account: string): string {
  const email = account.trim();
  if (email.toLowerCase().endsWith('.gserviceaccount.com')) {
    return email.slice(0, -'.gserviceaccount.com'.length);
  }
  const at = email.indexOf('@');
  return at === -1 ? email : email.slice(0, at);
}

/** When impersonating, the database user follows the service account, otherwise the logged account. */
export function deriveIamUsernameFor(account: string, impersonateServiceAccount?: string): string {
  const sa = impersonateServiceAccount?.trim();
  return deriveIamUsername(sa ? sa : account);
}

export const DEFAULT_MAX_ROWS = 1000;
export const EXTENDED_MAX_ROWS = 50000;

export const MAX_SCRIPT_NAME = 120;

/** A script belongs to the project and shows up inside every environment of it. */
export interface SavedScript {
  id: string;
  projectId: string;
  name: string; // unique per project (case-insensitive), trimmed, up to 120 characters
  sql: string;
  database?: string; // database of the tab when it was saved
  createdAt: number;
  updatedAt: number;
  createdBy: 'user' | 'agent'; // 'agent' until a person saves or renames it
  lastRun?: { environmentId: string; at: number };
}

export interface ScriptsFile {
  version: 1;
  scripts: SavedScript[];
}

export interface ScriptSaveInput {
  id?: string;
  projectId: string;
  name: string;
  sql: string;
  database?: string;
}
