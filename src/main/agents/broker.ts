import type { Dialect } from '@shared/dialects/types';
import { agentLevelOf, type Engine, type Environment, type Project, type SavedScript } from '@shared/model';
import type { CellValue, SchemaTree, StatementResult } from '@shared/results';
import {
  AGENT_BYTES_APPROVAL,
  AGENT_DEFAULT_ROWS,
  AGENT_MAX_ROWS,
  AUTO_COMMIT_MAX_ROWS,
  AUTO_COMMIT_WINDOW_MS,
  AUTO_COMMIT_WINDOW_ROWS,
  MAX_PENDING,
  MAX_RECENT,
  MAX_SQL_BYTES,
  PENDING_TTL_MS,
  READ_GRANT_MS,
  ROLLBACK_AFTER_MS,
  isFinalStatus,
  type AgentDecider,
  type AgentMode,
  type AgentRequestStatus,
  type AgentRequestView,
  type AgentStatementView,
  type AgentsSnapshot,
  type ApproveOptions,
  type RollbackReason,
} from '@shared/agents';
import { AGENT_LOCALE, m, ref, render, renderRef, type MessageRef } from '@shared/i18n';
import { GIB, capabilitiesOf, sameTarget } from '@shared/engines';
import { hiddenTextProblem, stripInvisible } from '@shared/text';
import { CaisError } from '../errors';
import { AgentError, agentText, bothWays, refOf } from './errors';
import type { TrailStatement } from '@shared/trail';
import type { AuditEntry, AuditSink } from './audit';
import { decide, MESSAGES, type ClassifiedStatement, type Decision } from './policy';
import type { AgentExecutor, PlannedStatement, PreparedStatement, Scheduler, WriteRun } from './sessions';

export interface BrokerDeps {
  now(): number;
  scheduler: Scheduler;
  newId(): string;
  catalog: { projects(): Project[]; environments(): Environment[] };
  scripts: {
    list(): SavedScript[];
    get(id: string): SavedScript | undefined;
    save(input: { projectId: string; name: string; sql: string; database?: string }, by: 'agent'): Promise<SavedScript>;
  };
  executor: AgentExecutor;
  /** The trail. `healthy()` false: nothing runs without the person. */
  audit: AuditSink & { healthy?(): boolean };
  getDialect(engine: Engine): Dialect;
  /** The snapshot the interface shows changed. */
  onChange(): void;
  onNewPending(view: AgentRequestView): void;
  onScriptsChanged(): void;
}

export interface QueryParams {
  env: string;
  sql: string;
  write?: boolean;
  reason?: string;
  database?: string;
  maxRows?: number;
  wait?: boolean;
  timeoutS?: number;
  client?: string;
  /** The client went away: stop waiting (the request itself stays valid). */
  signal?: AbortSignal;
}

interface Rec {
  id: string;
  createdAt: number;
  client: string;
  environment: Environment;
  slug: string;
  label: string;
  production: boolean;
  mode: AgentMode;
  reason?: string;
  database?: string;
  maxRows: number;
  sql: string;
  plan: PlannedStatement[];
  views: AgentStatementView[];
  warnings: string[];
  status: AgentRequestStatus;
  expiresAt?: number;
  rollbackAt?: number;
  decidedBy?: AgentRequestView['decidedBy'];
  decidedAt?: number;
  shareResult: boolean;
  /** Typed by the person: never translated. */
  rejectionReason?: string;
  /** Written by the Cais (the environment changed): the person reads it in the app locale, the agent in pt-BR. */
  rejectionRef?: MessageRef;
  rollbackReason?: RollbackReason;
  rollbackIncomplete?: boolean;
  /** `message` in the app locale (the person's view); `ref`, when present, is what the agent reads. */
  error?: { message: string; code?: string; statementIndex?: number; ref?: MessageRef; serverText?: boolean };
  results?: StatementResult[];
  finishedAt?: number;
  timer?: unknown;
  write?: WriteRun;
  /** A commit, rollback or automatic rollback is already in flight. */
  resolving: boolean;
  /** The second decision (Commit/Rollback) and who made it ('policy': the automatic commit). */
  secondDecision?: { by: 'user' | 'timeout' | 'shutdown' | 'policy'; at: number };
  /** A read that ran without its own approval, under a 15-minute grant. */
  underGrant?: boolean;
  /** A write of a free-reads-writes environment that the policy let run: it commits by itself within the limits. */
  autoCommit?: boolean;
  /** Dry-run estimate per command (engines that bill by bytes read), as seen when the request came in. */
  estimates?: (number | undefined)[];
  /** Why the request waits for the person whatever the level says (big read, a call that runs outside the engine). */
  forcedReason?: MessageRef;
  /** Rendered per audience: the app locale in `view()`, AGENT_LOCALE in `response()`. */
  approvalReason?: MessageRef;
  commitReason?: MessageRef;
}

// Text for the agent: AgentError built from a plain string is fixed pt-BR (only agents read it); text
// the person may also read is a MessageRef (app locale for the person, AGENT_LOCALE for the agent).

const DEFAULT_WAIT_S = 600;
const environmentChanged = (): MessageRef => ref('agentsUi.rejection.environmentChanged');
const accessOff = (): AgentError => new AgentError(ref('agentsUi.error.accessOff'), 'agent_access_off');
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
/** Free text from the client: bidi and invisible controls out, control characters to spaces. */
const clean = (text: string, max: number): string => stripInvisible(text).trim().slice(0, max);
/** Slugs compare NFC-normalized, with ASCII-only case folding (no Unicode lookalikes through case rules). */
const fold = (text: string): string => text.normalize('NFC').replace(/[A-Z]/g, (c) => c.toLowerCase());
/** Names (database, table) that go into a trail label or a modal are cut here; the dialect refuses a longer --database before. */
const MAX_LABEL_NAME = 64;

/** SQL from an agent that cannot be shown honestly to the person: refused before classification (agent-facing, pt-BR). */
function agentSqlProblem(sql: string, dialect: Dialect): { code: string; message: string } | null {
  const hidden = hiddenTextProblem(sql, AGENT_LOCALE);
  if (hidden) return { code: 'hidden_text', message: hidden };
  // belt and braces over the classifier: no executable comment anywhere in the text, strings included
  if (/\/\*[!]|\/\*M!/.test(sql)) return { code: 'executable_comment', message: MESSAGES.executableComment };
  // the dialect writes this one in AGENT_LOCALE by default
  const code = dialect.agentCodeProblem?.(sql);
  if (code) return { code: 'ambiguous_text', message: code };
  return null;
}

/** --database from an agent: a plain name the engine accepts (the dialect's rule), no system schema for writes (checked by the policy). */
const MAX_SCOPED_SCHEMAS = 5;
const badDatabase = (database: string, dialect: Dialect): boolean => !dialect.agentRules.isValidDatabaseName(database);

const firstLine = (sql: string, max: number): string => {
  const line = sql.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/**
 * Lifecycle of the agents' requests: policy, approval queue, expiry, grants, the second decision, the trail.
 * Nothing reaches "running" except through `policy.decide` saying "run", or `approve()` called by the person.
 */
export class AgentBroker {
  private enabled = false;
  private readonly records = new Map<string, Rec>();
  private readonly grants = new Map<string, { expiresAt: number; timer: unknown; shareResult: boolean }>();
  private readonly waiters = new Map<string, Set<() => void>>();
  /** Requests past the queue check that are not in `records` yet (they await the schema): they count as pending. */
  private reserving = 0;
  /** Rows committed by automatic commits, per environment, for the 15-minute budget. */
  private readonly autoCommitted = new Map<string, { at: number; rows: number }[]>();

  constructor(private readonly deps: BrokerDeps) {}

  // --- on / off ----------------------------------------------------------------------------

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Access turned off: nothing stays waiting and nothing stays open. */
  async disable(): Promise<void> {
    this.enabled = false;
    await this.closeOut('access_off');
  }

  /** The app is quitting: pending requests expire, open transactions roll back. */
  async shutdown(): Promise<void> {
    this.enabled = false;
    await this.closeOut('shutdown');
  }

  private async closeOut(reason: 'access_off' | 'shutdown'): Promise<void> {
    const by = 'shutdown' as const;
    for (const rec of [...this.records.values()]) {
      if (rec.status === 'pending_approval') this.finish(rec, 'expired', { decidedBy: by });
    }
    for (const [id, grant] of this.grants) {
      this.deps.scheduler.clear(grant.timer);
      this.grants.delete(id);
      this.auditGrant(id, reason, 'shutdown');
    }
    await Promise.all(
      [...this.records.values()].filter((r) => r.status === 'awaiting_commit').map((rec) => this.rollbackNow(rec, reason, by)),
    );
    await this.deps.executor.closeAll().catch(() => undefined);
    this.deps.onChange();
  }

  private assertEnabled(): void {
    if (!this.enabled) throw accessOff();
  }

  // --- catalog views for agents (no secrets, no hosts) -------------------------------------

  private slugOf(env: Environment): string {
    const project = this.deps.catalog.projects().find((p) => p.id === env.projectId);
    return `${project?.name ?? '?'}/${env.name}`;
  }

  private labelOf(env: Environment): string {
    const project = this.deps.catalog.projects().find((p) => p.id === env.projectId);
    return `${project?.name ?? '?'} · ${env.name}`;
  }

  private resolveEnv(ref: string): Environment {
    const envs = this.deps.catalog.environments();
    const byId = envs.find((e) => e.id === ref);
    if (byId) return byId;
    const lower = fold(ref.trim());
    const matches = envs.filter((e) => fold(this.slugOf(e)) === lower);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new AgentError('Mais de um ambiente com esse nome. Use o id.', 'env_ambiguous');
    throw new AgentError('Ambiente não encontrado. Veja a lista com "cais llm envs".', 'env_not_found');
  }

  envs(): { environments: Record<string, unknown>[] } {
    this.assertEnabled();
    return {
      environments: this.deps.catalog.environments().map((e) => ({
        id: e.id,
        slug: this.slugOf(e),
        project: this.deps.catalog.projects().find((p) => p.id === e.projectId)?.name ?? '',
        name: e.name,
        production: e.production,
        engine: e.engine,
        // what runs without the person here: approve-all, free-reads or free-reads-writes
        agent_access: agentLevelOf(e),
        ...(e.defaultDatabase ? { default_database: e.defaultDatabase } : {}),
      })),
    };
  }

  async schema(p: { env: string; database?: string; table?: string; client?: string }): Promise<Record<string, unknown>> {
    this.assertEnabled();
    const env = this.resolveEnv(p.env);
    const client = clean(p.client ?? 'agente', 60) || 'agente';
    // a name the engine could not have: nothing is read for it
    if (p.database !== undefined && badDatabase(p.database, this.deps.getDialect(env.engine))) {
      throw new AgentError('Nome de banco inválido.', 'invalid_database');
    }
    // what the agent typed goes to the trail cleaned (no bidi, no line breaks) and short
    const db = p.database ? clean(p.database, MAX_LABEL_NAME) : undefined;
    const label = `schema${db ? ` ${db}` : ''}${p.table ? ` ${clean(p.table, MAX_LABEL_NAME)}` : ''}`;
    const id = this.deps.newId();
    const audit = (state: string, errorCode?: string): boolean =>
      this.deps.audit.append({
        id, client, environment: this.slugOf(env), environmentId: env.id, production: env.production, mode: 'schema',
        sql: label, state, ...(db ? { database: db } : {}), ...(errorCode ? { errorCode } : {}),
      }) !== false;
    // metadata only, but still nothing of an agent runs off the trail
    if (!this.trailOk() || !audit('running')) {
      throw new AgentError('A trilha do Cais não pôde ser gravada: nada de agente roda enquanto isso.', 'trail_unavailable');
    }
    let tree: SchemaTree;
    // columns an engine reads on demand (BigQuery): the tree without a scope has none, so --table asks per dataset
    const scoped = new Map<string, SchemaTree['databases'][number]>();
    let beyondCap = false;
    try {
      tree = await this.deps.executor.schema(env, db ? { database: db } : undefined);
      if (p.table && !p.database && capabilitiesOf(env.engine).lazyColumns) {
        const wanted = p.table.toLowerCase();
        const needs = tree.databases.filter((d) => d.tables.some((t) => t.name.toLowerCase() === wanted && t.columns.length === 0));
        beyondCap = needs.length > MAX_SCOPED_SCHEMAS;
        for (const d of needs.slice(0, MAX_SCOPED_SCHEMAS)) {
          const one = (await this.deps.executor.schema(env, { database: d.name })).databases.find((x) => x.name === d.name);
          if (one) scoped.set(d.name, one);
        }
      }
    } catch (error) {
      audit('failed', error instanceof AgentError ? error.code : 'internal_error');
      throw error;
    }
    audit('succeeded');
    const dbs = tree.databases.filter((d) => !p.database || d.name.toLowerCase() === p.database.toLowerCase());
    if (p.database && dbs.length === 0) throw new AgentError('Banco não encontrado neste ambiente.', 'not_found');
    const shape = (t: SchemaTree['databases'][number]['tables'][number], columns: boolean) => ({
      name: t.name,
      type: t.type,
      ...(columns ? { columns: t.columns.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable, ...(c.key ? { key: c.key } : {}) })) } : {}),
    });
    if (p.table) {
      const wanted = p.table.toLowerCase();
      const found = dbs
        .map((d) => ({
          name: d.name,
          tables: (scoped.get(d.name) ?? d).tables
            .filter((t) => t.name.toLowerCase() === wanted && (!scoped.has(d.name) || t.columns.length > 0))
            .map((t) => shape(t, true)),
        }))
        .filter((d) => d.tables.length > 0);
      if (found.length === 0) throw new AgentError('Tabela não encontrada.', 'not_found');
      return {
        environment: this.slugOf(env),
        databases: found,
        ...(beyondCap ? { note: `A tabela existe em mais de ${MAX_SCOPED_SCHEMAS} bancos: só vêm os primeiros. Use --database para um banco específico.` } : {}),
      };
    }
    const withColumns = !!p.database;
    return {
      environment: this.slugOf(env),
      databases: dbs.map((d) => ({ name: d.name, tables: d.tables.map((t) => shape(t, withColumns)) })),
      ...(withColumns ? {} : { note: 'Sem --database só vêm os nomes das tabelas. Use --database ou --table para ver as colunas.' }),
    };
  }

  // --- query ---------------------------------------------------------------------------------

  async query(p: QueryParams): Promise<Record<string, unknown>> {
    this.assertEnabled();
    let env = this.resolveEnv(p.env);
    const client = clean(p.client ?? 'agente', 60) || 'agente';
    const sql = p.sql;
    if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) throw new AgentError('O SQL passa de 100 KB.', 'sql_too_large');
    const mode: AgentMode = p.write ? 'write' : 'read';
    const reason = p.reason?.trim() ? clean(p.reason, 500) : undefined;
    const database = p.database?.trim() ? p.database.trim() : undefined;
    const dialect = this.deps.getDialect(env.engine);
    const refuse = (code: string, message: string): never => {
      this.deps.audit.append({
        id: this.deps.newId(), client, environment: this.slugOf(env), environmentId: env.id, production: env.production, mode,
        ...(reason ? { reason } : {}), ...(database ? { database: clean(database, MAX_LABEL_NAME) } : {}),
        sql: sql.slice(0, 500), sqlLength: sql.length, state: 'refused', errorCode: code,
      });
      throw new AgentError(message, code);
    };
    // an engine that cannot write (BigQuery in this version) takes no write from an agent, whatever the text says
    if (p.write && !capabilitiesOf(env.engine).modes.includes('transaction')) {
      refuse('engine_read_only', 'O BigQuery só lê nesta versão: escrita de agente (--write) não é aceita neste ambiente.');
    }
    const textProblem = agentSqlProblem(sql, dialect);
    if (textProblem) refuse(textProblem.code, textProblem.message);
    if (database !== undefined && badDatabase(database, dialect)) refuse('invalid_database', 'Nome de banco inválido.');

    const statements: ClassifiedStatement[] = dialect
      .splitStatements(sql)
      .map((s) => ({ text: s.text, c: dialect.classify(s.text), ids: dialect.identifiers(s.text) }));
    // a read that calls what runs outside the engine waits for the person, at any level and under any grant
    let forced: MessageRef | undefined = mode === 'read' ? (functionApprovalRef(statements, dialect) ?? undefined) : undefined;
    const plan: PlannedStatement[] = statements.map((s) => ({
      text: s.text,
      verb: s.c.verb,
      kind: s.c.kind,
      ...(s.c.changesDatabase ? { changesDatabase: true } : {}),
    }));
    const decideFor = (target: Environment): Decision =>
      decide({
        mode,
        ...(forced ? { forceApproval: true } : {}),
        production: target.production,
        level: agentLevelOf(target),
        trailOk: this.trailOk(),
        statements,
        rules: dialect.agentRules,
        ...(reason ? { reason } : {}),
        ...(database ? { database } : {}),
        pendingCount: this.countPending() + this.reserving,
        grantActive: mode === 'read' && this.grantActive(target.id),
      });
    let decision = decideFor(env);
    if (decision.action === 'refuse') refuse(decision.code, decision.message);

    // engines with a dry run (BigQuery): ask the server what each command is and what it would read, before deciding
    let estimates: (number | undefined)[] | undefined;
    if (mode === 'read' && this.deps.executor.prepare && capabilitiesOf(env.engine).dryRun) {
      const prepared = await this.deps.executor.prepare(env, { ...(database ? { database } : {}), statements: plan });
      if (!this.enabled) throw accessOff();
      if (prepared) {
        // the person may have changed the environment while the dry run was out: decide on what holds now
        const fresh = this.deps.catalog.environments().find((e) => e.id === env.id);
        if (!fresh || !sameTarget(fresh, env) || fresh.defaultDatabase !== env.defaultDatabase) throw new AgentError(environmentChanged(), 'invalid_state');
        env = fresh;
        const wrong = prepared.findIndex((p) => !p.failed && p.serverKind !== 'SELECT');
        if (wrong !== -1) refuse('writes_in_read', MESSAGES.serverNotQuery(prepared[wrong]!.serverKind));
        estimates = prepared.map((p) => p.bytesEstimated);
        const bytesRef = bytesApprovalRef(env, prepared);
        // the ceiling of each job: the approval threshold (10 GiB or the environment's limit when lower); a request
        // the person approves because of its bytes lifts it to the approved estimate rounded up to the GiB. A dry run
        // that failed knows nothing, so its job keeps the threshold and the driver refuses what grew past it.
        const threshold = bytesThreshold(env);
        plan.forEach((p, i) => {
          const est = prepared[i]?.failed ? undefined : estimates![i];
          p.maxBytesBilled = bytesRef && est !== undefined ? Math.max(threshold, Math.ceil(est / GIB) * GIB) : threshold;
        });
        // the function warning stays when both apply: the bytes of each command show in the modal anyway
        forced = forced ?? bytesRef ?? undefined;
        decision = decideFor(env);
        if (decision.action === 'refuse') refuse(decision.code, decision.message);
      }
    }

    let nonTransactional: string[] = [];
    let tree: SchemaTree | null = null;
    if (mode === 'write') {
      // the queue check above and the record below are not atomic: hold the place while the schema loads
      this.reserving++;
      try {
        // read now: a table created or changed to MyISAM a minute ago must not pass for transactional
        tree = await this.deps.executor.schema(env, { fresh: true }).catch(() => null);
        nonTransactional = this.nonTransactionalWarnings(tree, statements, dialect);
      } finally {
        this.reserving--;
      }
      if (!this.enabled) throw accessOff();
      // the person may have changed the environment while the schema loaded: decide on what holds now
      const fresh = this.deps.catalog.environments().find((e) => e.id === env.id);
      if (!fresh) throw new AgentError(environmentChanged(), 'invalid_state');
      if (fresh.production !== env.production || agentLevelOf(fresh) !== agentLevelOf(env)) {
        decision = decideFor(fresh);
        if (decision.action === 'refuse') refuse(decision.code, decision.message);
      }
      env = fresh;
    }
    const warnings = [...new Set(statements.flatMap((s) => dialect.warnings(s.text))), ...nonTransactional];
    let approvalReason: MessageRef | undefined = forced;
    if (decision.action === 'run' && mode === 'write') {
      // a write the level lets run goes to the person when anything could take it past what the Cais can
      // count or undo: an alert, a trigger, a cascading foreign key, a view, a stored function
      const stop =
        warnings.length > 0
          ? ref('agentsUi.approval.alert')
          : this.openWriteIn(env.id)
            ? ref('agentsUi.approval.openWrite')
            : autonomyBlockerRef(tree, statements);
      if (stop) {
        if (this.countPending() + this.reserving >= MAX_PENDING) refuse('queue_full', MESSAGES.queue);
        decision = { action: 'approve' };
        approvalReason = stop;
      }
    }
    const grant = this.grants.get(env.id);
    const now = this.deps.now();
    const rec: Rec = {
      id: this.deps.newId(),
      createdAt: now,
      client,
      environment: env,
      slug: this.slugOf(env),
      label: this.labelOf(env),
      production: env.production,
      mode,
      ...(reason ? { reason } : {}),
      ...(database ? { database } : {}),
      maxRows: clamp(Math.floor(p.maxRows ?? AGENT_DEFAULT_ROWS), 1, AGENT_MAX_ROWS),
      sql,
      plan,
      views: statements.map((s) => ({ sql: s.text, verb: s.c.verb, kind: s.c.kind })),
      warnings,
      status: 'pending_approval',
      // a read that runs under a grant keeps the sharing choice made in the modal that created the grant
      shareResult: decision.action === 'run' && mode === 'read' && grant && grant.expiresAt > now ? grant.shareResult : true,
      ...(decision.action === 'run' && mode === 'read' && agentLevelOf(env) === 'approve-all' ? { underGrant: true } : {}),
      ...(decision.action === 'run' && mode === 'write' ? { autoCommit: true } : {}),
      ...(approvalReason ? { approvalReason } : {}),
      ...(forced ? { forcedReason: forced } : {}),
      ...(estimates ? { estimates } : {}),
      resolving: false,
    };
    this.records.set(rec.id, rec);
    this.trim();
    let timedOut = false;

    if (decision.action === 'run' && !this.recordStart(rec)) {
      // nothing runs without the person unless the trail has it first
      rec.autoCommit = undefined;
      rec.underGrant = undefined;
      rec.shareResult = true;
      rec.approvalReason = ref('agentsUi.approval.trailDown');
      if (this.countPending() >= MAX_PENDING) {
        this.records.delete(rec.id);
        refuse('queue_full', MESSAGES.queue);
      }
      if (!rec.reason) {
        this.records.delete(rec.id);
        refuse('reason_required', MESSAGES.reason);
      }
      decision = { action: 'approve' };
    }
    if (decision.action === 'run') {
      rec.decidedBy = rec.underGrant ? 'grant' : 'policy';
      rec.decidedAt = now;
      rec.status = 'running';
      this.changed(rec);
      await this.execute(rec);
    } else {
      rec.expiresAt = now + PENDING_TTL_MS;
      rec.timer = this.deps.scheduler.set(() => {
        if (rec.status === 'pending_approval') this.finish(rec, 'expired', { decidedBy: 'timeout' });
      }, PENDING_TTL_MS);
      this.changed(rec);
      this.deps.onNewPending(this.view(rec, true));
      if (p.wait) timedOut = !(await this.waitFor(rec, isFinalStatus, clamp(p.timeoutS ?? DEFAULT_WAIT_S, 1, 3600) * 1000, p.signal));
    }
    return this.response(rec, timedOut);
  }

  async status(p: { id: string; wait?: boolean; timeoutS?: number; signal?: AbortSignal }): Promise<Record<string, unknown>> {
    this.assertEnabled();
    const rec = this.records.get(p.id);
    if (!rec) throw new AgentError('Pedido não encontrado. Ele pode ter saído da memória do Cais.', 'not_found');
    let timedOut = false;
    if (p.wait && !isFinalStatus(rec.status)) {
      const ok = await this.waitFor(rec, isFinalStatus, clamp(p.timeoutS ?? DEFAULT_WAIT_S, 1, 3600) * 1000, p.signal);
      timedOut = !ok;
    }
    return this.response(rec, timedOut || undefined);
  }

  requests(limit: number): Record<string, unknown> {
    this.assertEnabled();
    const list = [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, clamp(limit, 1, MAX_RECENT));
    return {
      requests: list.map((r) => ({
        request_id: r.id,
        status: r.status,
        environment: r.slug,
        production: r.production,
        mode: r.mode,
        created_at: new Date(r.createdAt).toISOString(),
        sql: firstLine(r.sql, 120),
        ...decisionFields(r),
      })),
    };
  }

  // --- scripts (agents can list, read and create) ------------------------------------------

  private projectByRef(ref: string): Project {
    const projects = this.deps.catalog.projects();
    const found = projects.find((p) => p.id === ref) ?? projects.find((p) => p.name.toLowerCase() === ref.trim().toLowerCase());
    if (!found) throw new AgentError('Projeto não encontrado.', 'project_not_found');
    return found;
  }

  private scriptView(s: SavedScript, withSql: boolean): Record<string, unknown> {
    const project = this.deps.catalog.projects().find((p) => p.id === s.projectId);
    return {
      id: s.id,
      project: project?.name ?? '',
      name: s.name,
      ...(s.database ? { database: s.database } : {}),
      created_by: s.createdBy,
      updated_at: new Date(s.updatedAt).toISOString(),
      ...(withSql ? { sql: s.sql } : {}),
    };
  }

  scripts(project?: string): Record<string, unknown> {
    this.assertEnabled();
    const projectId = project ? this.projectByRef(project).id : undefined;
    return {
      scripts: this.deps.scripts
        .list()
        .filter((s) => !projectId || s.projectId === projectId)
        .map((s) => this.scriptView(s, false)),
    };
  }

  script(id: string): Record<string, unknown> {
    this.assertEnabled();
    const found = this.deps.scripts.get(id);
    if (!found) throw new AgentError('Script não encontrado.', 'not_found');
    return this.scriptView(found, true);
  }

  async scriptSave(p: { project: string; name: string; sql: string; database?: string; client?: string }): Promise<Record<string, unknown>> {
    this.assertEnabled();
    if (Buffer.byteLength(p.sql, 'utf8') > MAX_SQL_BYTES) throw new AgentError('O SQL passa de 100 KB.', 'sql_too_large');
    const project = this.projectByRef(p.project);
    const audit = (state: string, errorCode?: string): void => {
      this.deps.audit.append({
        id: this.deps.newId(), client: clean(p.client ?? 'agente', 60) || 'agente', environment: project.name, production: false,
        mode: 'script', sql: state === 'created' ? p.sql : p.sql.slice(0, 500), ...(state !== 'created' && p.sql.length > 500 ? { sqlLength: p.sql.length } : {}),
        state, ...(errorCode ? { errorCode } : {}),
      });
    };
    const refuseScript = (message: string, code: string): never => {
      audit('refused', code);
      throw new AgentError(message, 'invalid_script');
    };
    // a script is SQL the person may run later in their own tab: no more than an agent could ask to run itself
    // a project may mix engines: the text must be fine for every dialect it has, and run in at least one of them
    const engines = [...new Set(this.deps.catalog.environments().filter((e) => e.projectId === project.id).map((e) => e.engine))];
    if (engines.length === 0) engines.push('mysql');
    const scriptDatabase = p.database?.trim() || undefined;
    let verdictProblem: { code: string; message: string } | null = null;
    let accepted = false;
    for (const engine of engines) {
      const dialect = this.deps.getDialect(engine);
      const textProblem = agentSqlProblem(p.sql, dialect);
      if (textProblem) refuseScript(textProblem.message, textProblem.code);
      if (scriptDatabase !== undefined && badDatabase(scriptDatabase, dialect)) {
        verdictProblem ??= { code: 'invalid_database', message: 'Nome de banco inválido.' };
        continue;
      }
      const statements = dialect.splitStatements(p.sql).map((s) => ({ text: s.text, c: dialect.classify(s.text), ids: dialect.identifiers(s.text) }));
      const verdict = decide({
        mode: 'write', production: false, statements, rules: dialect.agentRules, reason: 'script', pendingCount: 0, grantActive: false,
        ...(scriptDatabase ? { database: scriptDatabase } : {}),
      });
      if (verdict.action === 'refuse' && verdict.code !== 'empty_sql') verdictProblem ??= { code: verdict.code, message: verdict.message };
      else accepted = true;
    }
    if (!accepted && verdictProblem) refuseScript(verdictProblem.message, verdictProblem.code);
    if (/\n[ \t]*\n[ \t]*\n[ \t]*\n/.test(p.sql.replace(/\r\n/g, '\n'))) {
      refuseScript('O script tem linhas em branco demais em sequência. Use no máximo duas.', 'blank_lines');
    }
    try {
      const saved = await this.deps.scripts.save(
        { projectId: project.id, name: p.name, sql: p.sql, ...(p.database?.trim() ? { database: p.database.trim() } : {}) },
        'agent',
      );
      audit('created');
      this.deps.onScriptsChanged();
      return this.scriptView(saved, false);
    } catch (error) {
      if (error instanceof CaisError) {
        audit('refused', error.code ?? 'invalid');
        // the store wrote it in the app locale: the agent gets its pt-BR ref when it has one
        throw new AgentError(error.message, error.code === 'duplicate-name' ? 'duplicate_name' : 'invalid_script', undefined, refOf(error));
      }
      throw error;
    }
  }

  // --- the person's side (called only from the main window) --------------------------------

  snapshot(): AgentsSnapshot {
    const all = [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt);
    const now = this.deps.now();
    return {
      enabled: this.enabled,
      pending: all.filter((r) => r.status === 'pending_approval').map((r) => this.view(r, true)),
      awaitingCommit: all.filter((r) => r.status === 'awaiting_commit').map((r) => this.view(r, true)),
      grants: [...this.grants.entries()]
        .filter(([, g]) => g.expiresAt > now)
        .map(([environmentId, g]) => {
          const env = this.deps.catalog.environments().find((e) => e.id === environmentId);
          return { environmentId, environmentLabel: env ? this.labelOf(env) : environmentId, expiresAt: g.expiresAt };
        }),
      recent: all
        .filter((r) => r.status !== 'pending_approval' && r.status !== 'awaiting_commit')
        .reverse()
        .map((r) => this.view(r, false)),
    };
  }

  approve(id: string, options: ApproveOptions): AgentRequestView {
    const rec = this.requireInState(id, 'pending_approval');
    if (options.grantReads && rec.mode !== 'read') {
      throw new AgentError(ref('agentsUi.error.grantReadsOnly'), 'grant_not_applicable');
    }
    if (options.grantReads && !options.shareResult) {
      // with the result withheld, 15 minutes of unreviewed reads would rebuild it from row counts
      throw new AgentError(ref('agentsUi.error.grantNeedsShare'), 'grant_not_applicable');
    }
    if (!this.enabled) throw accessOff();
    const current = this.deps.catalog.environments().find((e) => e.id === rec.environment.id);
    const before = rec.environment;
    if (
      !current || !sameTarget(current, before) ||
      current.defaultDatabase !== before.defaultDatabase || current.production !== before.production ||
      // renamed or moved, even only in case: the modal showed the old project/environment name. The
      // store changes the catalog before the IPC path calls environmentChanged, so check here too.
      this.slugOf(current) !== rec.slug
    ) {
      this.finish(rec, 'expired', { decidedBy: 'environment', rejectionRef: environmentChanged() });
      throw new AgentError(environmentChanged(), 'invalid_state');
    }
    if (rec.timer !== undefined) this.deps.scheduler.clear(rec.timer);
    rec.timer = undefined;
    rec.expiresAt = undefined;
    rec.decidedBy = 'user';
    rec.decidedAt = this.deps.now();
    rec.shareResult = options.shareResult;
    // every run is on the trail first, approved ones too: without it the request stays pending
    rec.status = 'running';
    if (!this.recordStart(rec)) {
      rec.status = 'pending_approval';
      rec.decidedBy = undefined;
      rec.decidedAt = undefined;
      rec.timer = this.deps.scheduler.set(() => {
        if (rec.status === 'pending_approval') this.finish(rec, 'expired', { decidedBy: 'timeout' });
      }, PENDING_TTL_MS);
      rec.expiresAt = this.deps.now() + PENDING_TTL_MS;
      throw new AgentError(ref('agentsUi.error.trailPending'), 'trail_unavailable');
    }
    if (options.grantReads) this.grant(rec.environment.id, options.shareResult, rec.id);
    this.changed(rec);
    void this.execute(rec);
    return this.view(rec, true);
  }

  reject(id: string, reason?: string): AgentRequestView {
    const rec = this.requireInState(id, 'pending_approval');
    const text = reason?.trim() ? clean(reason, 300) : undefined;
    this.finish(rec, 'rejected', { decidedBy: 'user', ...(text ? { rejectionReason: text } : {}) });
    return this.view(rec, true);
  }

  async commit(id: string): Promise<AgentRequestView> {
    const rec = this.requireInState(id, 'awaiting_commit');
    if (rec.resolving) throw new AgentError(ref('agentsUi.error.resolving'), 'invalid_state');
    await this.commitNow(rec, 'user');
    return this.view(rec, true);
  }

  /** The Commit, by the person or by the policy (autonomous write within the limits). */
  private async commitNow(rec: Rec, by: 'user' | 'policy'): Promise<void> {
    rec.resolving = true;
    this.clearTimer(rec);
    rec.secondDecision = { by, at: this.deps.now() };
    try {
      await rec.write!.commit();
      this.finish(rec, 'committed', {});
    } catch (error) {
      if (error instanceof AgentError && error.code === 'commit_unknown') {
        this.finish(rec, 'failed', { error: { message: error.message, code: 'commit_unknown', ...(error.ref ? { ref: error.ref } : {}) } });
      } else {
        this.finish(rec, 'failed', { error: { ...bothWays(ref('agentsUi.error.commitFailed')), code: 'commit_failed' } });
      }
    }
  }

  async rollback(id: string): Promise<AgentRequestView> {
    const rec = this.requireInState(id, 'awaiting_commit');
    if (rec.resolving) throw new AgentError(ref('agentsUi.error.resolving'), 'invalid_state');
    await this.rollbackNow(rec, 'user', 'user');
    return this.view(rec, true);
  }

  /**
   * An environment was edited (host, port, credential, default database, production flag) or removed, or the
   * credential it uses changed: its grants end, its pending requests expire and the agents' connections close.
   * An open write keeps its own connection until the person decides.
   */
  async environmentChanged(environmentId: string): Promise<void> {
    const grant = this.grants.get(environmentId);
    if (grant) {
      this.deps.scheduler.clear(grant.timer);
      this.grants.delete(environmentId);
      this.auditGrant(environmentId, 'environment_changed', 'environment');
    }
    for (const rec of [...this.records.values()]) {
      if (rec.environment.id === environmentId && rec.status === 'pending_approval') {
        this.finish(rec, 'expired', { decidedBy: 'environment', rejectionRef: environmentChanged() });
      }
    }
    await this.deps.executor.environmentChanged(environmentId);
    this.deps.onChange();
  }

  /** Alerts for the person only (never sent to the agent): written in the app locale. */
  private nonTransactionalWarnings(tree: SchemaTree | null, statements: ClassifiedStatement[], dialect: Dialect): string[] {
    const msg = m().agentsUi.nonTransactional;
    if (!tree) {
      // fail closed: without metadata nobody knows what the Rollback can undo
      return [msg.cannotCheck];
    }
    const mentioned = new Set(statements.flatMap((s) => dialect.identifiers(s.text)));
    const nonTransactional = new Map<string, string>(); // "db.table" and "table" → engine
    const objects = new Map<string, { db: SchemaTree['databases'][number]; table: SchemaTree['databases'][number]['tables'][number] }[]>();
    const routines = new Map<string, (string | null)[]>(); // every schema's routine of that name: never one hiding another
    for (const db of tree.databases) {
      for (const table of db.tables) {
        for (const key of [`${db.name}.${table.name}`.toLowerCase(), table.name.toLowerCase()]) {
          objects.set(key, [...(objects.get(key) ?? []), { db, table }]);
        }
        if (table.type !== 'table' || !table.engine || table.engine.toLowerCase() === 'innodb') continue;
        nonTransactional.set(`${db.name}.${table.name}`.toLowerCase(), table.engine);
        nonTransactional.set(table.name.toLowerCase(), table.engine);
      }
      for (const r of db.routines ?? []) routines.set(r.name.toLowerCase(), [...(routines.get(r.name.toLowerCase()) ?? []), r.body]);
    }
    const anyNonTransactional = nonTransactional.size > 0;
    const out = new Set<string>();
    const blindTriggers = new Set<string>(); // tables whose triggers this account cannot see
    const MAX_DEPTH = 6;

    /** What a piece of SQL (trigger or routine body) can reach: a non-transactional table, or a routine nobody can read. */
    const walkBody = (body: string, origin: string, depth: number, seen: Set<string>): void => {
      for (const id of dialect.identifiers(body)) {
        const engine = nonTransactional.get(id);
        if (engine) out.add(msg.writesTo({ origin, table: id, engine }));
        // a table or view the body writes may have triggers or tables of its own: follow it like a named one
        if (!engine && objects.has(id) && depth < MAX_DEPTH) walkObject(id, id, depth + 1, seen);
        const candidates = routines.get(id);
        if (!candidates || depth >= MAX_DEPTH || seen.has(`r:${id}`)) continue;
        seen.add(`r:${id}`);
        for (const inner of candidates) {
          if (inner === null) out.add(msg.routineUnreadFrom({ name: id, origin: origin.toLowerCase() }));
          else walkBody(inner, origin, depth + 1, seen);
        }
      }
    };

    /** A table or view a write names: its engine, its triggers, and for a view every object under it. */
    const walkObject = (key: string, label: string, depth: number, seen: Set<string>): void => {
      if (seen.has(`o:${key}`) || depth > MAX_DEPTH) return;
      seen.add(`o:${key}`);
      for (const { db, table } of objects.get(key) ?? []) {
        const full = `${db.name}.${table.name}`.toLowerCase();
        if (table.type === 'table') {
          const engine = nonTransactional.get(full);
          if (engine) {
            out.add(label === table.name ? msg.table({ table: table.name, engine }) : msg.view({ view: label, table: full }));
          }
          for (const body of table.triggers ?? []) walkBody(body, msg.originTrigger({ table: table.name }), depth + 1, seen);
          if (db.triggersVisible === false && anyNonTransactional && !engine) blindTriggers.add(full);
        } else if (!table.uses || table.uses.length === 0) {
          out.add(msg.viewTables({ view: table.name }));
        } else {
          for (const used of table.uses) walkObject(used, label, depth + 1, seen);
        }
      }
    };

    const result = (): string[] => {
      if (blindTriggers.size > 0) {
        out.add(msg.triggersUnchecked({ tables: [...blindTriggers].join(', ') }));
      }
      return [...out];
    };
    for (const id of mentioned) {
      if (objects.has(id)) walkObject(id, id, 0, new Set());
      const candidates = routines.get(id);
      for (const body of candidates ?? []) {
        if (body === null) out.add(msg.routineUnread({ name: id }));
        else walkBody(body, msg.originRoutine({ name: id }), 1, new Set([`r:${id}`]));
      }
    }
    return result();
  }

  revokeGrant(environmentId: string): void {
    const grant = this.grants.get(environmentId);
    if (!grant) return;
    this.deps.scheduler.clear(grant.timer);
    this.grants.delete(environmentId);
    this.auditGrant(environmentId, 'revoked', 'user');
    this.deps.onChange();
  }

  /** The trail records every 15-minute grant: who opened it from which request, and how it ended. */
  private auditGrant(environmentId: string, state: string, decidedBy: string, extra: { requestId?: string; shareResult?: boolean } = {}): void {
    const env = this.deps.catalog.environments().find((e) => e.id === environmentId);
    this.deps.audit.append({
      id: this.deps.newId(),
      ...(extra.requestId ? { requestId: extra.requestId } : {}),
      actor: 'person',
      client: 'pessoa',
      environment: env ? this.slugOf(env) : environmentId,
      environmentId,
      production: env?.production ?? true,
      mode: 'grant',
      sql: '',
      state,
      decidedBy,
      decidedAt: this.deps.now(),
      ...(extra.shareResult !== undefined ? { shareResult: extra.shareResult } : {}),
    });
  }

  // --- internals ---------------------------------------------------------------------------

  private requireInState(id: string, status: AgentRequestStatus): Rec {
    const rec = this.records.get(id);
    if (!rec) throw new AgentError(ref('agentsUi.error.notFound'), 'not_found');
    if (rec.status !== status) throw new AgentError(ref('agentsUi.error.wrongState'), 'invalid_state');
    return rec;
  }

  private countPending(): number {
    let n = 0;
    for (const r of this.records.values()) if (r.status === 'pending_approval') n++;
    return n;
  }

  private grantActive(environmentId: string): boolean {
    const grant = this.grants.get(environmentId);
    return !!grant && grant.expiresAt > this.deps.now();
  }

  private grant(environmentId: string, shareResult: boolean, requestId: string): void {
    const previous = this.grants.get(environmentId);
    if (previous) this.deps.scheduler.clear(previous.timer);
    const expiresAt = this.deps.now() + READ_GRANT_MS;
    const timer = this.deps.scheduler.set(() => {
      const current = this.grants.get(environmentId);
      if (current && current.expiresAt <= this.deps.now()) {
        this.grants.delete(environmentId);
        this.auditGrant(environmentId, 'expired', 'timeout');
        this.deps.onChange();
      }
    }, READ_GRANT_MS);
    this.grants.set(environmentId, { expiresAt, timer, shareResult });
    this.auditGrant(environmentId, 'created', 'user', { requestId, shareResult });
  }

  private clearTimer(rec: Rec): void {
    if (rec.timer !== undefined) this.deps.scheduler.clear(rec.timer);
    rec.timer = undefined;
  }

  /** Runs an approved (or policy-cleared) request. Never called for a request nobody cleared. */
  private async execute(rec: Rec): Promise<void> {
    if (rec.status !== 'running') return;
    const args = { ...(rec.database ? { database: rec.database } : {}), statements: rec.plan, maxRows: rec.maxRows };
    try {
      if (rec.mode === 'read') {
        const outcome = await this.deps.executor.runRead(rec.environment, args);
        rec.results = outcome.results;
        if (outcome.error) this.finish(rec, 'failed', { error: outcome.error });
        else this.finish(rec, 'succeeded', {});
        return;
      }
      const run = await this.deps.executor.runWrite(rec.environment, args);
      rec.results = run.results;
      if (run.error) {
        this.finish(rec, 'failed', {
          error: { ...run.error, statementIndex: Math.max(0, run.results.length - 1) },
          ...(run.rollbackIncomplete ? { rollbackIncomplete: true } : {}),
        });
      } else if (!run.open) {
        this.finish(rec, 'succeeded', {});
      } else if (!this.enabled) {
        rec.write = run;
        await this.rollbackNow(rec, 'access_off', 'shutdown');
      } else if (rec.autoCommit && this.autoCommitStop(rec, run.results) === null) {
        rec.write = run;
        const entries = (this.autoCommitted.get(rec.environment.id) ?? []).filter((c) => c.at > this.deps.now() - AUTO_COMMIT_WINDOW_MS);
        entries.push({ at: this.deps.now(), rows: affectedOf(run.results) });
        this.autoCommitted.set(rec.environment.id, entries);
        await this.commitNow(rec, 'policy');
        // nobody looked at this one: a commit whose outcome is unknown must reach the person
        if ((rec.status as AgentRequestStatus) === 'failed' && rec.error?.code === 'commit_unknown') this.deps.onNewPending(this.view(rec, true));
      } else {
        rec.write = run;
        if (rec.autoCommit) rec.commitReason = this.autoCommitStop(rec, run.results)!;
        rec.status = 'awaiting_commit';
        rec.rollbackAt = this.deps.now() + ROLLBACK_AFTER_MS;
        rec.timer = this.deps.scheduler.set(() => {
          if (rec.status === 'awaiting_commit' && !rec.resolving) void this.rollbackNow(rec, 'timeout', 'timeout');
        }, ROLLBACK_AFTER_MS);
        this.changed(rec);
        // nobody approved this one up front: tell the person it waits for them
        if (rec.autoCommit) this.deps.onNewPending(this.view(rec, true));
      }
    } catch (error) {
      const known =
        error instanceof AgentError
          ? { message: error.message, code: error.code, ...(error.ref ? { ref: error.ref } : {}) }
          : { ...bothWays(ref('agentsUi.error.unexpected')), code: 'internal_error' };
      this.finish(rec, 'failed', { error: known });
    }
  }

  private async rollbackNow(rec: Rec, reason: RollbackReason, by: 'user' | 'timeout' | 'shutdown'): Promise<void> {
    if (rec.resolving && reason !== 'user') return;
    rec.resolving = true;
    this.clearTimer(rec);
    rec.secondDecision = { by, at: this.deps.now() };
    let incomplete = false;
    try {
      incomplete = (await rec.write?.rollback())?.incomplete === true;
    } catch {
      // closing the connection rolls back anyway
    }
    this.finish(rec, 'rolled_back', { rollbackReason: reason, ...(incomplete ? { rollbackIncomplete: true } : {}) });
  }

  private finish(
    rec: Rec,
    status: AgentRequestStatus,
    extra: Partial<Pick<Rec, 'decidedBy' | 'rejectionReason' | 'rejectionRef' | 'rollbackReason' | 'rollbackIncomplete' | 'error'>>,
  ): void {
    this.clearTimer(rec);
    rec.status = status;
    rec.finishedAt = this.deps.now();
    rec.rollbackAt = undefined;
    rec.expiresAt = undefined;
    Object.assign(rec, extra);
    if (status === 'expired' || status === 'rejected') rec.decidedAt ??= rec.finishedAt;
    // data leaves memory with the connection, not with the record: drop results nobody may read
    if (status === 'rolled_back' || status === 'rejected' || status === 'expired') rec.results = undefined;
    rec.write = undefined;
    this.deps.audit.append({
      ...this.trailBase(rec),
      state: status,
      ...(rec.decidedBy ? { decidedBy: rec.decidedBy } : {}),
      ...(rec.decidedAt ? { decidedAt: rec.decidedAt } : {}),
      ...(rec.secondDecision ? { secondDecidedBy: rec.secondDecision.by } : {}),
      ...(rec.autoCommit ? { autoCommit: true } : {}),
      ...(rec.results ? { statements: rec.results.map(trailCounts) } : {}),
      ...trailBytes(rec),
      shareResult: rec.shareResult,
      ...(rec.rollbackReason ? { rollbackReason: rec.rollbackReason } : {}),
      ...(rec.rollbackIncomplete ? { rollbackIncomplete: true } : {}),
      ...(rec.error?.code ? { errorCode: rec.error.code } : {}),
    });
    this.changed(rec);
  }

  /** Why this autonomous write must wait for the person now: the limits, or the environment no longer lets it commit. */
  private autoCommitStop(rec: Rec, results: StatementResult[]): MessageRef | null {
    const now = this.deps.catalog.environments().find((e) => e.id === rec.environment.id);
    if (now && now.production !== rec.production) {
      // the card, the agent's reply and the trail must say what the environment is now
      rec.production = now.production;
    }
    if (!now || agentLevelOf(now) !== 'free-reads-writes') {
      return ref('agentsUi.commitStop.levelChanged');
    }
    const single = autoCommitBlockerRef(results);
    if (single) return single;
    const cutoff = this.deps.now() - AUTO_COMMIT_WINDOW_MS;
    const recent = (this.autoCommitted.get(rec.environment.id) ?? []).filter((c) => c.at > cutoff);
    const before = recent.reduce((n, c) => n + c.rows, 0);
    if (before + affectedOf(results) > AUTO_COMMIT_WINDOW_ROWS) {
      return ref('agentsUi.commitStop.windowRows', { limit: AUTO_COMMIT_WINDOW_ROWS, count: before });
    }
    return null;
  }

  /** A write of an agent in this environment is running or waiting for its Commit. */
  private openWriteIn(environmentId: string): boolean {
    for (const r of this.records.values()) {
      if (r.environment.id === environmentId && r.mode === 'write' && (r.status === 'running' || r.status === 'awaiting_commit')) return true;
    }
    return false;
  }

  /** What every trail line of a request carries. */
  private trailBase(rec: Rec): AuditEntry {
    return {
      id: rec.id,
      client: rec.client,
      environment: rec.slug,
      environmentId: rec.environment.id,
      production: rec.production,
      mode: rec.mode,
      ...(rec.database ? { database: rec.database } : {}),
      ...(rec.reason ? { reason: rec.reason } : {}),
      sql: rec.sql,
      state: '',
    };
  }

  private trailOk(): boolean {
    return this.deps.audit.healthy?.() ?? true;
  }

  /** A line before the request runs, so even a crash in the middle leaves it in the trail. False: it was not written. */
  private recordStart(rec: Rec): boolean {
    const written = this.deps.audit.append({
      ...this.trailBase(rec),
      state: 'running',
      decidedBy: rec.decidedBy ?? (rec.underGrant ? 'grant' : 'policy'),
      ...(rec.autoCommit ? { autoCommit: true } : {}),
      ...trailBytes(rec),
      ...(rec.forcedReason ? { detail: render(rec.forcedReason) } : {}),
    });
    return written !== false;
  }

  private changed(rec: Rec): void {
    this.deps.onChange();
    const set = this.waiters.get(rec.id);
    if (set) for (const wake of [...set]) wake();
  }

  /** Resolves true when `until(status)` holds, false when the time ran out first. */
  private waitFor(rec: Rec, until: (status: AgentRequestStatus) => boolean, ms: number, signal?: AbortSignal): Promise<boolean> {
    if (until(rec.status)) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer: unknown;
      const set = this.waiters.get(rec.id) ?? new Set<() => void>();
      this.waiters.set(rec.id, set);
      const done = (ok: boolean): void => {
        set.delete(check);
        if (set.size === 0) this.waiters.delete(rec.id);
        if (timer !== undefined) this.deps.scheduler.clear(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(ok);
      };
      const onAbort = (): void => done(false);
      signal?.addEventListener('abort', onAbort);
      const check = (): void => {
        if (until(rec.status)) done(true);
      };
      set.add(check);
      timer = this.deps.scheduler.set(() => done(false), clamp(ms, 1000, 3600_000));
    });
  }

  /** Test helper and CLI long-poll: wait for a status predicate. */
  waitForStatus(id: string, until: (status: AgentRequestStatus) => boolean, ms: number): Promise<boolean> {
    const rec = this.records.get(id);
    return rec ? this.waitFor(rec, until, ms) : Promise.resolve(false);
  }

  private trim(): void {
    if (this.records.size <= MAX_RECENT) return;
    const finals = [...this.records.values()].filter((r) => isFinalStatus(r.status)).sort((a, b) => a.createdAt - b.createdAt);
    for (const r of finals) {
      if (this.records.size <= MAX_RECENT) break;
      this.records.delete(r.id);
    }
  }

  // --- shaping -----------------------------------------------------------------------------

  private statementViews(rec: Rec): AgentStatementView[] {
    return rec.views.map((v, i) => {
      const estimate = rec.estimates?.[i];
      const r = rec.results?.[i];
      if (!r) return estimate !== undefined ? { ...v, bytesEstimated: estimate } : v;
      v = estimate !== undefined ? { ...v, bytesEstimated: estimate } : v;
      return {
        ...v,
        ...(r.columns ? { rows: r.rows?.length ?? 0 } : {}),
        ...(r.stats?.bytesBilled !== undefined && !r.stats.reread ? { bytesBilled: r.stats.bytesBilled } : {}),
        ...(!r.columns && r.affectedRows !== undefined ? { affectedRows: r.affectedRows } : {}),
        ...(r.error ? { error: r.error.message } : {}),
      };
    });
  }

  /** What the renderer sees. Counts only; `full` keeps the whole SQL, otherwise long text is cut. */
  private view(rec: Rec, full: boolean): AgentRequestView {
    const cut = (text: string, max: number): string => (full || text.length <= max ? text : `${text.slice(0, max)}…`);
    return {
      id: rec.id,
      createdAt: rec.createdAt,
      client: rec.client,
      environmentId: rec.environment.id,
      environmentLabel: rec.label,
      ...(rec.database ? { database: rec.database } : {}),
      production: rec.production,
      mode: rec.mode,
      ...(rec.reason ? { reason: rec.reason } : {}),
      sql: cut(rec.sql, 4000),
      statements: this.statementViews(rec).map((s) => ({ ...s, sql: cut(s.sql, 400) })),
      warnings: rec.warnings,
      status: rec.status,
      ...(rec.expiresAt ? { expiresAt: rec.expiresAt } : {}),
      ...(rec.rollbackAt ? { rollbackAt: rec.rollbackAt } : {}),
      ...(rec.decidedBy ? { decidedBy: rec.decidedBy } : {}),
      ...(rec.decidedAt ? { decidedAt: rec.decidedAt } : {}),
      ...(rec.autoCommit ? { autoCommit: true } : {}),
      ...(rec.approvalReason ? { approvalReason: render(rec.approvalReason) } : {}),
      ...(rec.commitReason ? { commitReason: render(rec.commitReason) } : {}),
      ...(rec.secondDecision ? { secondDecidedBy: rec.secondDecision.by } : {}),
      shareResult: rec.shareResult,
      ...(rec.rejectionRef ? { rejectionReason: render(rec.rejectionRef) } : rec.rejectionReason ? { rejectionReason: rec.rejectionReason } : {}),
      ...(rec.rollbackReason ? { rollbackReason: rec.rollbackReason } : {}),
      ...(rec.rollbackIncomplete ? { rollbackIncomplete: true } : {}),
      ...(rec.error ? { errorMessage: rec.error.message } : {}),
      ...(rec.finishedAt ? { finishedAt: rec.finishedAt } : {}),
    };
  }

  /**
   * What the agent gets. Result data only when the person allowed it, and only once the outcome is settled.
   * Every text is in AGENT_LOCALE (pt-BR, fixed), whatever the app locale.
   */
  private response(rec: Rec, timedOut?: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {
      request_id: rec.id,
      status: rec.status,
      environment: rec.slug,
      production: rec.production,
      mode: rec.mode,
      ...(rec.database ? { database: rec.database } : {}),
    };
    if (rec.status === 'pending_approval' && rec.expiresAt) out.expires_at = new Date(rec.expiresAt).toISOString();
    if (rec.status === 'awaiting_commit' && rec.rollbackAt) out.rollback_at = new Date(rec.rollbackAt).toISOString();
    if (rec.approvalReason) out.approval_reason = renderRef(rec.approvalReason, AGENT_LOCALE);
    if (rec.commitReason) out.commit_reason = renderRef(rec.commitReason, AGENT_LOCALE);
    Object.assign(out, decisionFields(rec));
    if (rec.rejectionRef) out.rejection_reason = renderRef(rec.rejectionRef, AGENT_LOCALE);
    else if (rec.rejectionReason) out.rejection_reason = rec.rejectionReason;
    if (rec.rollbackReason) out.rollback_reason = rec.rollbackReason;
    if (rec.rollbackIncomplete) out.rollback_incomplete = true;
    if (rec.error) {
      const { statementIndex, ref: _ref, serverText, ...rest } = rec.error;
      const error = { ...rest, message: agentText(rec.error) };
      out.error = {
        ...(rec.shareResult ? error : withheldError({ ...error, ...(serverText ? { serverText } : {}) })),
        ...(statementIndex !== undefined ? { statement_index: statementIndex } : {}),
      };
    }
    if (timedOut) out.timed_out = true;
    // a failed write returns only the error and which command failed: results come after a Commit
    const resultsAllowed = rec.status === 'succeeded' || rec.status === 'committed' || (rec.status === 'failed' && rec.mode === 'read');
    if (rec.results && resultsAllowed) {
      if (rec.shareResult) {
        out.results = rec.results.map((r) => shareable(r));
      } else {
        out.result_withheld = true;
        out.results = rec.results.map((r) => counts(r));
      }
    }
    return out;
  }
}

/**
 * Who decided, for the agent: `decided_by` is 'person' when the person approved or rejected it, and
 * 'policy' when the environment's level (or a 15-minute grant, which the person did not see for this request) let it
 * run. Expired requests carry nothing: the status already says it. A committed write always says whether the Commit
 * was automatic, from the second decision (`autoCommit` only means eligible); `commit_unknown` ends as failed, so it
 * never carries `auto_commit`.
 */
export function decisionFields(
  rec: { status: AgentRequestStatus; mode: AgentMode; decidedBy?: AgentRequestView['decidedBy']; secondDecision?: { by: string } },
): { decided_by?: AgentDecider; auto_commit?: boolean } {
  const out: { decided_by?: AgentDecider; auto_commit?: boolean } = {};
  if (rec.decidedBy === 'user') out.decided_by = 'person';
  else if (rec.decidedBy === 'policy' || rec.decidedBy === 'grant') out.decided_by = 'policy';
  if (rec.mode === 'write' && rec.status === 'committed') out.auto_commit = rec.secondDecision?.by === 'policy';
  return out;
}

function shareable(r: StatementResult): Record<string, unknown> {
  return {
    index: r.index,
    sql: r.sql,
    verb: r.verb,
    kind: r.kind,
    duration_ms: r.durationMs,
    // only name and type: the grid's metadata (source table, key flags) is not part of the agent contract
    ...(r.columns ? { columns: r.columns.map((c) => ({ name: c.name, type: c.type })), rows: r.rows as CellValue[][], row_count: r.rows?.length ?? 0 } : {}),
    ...(r.truncated ? { truncated: true } : {}),
    ...(r.affectedRows !== undefined ? { affected_rows: r.affectedRows } : {}),
    ...(r.insertId !== undefined ? { insert_id: r.insertId } : {}),
    ...(r.warnings ? { warnings: r.warnings } : {}),
    // engines that bill by bytes read: what the job read and was billed (MySQL has no stats: its output does not change)
    ...(r.stats?.bytesEstimated !== undefined ? { bytes_estimated: r.stats.bytesEstimated } : {}),
    ...(r.stats?.bytesProcessed !== undefined ? { bytes_processed: r.stats.bytesProcessed } : {}),
    ...(r.stats?.bytesBilled !== undefined ? { bytes_billed: r.stats.bytesBilled } : {}),
    ...(r.error ? { error: shareableError(r.error) } : {}),
  };
}

const shareableError = (e: { message: string; code?: string }): { message: string; code?: string } => ({
  message: agentText(e),
  ...(e.code ? { code: e.code } : {}),
});

/**
 * Server errors can quote row values ("Duplicate entry 'x'"): without the person's yes, only the code travels.
 * Agent-facing: fixed pt-BR.
 */
function withheldError(e: { message: string; code?: string; serverText?: boolean }): { message: string; code?: string } {
  if (e.code?.startsWith('ER_') || e.serverText) {
    return { message: 'O servidor recusou o comando. Os detalhes foram omitidos.', ...(e.code ? { code: e.code } : {}) };
  }
  const { serverText: _quoted, ...own } = e;
  return own;
}

/** Result with the person's "no" on sharing: only how many rows, never which. */
function counts(r: StatementResult): Record<string, unknown> {
  return {
    index: r.index,
    verb: r.verb,
    kind: r.kind,
    duration_ms: r.durationMs,
    ...(r.columns ? { row_count: r.rows?.length ?? 0 } : {}),
    ...(r.truncated ? { truncated: true } : {}),
    ...(r.affectedRows !== undefined ? { affected_rows: r.affectedRows } : {}),
    ...(r.error
      ? {
          error: withheldError({
            message: agentText(r.error),
            ...(r.error.code ? { code: r.error.code } : {}),
            ...(r.error.serverText ? { serverText: true } : {}),
          }),
        }
      : {}),
  };
}

/** Counts of one command for the trail: never which rows. */
function trailCounts(r: StatementResult): TrailStatement {
  return {
    verb: r.verb,
    ...(r.stats?.jobId ? { jobId: r.stats.jobId } : {}),
    ...(r.stats?.bytesEstimated !== undefined && !r.stats.reread ? { bytesEstimated: r.stats.bytesEstimated } : {}),
    ...(r.stats?.bytesBilled !== undefined && !r.stats.reread ? { bytesBilled: r.stats.bytesBilled } : {}),
    ...(r.columns ? { rows: r.rows?.length ?? 0 } : {}),
    ...(!r.columns && r.affectedRows !== undefined ? { affectedRows: r.affectedRows } : {}),
    ...(r.error?.code ? { errorCode: r.error.code } : {}),
  };
}

/**
 * Why an autonomous write must not commit by itself after running, or null: more rows than the
 * limit, or a warning from the server (a value cut or converted). The person then makes the second decision.
 */
export function autoCommitBlockerRef(results: StatementResult[]): MessageRef | null {
  const affected = results.reduce((n, r) => n + (r.columns ? 0 : (r.affectedRows ?? 0)), 0);
  if (affected > AUTO_COMMIT_MAX_ROWS) return ref('agentsUi.commitStop.tooManyRows', { count: affected, limit: AUTO_COMMIT_MAX_ROWS });
  const warned = results.reduce((n, r) => n + (r.warnings ?? 0), 0);
  if (warned > 0) return ref('agentsUi.commitStop.serverWarnings', { count: warned });
  return null;
}

/** `autoCommitBlockerRef`, rendered in the app locale. */
export function autoCommitBlocker(results: StatementResult[]): string | null {
  const r = autoCommitBlockerRef(results);
  return r ? render(r) : null;
}

/** Rows the server says the writes changed (reads count nothing). */
function affectedOf(results: StatementResult[]): number {
  return results.reduce((n, r) => n + (r.columns ? 0 : (r.affectedRows ?? 0)), 0);
}

const AUTO_VERBS = new Set(['INSERT', 'REPLACE', 'UPDATE', 'DELETE']);

/** The most that `name` shows in a message: a function name comes from the text the agent wrote. */
const shortName = (name: string): string => (name.length > 80 ? `${name.slice(0, 80)}…` : name);

/**
 * A read that calls what the person should look at first (BigQuery): a generative AI or model function (`ML.`, `AI.`),
 * a function defined in the project (it may be remote and run code outside the engine) or an unqualified function that
 * is not a built-in. Null for everything else, and always null for MySQL.
 */
function functionApprovalRef(statements: ClassifiedStatement[], dialect: Dialect): MessageRef | null {
  const remote = statements.flatMap((s) => s.c.remoteCalls ?? []);
  const bare = (name: string): string => name.replace(/^SAFE\./, '');
  const ai = remote.find((n) => /^(ML|AI)\./.test(bare(n)));
  if (ai) return ref('agentsUi.approval.generativeAi', { name: shortName(ai) });
  if (remote.length > 0) return ref('agentsUi.approval.remoteFunction', { name: shortName(remote[0]!) });
  const isUnknown = dialect.agentRules.isUnknownFunction;
  const unknown = isUnknown ? statements.flatMap((s) => s.c.functions ?? []).find((f) => isUnknown(f)) : undefined;
  return unknown ? ref('agentsUi.approval.unknownFunction', { name: shortName(unknown) }) : null;
}

/**
 * A read estimated above what an agent may take without the person (10 GiB, fixed, or the environment's limit when
 * lower): the reason it waits, with the estimate summed over the request. Null otherwise.
 */
function bytesApprovalRef(env: Environment, prepared: PreparedStatement[]): MessageRef | null {
  const limit = env.engine === 'bigquery' ? env.maxBytesBilled : undefined;
  const threshold = bytesThreshold(env);
  // the whole request: several commands under the threshold each may be over it together
  const total = prepared.reduce((n, p) => n + (p.failed ? 0 : (p.bytesEstimated ?? 0)), 0);
  if (total <= threshold) return null;
  return limit !== undefined && total > limit
    ? ref('agentsUi.approval.overLimit', { bytes: total, limit })
    : ref('agentsUi.approval.bigRead', { bytes: total, threshold });
}

/** What an agent may read without the person: 10 GiB, or the environment's limit when that is lower. */
function bytesThreshold(env: Environment): number {
  const limit = env.engine === 'bigquery' ? env.maxBytesBilled : undefined;
  return Math.min(AGENT_BYTES_APPROVAL, limit ?? Number.POSITIVE_INFINITY);
}

/** What a trail line of a request says about bytes and jobs (BigQuery): sums over the commands. Empty for MySQL. */
function trailBytes(rec: { estimates?: (number | undefined)[]; results?: StatementResult[] }): Pick<AuditEntry, 'jobId' | 'bytesEstimated' | 'bytesBilled'> {
  const fresh = (rec.results ?? []).filter((r) => r.stats && !r.stats.reread);
  const estimated = fresh.length > 0 ? fresh.map((r) => r.stats?.bytesEstimated) : (rec.estimates ?? []);
  const sum = (values: (number | undefined)[]): number | undefined => (values.some((v) => v !== undefined) ? values.reduce<number>((n, v) => n + (v ?? 0), 0) : undefined);
  const est = sum(estimated);
  const billed = sum(fresh.map((r) => r.stats?.bytesBilled));
  const jobs = fresh.map((r) => r.stats?.jobId).filter((j): j is string => !!j);
  return {
    ...(jobs.length === 1 ? { jobId: jobs[0]! } : {}),
    ...(est !== undefined ? { bytesEstimated: est } : {}),
    ...(billed !== undefined ? { bytesBilled: billed } : {}),
  };
}

/**
 * Why a write the level lets run must still go to the person, before running: what the Cais
 * cannot count or bound. Rows changed by triggers and cascading foreign keys never show in the server's
 * affected rows, a stored function or a view can write anything, and without full metadata nobody knows.
 */
export function autonomyBlockerRef(tree: SchemaTree | null, statements: ClassifiedStatement[]): MessageRef | null {
  if (!tree) return ref('agentsUi.approval.noMetadata');
  if (tree.databases.some((d) => d.partial)) return ref('agentsUi.approval.partialMetadata');
  const other = statements.find((s) => !AUTO_VERBS.has(s.c.verb));
  // a delete or an update (REPLACE deletes, ON DUPLICATE KEY updates) can cascade into tables the account cannot
  // see; InnoDB cascades anyway. Plain INSERT never cascades.
  const mayCascade = statements.some((s) => s.c.verb !== 'INSERT' || /\bON\s+DUPLICATE\s+KEY\b/i.test(s.text));
  if (!other && mayCascade && tree.foreignKeysComplete !== true) {
    return ref('agentsUi.approval.foreignKeysHidden');
  }
  if (other) return other.c.verb ? ref('agentsUi.approval.otherVerb', { verb: other.c.verb }) : ref('agentsUi.approval.otherStatement');
  const routines = new Set(tree.databases.flatMap((d) => (d.routines ?? []).map((r) => r.name.toLowerCase())));
  for (const s of statements) {
    const fn = (s.c.functions ?? []).find((f) => f.startsWith('#NON_ASCII:') || routines.has(f.toLowerCase()));
    if (fn) return ref('agentsUi.approval.dbFunction', { name: fn.replace(/^#NON_ASCII:/, '') });
  }
  const objects = new Map<string, { db: SchemaTree['databases'][number]; table: SchemaTree['databases'][number]['tables'][number] }[]>();
  for (const db of tree.databases) {
    for (const table of db.tables) {
      for (const key of [`${db.name}.${table.name}`.toLowerCase(), table.name.toLowerCase()]) objects.set(key, [...(objects.get(key) ?? []), { db, table }]);
    }
  }
  for (const id of new Set(statements.flatMap((s) => s.ids ?? []))) {
    for (const { db, table } of objects.get(id) ?? []) {
      if (table.type === 'view') return ref('agentsUi.approval.view', { name: table.name });
      if ((table.triggers ?? []).length > 0) return ref('agentsUi.approval.trigger', { table: table.name });
      if ((table.cascadedBy ?? []).length > 0) {
        return ref('agentsUi.approval.cascade', { table: table.name, tables: table.cascadedBy!.join(', ') });
      }
      if (db.triggersVisible === false) return ref('agentsUi.approval.triggersHidden', { database: db.name });
    }
  }
  return null;
}

/** `autonomyBlockerRef`, rendered in the app locale. */
export function autonomyBlocker(tree: SchemaTree | null, statements: ClassifiedStatement[]): string | null {
  const r = autonomyBlockerRef(tree, statements);
  return r ? render(r) : null;
}
