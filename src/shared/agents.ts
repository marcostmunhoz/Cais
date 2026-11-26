// Agent access: types shared by main and renderer, plus the numbers the policy is built on. Pure TypeScript.
import type { StatementKind } from './results';

export const AGENT_PROTOCOL = 1;

export const PENDING_TTL_MS = 10 * 60_000; // a request nobody answered expires
export const ROLLBACK_AFTER_MS = 120_000; // an open agent transaction rolls back by itself
export const READ_GRANT_MS = 15 * 60_000; // "approve reads in <env> for 15 min"
export const READ_SESSION_IDLE_MS = 5 * 60_000;
export const MAX_PENDING = 20;
export const READ_MAX_EXECUTION_MS = 30_000; // server-side max_execution_time for agent reads
export const READ_HARD_CUT_MS = 35_000; // client-side cut per statement (KILL QUERY): covers what max_execution_time does not
export const READ_REQUEST_MAX_MS = 60_000; // one agent read request, all statements together
export const WRITE_RUN_MAX_MS = 60_000; // an approved agent write, all statements together, before the second decision
export const WRITE_LOCK_WAIT_S = 10; // innodb_lock_wait_timeout for agent writes
export const MAX_READ_SESSIONS = 3; // per environment
export const SCHEMA_CACHE_MS = 60_000;
export const MAX_RECENT = 100;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_SQL_BYTES = 100 * 1024;
export const TRAIL_RETENTION_DAYS = 90; // the trail (person and agents) keeps 90 days, one file per day
/** An autonomous write (free-reads-writes) commits by itself only up to this many affected rows, all commands together. */
export const AUTO_COMMIT_MAX_ROWS = 1000;
/** And, per environment, up to this many rows in the last 15 minutes: a loop of small deletes still reaches the person. */
export const AUTO_COMMIT_WINDOW_ROWS = 5000;
export const AUTO_COMMIT_WINDOW_MS = 15 * 60_000;
/**
 * BigQuery: a read an agent asks for with more estimated bytes than this waits for the person, even in "Reads allowed,
 * writes need approval", under a 15-minute grant and in an environment with no limit. Fixed: not an option.
 */
export const AGENT_BYTES_APPROVAL = 10 * 1024 ** 3;
export const AGENT_DEFAULT_ROWS = 200;
export const AGENT_MAX_ROWS = 1000;

export type AgentMode = 'read' | 'write';

export type AgentRequestStatus =
  | 'pending_approval'
  | 'rejected'
  | 'expired'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'awaiting_commit'
  | 'committed'
  | 'rolled_back';

/** States a request never leaves. `awaiting_commit` is intermediate. */
export const FINAL_STATUSES: readonly AgentRequestStatus[] = ['rejected', 'expired', 'succeeded', 'failed', 'committed', 'rolled_back'];

export const isFinalStatus = (status: AgentRequestStatus): boolean => FINAL_STATUSES.includes(status);

/** Who let a request run, as the agent sees it: the person, or the environment's policy (including a 15-minute grant). */
export type AgentDecider = 'person' | 'policy';

export type RollbackReason = 'timeout' | 'user' | 'shutdown' | 'access_off' | 'unexpected_commit';

/** One command of a request, as the person sees it. Counts only: never result data. */
export interface AgentStatementView {
  sql: string; // the command text (as sent)
  verb: string;
  kind: StatementKind;
  rows?: number; // rows returned (reads) once it ran
  /** Engines that bill by bytes read: what the dry run estimated, asked before the person decides, and what the job billed. */
  bytesEstimated?: number;
  bytesBilled?: number;
  affectedRows?: number; // rows changed (writes) once it ran
  error?: string;
}

/** What the renderer gets about a request. Never carries result rows. */
export interface AgentRequestView {
  id: string;
  createdAt: number;
  client: string;
  environmentId: string;
  environmentLabel: string; // "shop · pro"
  database?: string;
  production: boolean;
  mode: AgentMode;
  reason?: string;
  sql: string;
  statements: AgentStatementView[];
  warnings: string[];
  status: AgentRequestStatus;
  /** pending_approval: when it expires. */
  expiresAt?: number;
  /** awaiting_commit: when the automatic rollback happens. */
  rollbackAt?: number;
  decidedBy?: 'policy' | 'grant' | 'user' | 'timeout' | 'shutdown' | 'environment';
  decidedAt?: number;
  /** Write in a free-reads-writes environment: the Cais commits by itself when nothing calls for the person. */
  autoCommit?: boolean;
  /** Why a request that the environment's level would let run is waiting for the person (app locale; the agent gets English). */
  approvalReason?: string;
  /** Why an autonomous write did not commit by itself and waits for the second decision (app locale; the agent gets English). */
  commitReason?: string;
  /** Who made the second decision of a write (Commit/Rollback); 'policy' is the automatic commit. */
  secondDecidedBy?: 'user' | 'timeout' | 'shutdown' | 'policy';
  shareResult?: boolean;
  rejectionReason?: string;
  rollbackReason?: RollbackReason;
  /** The server said the Rollback could not undo changes to non-transactional tables. */
  rollbackIncomplete?: boolean;
  errorMessage?: string;
  finishedAt?: number;
}

export interface AgentGrantView {
  environmentId: string;
  environmentLabel: string;
  expiresAt: number;
}

export interface AgentsSnapshot {
  enabled: boolean;
  /** Message (app locale) when the access is on but the socket could not be opened. */
  startError?: string;
  pending: AgentRequestView[];
  awaitingCommit: AgentRequestView[];
  grants: AgentGrantView[];
  recent: AgentRequestView[];
}

export interface ApproveOptions {
  /** "The agent can see the result". */
  shareResult: boolean;
  /** "Approve reads on <environment> for 15 min": only valid for a read that needed approval. */
  grantReads?: boolean;
}
