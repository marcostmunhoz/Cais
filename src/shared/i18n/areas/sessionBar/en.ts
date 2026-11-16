import { createFormat, type Shape } from '../../core';
import type { ptBR } from './pt-BR';

const f = createFormat('en');

/** Area "sessionBar", English. */
export const en: Shape<typeof ptBR> = {
  connection: {
    disconnected: 'Disconnected',
    idle: 'Disconnected after inactivity',
    connecting: 'Connecting…',
    connected: 'Connected',
    running: 'Running…',
    error: 'Connection error',
  },
  connect: 'Connect',
  reconnect: 'Reconnect',
  disconnect: 'Disconnect',
  disconnectTitle: {
    database: 'Closes this tab’s connection; the text, mode and database stay',
    dataset: 'Closes this tab’s connection; the text, mode and dataset stay',
  },
  disconnectBlockedTransaction: 'Commit or roll back first',
  disconnectBlockedRunning: 'Wait for the statement to finish',
  connectionLost: 'The connection was lost.',
  save: 'Save',
  saveTitle: (p) => `Save script (${p.save}) · Save as (${p.saveAs})`,
  production: 'Production',
  currentDatabase: { database: 'Current database', dataset: 'Current dataset' },
  noDatabase: { database: '(no database)', dataset: '(no dataset)' },
  modeGroup: 'Session mode',
  mode: {
    'read-only': 'Read-only',
    transaction: 'Transaction',
    autocommit: 'Auto-commit',
  },
  modeUnsupported: (p) => `${p.engine} does not support this mode.`,
  cancel: 'Cancel',
  run: 'Run',
  txOpen: (p) => `Transaction open · ${f.count(p.statements, { one: 'statement', other: 'statements' })} · ${p.elapsed}`,
  rollback: 'Rollback',
  commit: 'Commit',
};
