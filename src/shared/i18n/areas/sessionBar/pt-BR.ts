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
  disconnectTitle: 'Fecha a conexão desta aba; o texto, o modo e o banco ficam',
  disconnectBlockedTransaction: 'Faça commit ou rollback antes',
  disconnectBlockedRunning: 'Aguarde o comando terminar',
  connectionLost: 'A conexão foi perdida.',
  save: 'Salvar',
  saveTitle: (p: { save: string; saveAs: string }) => `Salvar script (${p.save}) · Salvar como (${p.saveAs})`,
  production: 'Produção',
  currentDatabase: 'Banco atual',
  noDatabase: '(nenhum banco)',
  modeGroup: 'Modo da sessão',
  /** Session modes, as the segmented control shows them. */
  mode: {
    'read-only': 'Somente leitura',
    transaction: 'Transação',
    autocommit: 'Auto-commit',
  },
  cancel: 'Cancelar',
  run: 'Rodar',
  txOpen: (p: { statements: number; elapsed: string }) =>
    `Transação aberta · ${f.count(p.statements, { one: 'comando', other: 'comandos' })} · ${p.elapsed}`,
  rollback: 'Rollback',
  commit: 'Commit',
};
