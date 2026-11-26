import type { AgentRules, Classification } from '@shared/dialects/types';
import { MAX_PENDING, type AgentMode } from '@shared/agents';
import type { AgentLevel } from '@shared/model';

export interface ClassifiedStatement {
  text: string;
  c: Classification;
  /** Lower-case identifiers the statement mentions (dialect.identifiers). */
  ids?: string[];
}

export type RefusalCode =
  | 'empty_sql'
  | 'ddl_or_transaction'
  | 'writes_in_read'
  | 'command_not_allowed'
  | 'reason_required'
  | 'queue_full'
  | 'executable_comment'
  | 'function_not_allowed'
  | 'system_schema';

export type Decision =
  | { action: 'run' }
  | { action: 'approve' }
  | { action: 'refuse'; code: RefusalCode; message: string };

export interface DecideInput {
  mode: AgentMode;
  production: boolean;
  /**
   * The environment's level (agentLevelOf). Absent: the default, free reads, outside production; in production,
   * 'approve-all'. Production never goes past 'free-reads'.
   */
  level?: AgentLevel;
  /** The trail is being written. When it is not, nothing runs without the person. */
  trailOk?: boolean;
  statements: ClassifiedStatement[];
  /** --reason, as typed (may be empty). */
  reason?: string;
  pendingCount: number;
  /** A 15-minute read grant for this environment is active right now (reads only). */
  grantActive: boolean;
  /** --database, as given. */
  database?: string;
  /** The engine's rules (dialect.agentRules): its system schemas, denied functions and write verbs. */
  rules: AgentRules;
  /**
   * Something outside the level calls for the person (a read past the bytes threshold, a call that runs outside the
   * engine): the request goes to approval whatever the level or a 15-minute grant says. Needs a --reason like any
   * request that waits.
   */
  forceApproval?: boolean;
}

/**
 * Refusals sent to the agent (CLI) only, never shown to the person: fixed English whatever the app locale.
 * The trail keeps only the code.
 */
export const MESSAGES = {
  empty: 'There is no statement to run.',
  writes: 'This SQL writes. Ask with --write.',
  ddl: 'Agents do not run DDL or control transactions.',
  notAllowed: 'This statement is not allowed for agents.',
  reason: 'This request needs approval. Give the reason with --reason.',
  reasonWrite: 'A write always needs a reason, which goes in the Trail. Give it with --reason.',
  queue: `There are ${MAX_PENDING} requests waiting for approval. Wait for the user to decide.`,
  executableComment: 'Agents do not use executable comments (/*! … */ or /*M! … */): the server may run something other than what the user sees.',
  functionNotAllowed: (name: string): string =>
    `The function ${name} is not allowed for agents (named lock, wait, server file or server state).`,
  legacyDirective:
    'Agents do not use the #legacySQL and #standardSQL directives: they change the language the server reads the statement in, and the user reviews something else.',
  externalQuery: 'The EXTERNAL_QUERY function is not allowed for agents: it runs a query on another database.',
  serverNotQuery: (kind?: string): string =>
    kind && /^[A-Z_]{1,40}$/.test(kind)
      ? `The server read this statement as ${kind}, not as a query (SELECT): agents only read in this environment.`
      : 'The server did not say this statement is a query (SELECT): nothing runs without that.',
  hint: 'Agents do not use hints that change session variables (SET_VAR, MAX_EXECUTION_TIME).',
} as const;

/** DDL, anything with an implicit commit, and transaction control: never for agents, in any mode. */
function isForbidden(c: Classification): boolean {
  return (
    !!c.alwaysRefuse ||
    c.implicitCommit ||
    c.kind === 'ddl' ||
    c.kind === 'transaction-control' ||
    c.transactionControl !== null
  );
}

/**
 * Pure policy: what happens to a query request. A write that may run by itself ('run' in a free-reads-writes
 * environment) still goes to the person when the broker finds an alert before running, and commits by
 * itself only within the limits after running. Every command is classified by the dialect in main;
 * nothing the client says about the SQL is trusted.
 */
export function decide(input: DecideInput): Decision {
  const { mode, statements, rules } = input;
  const deniedFunctions = new Set(rules.deniedFunctions);
  const writeVerbs = new Set(rules.writeVerbs);
  if (statements.length === 0) return { action: 'refuse', code: 'empty_sql', message: MESSAGES.empty };

  // what the person reviews must be what the server runs
  if (statements.some((s) => s.c.executableComment)) {
    return { action: 'refuse', code: 'executable_comment', message: MESSAGES.executableComment };
  }
  for (const s of statements) {
    const denied = s.c.serverStateFunction ?? s.c.functions?.find((f) => deniedFunctions.has(f) || deniedFunctions.has(f.replace(/^SAFE\./, '')));
    if (denied) return { action: 'refuse', code: 'function_not_allowed', message: MESSAGES.functionNotAllowed(denied.replace(/^#NON_ASCII:/, '')) };
    if (s.c.setVarHint) return { action: 'refuse', code: 'function_not_allowed', message: MESSAGES.hint };
  }
  // `#legacySQL` is a comment the server obeys: what the person reviews is not what it runs
  if (statements.some((s) => s.c.legacyDirective)) return { action: 'refuse', code: 'executable_comment', message: MESSAGES.legacyDirective };
  if (statements.some((s) => s.c.externalQuery)) return { action: 'refuse', code: 'function_not_allowed', message: MESSAGES.externalQuery };
  if (statements.some((s) => s.c.jobsMetadata)) {
    return { action: 'refuse', code: 'system_schema', message: rules.messages.jobsMetadata ?? rules.messages.systemSchemaRead };
  }
  const database = input.database?.toLowerCase();
  const touches = (names: Set<string> | string[]): boolean => {
    const set = names instanceof Set ? names : new Set(names);
    return (database !== undefined && set.has(database)) || statements.some((s) => (s.ids ?? []).some((id) => set.has(id)));
  };
  if (mode === 'write' && touches(rules.systemSchemas)) return { action: 'refuse', code: 'system_schema', message: rules.messages.systemSchemaWrite };
  if (touches(rules.secretSchemas) || statements.some((s) => s.c.accountSecrets)) {
    return { action: 'refuse', code: 'system_schema', message: rules.messages.systemSchemaRead };
  }

  if (statements.some((s) => isForbidden(s.c))) {
    return { action: 'refuse', code: 'ddl_or_transaction', message: MESSAGES.ddl };
  }
  if (mode === 'read') {
    if (statements.some((s) => !s.c.allowedInReadOnly)) {
      return { action: 'refuse', code: 'writes_in_read', message: MESSAGES.writes };
    }
  } else if (statements.some((s) => !s.c.allowedInReadOnly && !(s.c.kind === 'write' && writeVerbs.has(s.c.verb)))) {
    return { action: 'refuse', code: 'command_not_allowed', message: MESSAGES.notAllowed };
  }

  // production never writes without the person, whatever the catalog says: at most free reads, and only when
  // the person chose it
  const level: AgentLevel = input.production
    ? input.level === 'free-reads'
      ? 'free-reads'
      : 'approve-all'
    : (input.level ?? 'free-reads');
  if (mode === 'write' && !input.reason?.trim()) return { action: 'refuse', code: 'reason_required', message: MESSAGES.reasonWrite };
  const free = !input.forceApproval && (mode === 'read' ? level !== 'approve-all' || input.grantActive : level === 'free-reads-writes');
  const needsApproval = !free || input.trailOk === false;
  if (!needsApproval) return { action: 'run' };
  if (!input.reason?.trim()) return { action: 'refuse', code: 'reason_required', message: MESSAGES.reason };
  if (input.pendingCount >= MAX_PENDING) return { action: 'refuse', code: 'queue_full', message: MESSAGES.queue };
  return { action: 'approve' };
}
