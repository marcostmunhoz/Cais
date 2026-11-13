import { createFormat, type Shape } from '../../core';
import type { ptBR } from './pt-BR';

const f = createFormat('en');
const statements = { one: 'statement', other: 'statements' };

/** Area "mainSessions", English. */
export const en: Shape<typeof ptBR> = {
  disconnect: {
    transactionOpen: 'Commit or roll back before disconnecting.',
    running: 'Wait for the statement to finish before disconnecting.',
    connecting: 'The session is still connecting.',
  },
  gridEdit: 'Grid edit',
  gridNotUpdate: 'Grid edits only apply UPDATE statements.',
  mode: {
    readOnly: 'Read-only',
    transaction: 'Transaction',
    autocommit: 'Auto-commit',
  },
  noSession: 'The tab has no open session.',
  notConnected: 'The session is not connected. Run again to reconnect.',
  connecting: 'The session is still connecting.',
  environmentNotFound: 'Environment not found.',
  runningInTab: 'A statement is running in this tab.',
  alreadyRunning: 'A statement is already running in this tab.',
  switchEnvironmentTransaction: 'Commit or roll back before switching environments.',
  nowProduction: 'The environment is now production: the tab went back to Read-only.',
  autocommitNeedsConfirmation: 'Auto-commit in production needs confirmation.',
  environmentChanged: 'The environment changed; it applies after the transaction ends.',
  changedWhilePreparing: 'The environment changed while the query was being checked. Run again to use the new settings.',
  changedWhileConnecting: 'The environment changed while the tab was connecting. Connect again to use the new settings.',
  lostWithTransaction: (p) =>
    `The connection dropped and the server rolled back the open transaction (${f.count(p.count, statements)}).`,
  setModeRunning: 'Wait for the statement to finish before changing the mode.',
  modeNotSupported: (p) => `${p.mode} mode is not available for ${p.engine}.`,
  setModeTransaction: 'Commit or roll back before changing the mode.',
  beginNeedsTransactionMode: 'Use the tab’s Transaction mode to open a transaction.',
  readOnlyRefused: 'Read-only: this statement is not allowed.',
  nothingToRun: 'There is no statement to run.',
  refetchNotRead: 'Fetching more rows only works for a plain read. Run the statement again if you want to repeat it.',
  serverRefusedType: (p) => `The server read this statement as ${p.type}, not as a query. This environment only runs queries.`,
  serverRefusedUnknown: 'The server did not say what kind of statement this is. When in doubt, Cais does not run it.',
  waitStatement: 'Wait for the statement to finish.',
  closeRunning: 'Cancel the running statement before closing the tab.',
  closeTransaction: 'A transaction is open in this tab. Choose Commit or Rollback.',
  trail: {
    openedAutocommitProduction: 'Opened in Auto-commit in production (confirmed).',
    openedIn: (p) => `Opened in ${p.mode}`,
    modeChanged: (p) => `${p.from} → ${p.to}`,
    modeChangedProduction: (p) => `${p.from} → ${p.to} in production (confirmed)`,
    refetch: (p) => `Fetch up to ${f.formatNumber(p.n)} (ran again)`,
    transactionStatements: (p) => `${f.count(p.count, statements)} in the transaction`,
    overLimitConfirmed: (p) => `Over the ${p.limit} limit (estimated ${p.bytes}), confirmed`,
    onCloseTab: 'when closing the tab',
  },
};
