import { createFormat, type Shape } from '../../core';
import type { ptBR } from './pt-BR';

const f = createFormat('en');

/** Area "agentsUi", English. */
export const en: Shape<typeof ptBR> = {
  verbatim: (p) => p.text,

  status: {
    pending_approval: 'Waiting for approval',
    rejected: 'Rejected',
    expired: 'Expired',
    running: 'Running',
    succeeded: 'Done',
    failed: 'Failed',
    awaiting_commit: 'Waiting for commit',
    committed: 'Committed',
    rolled_back: 'Rolled back',
  },
  decidedBy: {
    user: 'you',
    policy: 'environment level (no approval)',
    timeout: 'the time limit',
    shutdown: 'Cais closing',
    environment: 'the environment change',
    grant: '15-min grant (no approval of its own)',
  },
  secondDecidedBy: {
    user: 'you',
    policy: 'automatic (environment level)',
    timeout: 'the time limit',
    shutdown: 'Cais closing',
  },
  rollbackReason: {
    timeout: 'time ran out',
    user: 'you',
    shutdown: 'Cais was closed',
    access_off: 'agent access was turned off',
    unexpected_commit: 'the server ended the transaction',
  },
  kind: {
    read: 'read',
    write: 'write',
    other: 'other',
  },

  modal: {
    statements: 'Request statements',
    statement: (p) => `Statement ${p.n}`,
    environment: 'Environment',
    database: (p) => ` · database ${p.database}`,
    dataset: (p) => ` · dataset ${p.database}`,
    client: 'Client',
    clientNote: '(as stated by the client)',
    reason: 'Reason',
    titleWrite: 'Agent asks to write',
    titleRead: 'Agent asks to read',
    queued: (p) => `${p.count} more in the queue`,
    production: 'Production',
    statementOne: 'statement',
    statementMany: 'statements',
    scrollToEnd: ' · scroll the list to the end to enable the button',
    writeNote:
      'Runs in a transaction. Then you see the affected rows and choose Commit or Rollback. If any statement writes outside the transaction, the request stops and you are told.',
    grantNeedsShare: 'Only with "The agent can see the result" checked',
    grantReads: (p) => `Approve reads on ${p.environment} for 15 min`,
    grantOnlyShared: ' (only if the agent can see the result)',
    share: 'The agent can see the result',
    rejectReason: 'Reason for rejecting (optional)',
    reject: 'Reject',
    runInTransaction: 'Run in transaction',
    approve: 'Approve',
  },

  commitModal: {
    title: 'Agent transaction open',
    rollbackIn: (p) => `rollback in ${p.time}`,
    autoCommitStopped: (p) => `The automatic commit did not happen: ${p.reason}`,
    error: 'error',
    affectedOne: 'row affected',
    affectedMany: 'rows affected',
    rowOne: 'row',
    rowMany: 'rows',
    noRows: 'no rows',
    note: 'Commit saves it for everyone. Rollback undoes everything. Without a decision, Cais rolls back by itself.',
    rollback: 'Rollback',
    commit: 'Commit',
  },

  detail: {
    automatic: ' (automatic)',
    decidedBy: 'Decided by',
    at: (p) => ` at ${p.time}`,
    commitBy: 'Commit by',
    secondDecision: 'Second decision',
    result: 'Result',
    withheld: 'withheld: the agent only got counts',
    rejection: 'Rejection',
    attention: 'Warning',
    rollbackIncomplete: 'Incomplete rollback: the server said non-transactional tables kept what was written.',
    rollbackBy: 'Rollback by',
    error: 'Error',
    sql: 'Request SQL',
  },

  panel: {
    title: 'Agents',
    close: 'Close',
    access: 'Agent access',
    phrase:
      'What an agent runs without asking depends on the environment (Agent access, in the registry). Writes in production always ask for your approval. Everything goes to the trail.',
    pending: 'Pending',
    noPending: 'No request waiting for you.',
    expiresIn: (p) => `expires in ${p.time}`,
    review: 'Review',
    grants: 'Active grants',
    noGrants: 'No reads granted for 15 minutes.',
    grantReads: (p) => `Reads on ${p.environment}`,
    remaining: (p) => `${p.time} left`,
    revoke: 'Revoke',
    byEnvironment: 'By environment',
    noEnvironments: 'No environments yet.',
    recent: 'Recent requests',
    noRecent: 'No requests yet.',
  },

  approval: {
    alert: 'This environment allows writes, but the request has an alert: it waits for your approval.',
    openWrite: 'An agent write is already open in this environment: this one waits for your approval.',
    trailDown: 'The trail could not be written: nothing runs without your approval until it can.',
    noMetadata: 'This environment allows writes, but the database metadata could not be read: the request waits for your approval.',
    partialMetadata:
      'This environment allows writes, but part of the database metadata (triggers, views, routines or foreign keys) could not be read: the request waits for your approval.',
    foreignKeysHidden:
      'This environment allows writes, but the database user cannot see every foreign key that may delete or change rows in cascade (it needs the PROCESS privilege or a global privilege): the request waits for your approval.',
    otherVerb: (p) =>
      `This environment allows writes, but only INSERT, REPLACE, UPDATE and DELETE commit by themselves (there is ${p.verb}): the request waits for your approval.`,
    otherStatement:
      'This environment allows writes, but only INSERT, REPLACE, UPDATE and DELETE commit by themselves (there is another statement): the request waits for your approval.',
    dbFunction: (p) =>
      `This environment allows writes, but the statement calls the database function ${p.name}, which can write anything: the request waits for your approval.`,
    view: (p) => `This environment allows writes, but the statement uses the view ${p.name}: the request waits for your approval.`,
    trigger: (p) =>
      `This environment allows writes, but the table ${p.table} has a trigger, and what it writes is not in the row count: the request waits for your approval.`,
    cascade: (p) =>
      `This environment allows writes, but the table ${p.table} has a cascading foreign key (${p.tables}), and those rows are not in the count: the request waits for your approval.`,
    triggersHidden: (p) =>
      `This environment allows writes, but the database user cannot see the triggers of ${p.database} (it lacks the TRIGGER privilege): the request waits for your approval.`,
  },

  commitStop: {
    levelChanged: 'The environment’s agent access changed while the request ran. Check and decide.',
    windowRows: (p) =>
      `With this write, automatic commits in this environment go past ${f.formatNumber(p.limit)} rows in 15 minutes (${f.formatNumber(p.count)} so far). Check and decide.`,
    tooManyRows: (p) =>
      `It affected ${f.formatNumber(p.count)} rows; automatic commit goes up to ${f.formatNumber(p.limit)}. Check and decide.`,
    serverWarnings: (p) =>
      `The server gave ${p.count === 1 ? '1 warning' : `${p.count} warnings`} on the write (a value cut or converted, for example). Check and decide.`,
  },

  rejection: {
    environmentChanged: 'The environment changed.',
  },

  error: {
    accessOff: 'Agent access is off.',
    grantReadsOnly: 'The 15-minute grant only applies to reads.',
    grantNeedsShare: 'The 15-minute grant requires that the agent can see the result.',
    trailPending: 'The trail could not be written: the request did not run and is still pending.',
    resolving: 'The request is already being resolved.',
    notFound: 'Request not found.',
    wrongState: 'The request is no longer in that state.',
    commitFailed: 'The commit failed and the server rolled the transaction back.',
    unexpected: 'Unexpected error while running the request.',
    timeout: 'Time limit for agents reached.',
    accessClosed: 'Agent access was turned off or the environment changed.',
    unexpectedCommit: 'The server ended the transaction during the request.',
    nonTransactionalWrite: 'The statement wrote outside the transaction (non-transactional or system table): Rollback does not undo it.',
    commitUnknown: 'Could not confirm the commit: the connection dropped after it was sent. Check the database before trying again.',
    connectFailed: 'Could not connect to the environment.',
    connectFailedDetail: (p) => `Could not connect to the environment. ${p.detail}`,
    loginRefused: 'Login refused by the server.',
    credentialUnavailable: 'Could not get the environment’s credential. Ask the person to check the registry in Cais.',
    socketPathTaken: 'A file already exists at the agent socket path.',
    socketInUse: 'Another Cais already has agent access on.',
    socketFailed: (p) => `Could not open the agent socket: ${p.code}.`,
    unknownError: 'unknown error',
  },

  redact: {
    server: '<server>',
    user: '<user>',
    project: '<project>',
    account: '<account>',
  },

  nonTransactional: {
    cannotCheck: 'Could not check whether the tables are transactional: Rollback may not undo everything.',
    originTrigger: (p) => `A trigger of table ${p.table}`,
    originRoutine: (p) => `The routine ${p.name}`,
    writesTo: (p) => `${p.origin} writes to ${p.table}, which is not transactional (${p.engine}): Rollback does not undo that.`,
    routineUnreadFrom: (p) =>
      `Could not read the routine ${p.name} (called by ${p.origin}): Rollback may not undo what it writes.`,
    routineUnread: (p) => `Could not read the routine ${p.name}: Rollback may not undo what it writes.`,
    table: (p) => `The table ${p.table} is not transactional (${p.engine}): Rollback does not undo what is written to it.`,
    view: (p) => `The view ${p.view} uses the non-transactional table ${p.table}: Rollback does not undo what is written through it.`,
    viewTables: (p) => `Could not see the tables of the view ${p.view}: Rollback may not undo everything.`,
    triggersUnchecked: (p) =>
      `Could not check the triggers of ${p.tables} (the TRIGGER privilege is missing) and there are non-transactional tables: Rollback may not undo everything.`,
  },
};
