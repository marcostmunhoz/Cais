import { createFormat } from '../../core';

const f = createFormat('pt-BR');

/** Area "sessionBar", pt-BR (the reference catalog: `en.ts` must follow its shape). */
export const ptBR = {
  /** Connection states, shared by the tab strip, the session bar and the status bar. */
  connection: {
    disconnected: 'Desconectado',
    idle: 'Desconectado por inatividade',
    connecting: 'Conectando…',
    connected: 'Conectado',
    running: 'Executando…',
    error: 'Erro de conexão',
  },
  connect: 'Conectar',
  reconnect: 'Reconectar',
  disconnect: 'Desconectar',
  disconnectTitle: {
    database: 'Fecha a conexão desta aba; o texto, o modo e o banco ficam',
    dataset: 'Fecha a conexão desta aba; o texto, o modo e o dataset ficam',
  },
  disconnectBlockedTransaction: 'Faça commit ou rollback antes',
  disconnectBlockedRunning: 'Aguarde o comando terminar',
  connectionLost: 'A conexão foi perdida.',
  save: 'Salvar',
  saveTitle: (p: { save: string; saveAs: string }) => `Salvar script (${p.save}) · Salvar como (${p.saveAs})`,
  production: 'Produção',
  /** Both words of the engine's namespace (the dialect's `databaseTerm` picks one). */
  currentDatabase: { database: 'Banco atual', dataset: 'Dataset atual' },
  noDatabase: { database: '(nenhum banco)', dataset: '(nenhum dataset)' },
  modeGroup: 'Modo da sessão',
  /** Session modes, as the segmented control shows them. */
  mode: {
    'read-only': 'Somente leitura',
    transaction: 'Transação',
    autocommit: 'Auto-commit',
  },
  modeUnsupported: (p: { engine: string }) => `${p.engine} não aceita este modo.`,
  cancel: 'Cancelar',
  run: 'Rodar',
  txOpen: (p: { statements: number; elapsed: string }) =>
    `Transação aberta · ${f.count(p.statements, { one: 'comando', other: 'comandos' })} · ${p.elapsed}`,
  rollback: 'Rollback',
  commit: 'Commit',
};
