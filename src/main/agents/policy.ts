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
}

/**
 * Refusals sent to the agent (CLI) only, never shown to the person: fixed pt-BR whatever the app locale.
 * The trail keeps only the code.
 */
export const MESSAGES = {
  empty: 'Não há nenhum comando para executar.',
  writes: 'Este SQL escreve. Peça com --write.',
  ddl: 'Agentes não rodam DDL nem controlam transação.',
  notAllowed: 'Este comando não é permitido para agentes.',
  reason: 'Este pedido precisa de aprovação. Informe o motivo com --reason.',
  reasonWrite: 'Escrita sempre leva motivo, que fica na trilha. Informe com --reason.',
  queue: `Há ${MAX_PENDING} pedidos aguardando aprovação. Espere a pessoa decidir.`,
  executableComment: 'Agentes não usam comentários executáveis (/*! … */ ou /*M! … */): o servidor pode rodar outra coisa do que a pessoa vê.',
  functionNotAllowed: (name: string): string =>
    `A função ${name} não é permitida para agentes (lock nomeado, espera, arquivo do servidor ou estado do servidor).`,
  hint: 'Agentes não usam hints que mudam variáveis de sessão (SET_VAR, MAX_EXECUTION_TIME).',
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
    const denied = s.c.serverStateFunction ?? s.c.functions?.find((f) => deniedFunctions.has(f));
    if (denied) return { action: 'refuse', code: 'function_not_allowed', message: MESSAGES.functionNotAllowed(denied.replace(/^#NON_ASCII:/, '')) };
    if (s.c.setVarHint) return { action: 'refuse', code: 'function_not_allowed', message: MESSAGES.hint };
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
  const free = mode === 'read' ? level !== 'approve-all' || input.grantActive : level === 'free-reads-writes';
  const needsApproval = !free || input.trailOk === false;
  if (!needsApproval) return { action: 'run' };
  if (!input.reason?.trim()) return { action: 'refuse', code: 'reason_required', message: MESSAGES.reason };
  if (input.pendingCount >= MAX_PENDING) return { action: 'refuse', code: 'queue_full', message: MESSAGES.queue };
  return { action: 'approve' };
}
