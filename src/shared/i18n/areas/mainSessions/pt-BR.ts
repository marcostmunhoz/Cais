import { createFormat } from '../../core';

const f = createFormat('pt-BR');
const statements = { one: 'comando', other: 'comandos' };

/** Area "mainSessions": the person's sessions (main/sessions.ts), errors and trail details. pt-BR (the reference). */
export const ptBR = {
  disconnect: {
    transactionOpen: 'Faça commit ou rollback antes de desconectar.',
    running: 'Aguarde o comando terminar para desconectar.',
    connecting: 'A sessão ainda está conectando.',
  },
  gridEdit: 'Edição na grade',
  gridNotUpdate: 'A edição na grade só aplica UPDATE.',
  /** Session modes, as the trail details name them. */
  mode: {
    readOnly: 'Somente leitura',
    transaction: 'Transação',
    autocommit: 'Auto-commit',
  },
  noSession: 'A aba não tem sessão aberta.',
  notConnected: 'A sessão não está conectada. Rode de novo para reconectar.',
  connecting: 'A sessão ainda está conectando.',
  environmentNotFound: 'Ambiente não encontrado.',
  runningInTab: 'Há um comando em execução nesta aba.',
  alreadyRunning: 'Já existe um comando em execução nesta aba.',
  switchEnvironmentTransaction: 'Faça commit ou rollback antes de trocar de ambiente.',
  nowProduction: 'O ambiente agora é produção: a aba voltou para Somente leitura.',
  autocommitNeedsConfirmation: 'Auto-commit em produção precisa de confirmação.',
  environmentChanged: 'O ambiente mudou; vale depois de encerrar a transação.',
  changedWhileConnecting: 'O ambiente mudou enquanto a aba conectava. Conecte de novo para usar os dados novos.',
  lostWithTransaction: (p: { count: number }) =>
    `A conexão caiu e o servidor desfez a transação aberta (${f.count(p.count, statements)}).`,
  setModeRunning: 'Aguarde o comando terminar para trocar o modo.',
  modeNotSupported: (p: { mode: string; engine: string }) => `O modo ${p.mode} não vale para ${p.engine}.`,
  setModeTransaction: 'Faça commit ou rollback antes de trocar o modo.',
  beginNeedsTransactionMode: 'Use o modo Transação da aba para abrir uma transação.',
  readOnlyRefused: 'Somente leitura: este comando não é permitido.',
  nothingToRun: 'Não há nenhum comando para executar.',
  refetchNotRead: 'Buscar mais linhas só vale para uma leitura simples. Rode o comando de novo se quiser repeti-lo.',
  waitStatement: 'Aguarde o comando terminar.',
  closeRunning: 'Cancele o comando em execução antes de fechar a aba.',
  closeTransaction: 'Há uma transação aberta nesta aba. Escolha Commit ou Rollback.',
  /** Details written on the trail, in the app locale of the moment (old lines are never rewritten). */
  trail: {
    openedAutocommitProduction: 'Abriu em Auto-commit em produção (confirmado).',
    openedIn: (p: { mode: string }) => `Abriu em ${p.mode}`,
    modeChanged: (p: { from: string; to: string }) => `${p.from} → ${p.to}`,
    modeChangedProduction: (p: { from: string; to: string }) => `${p.from} → ${p.to} em produção (confirmado)`,
    refetch: (p: { n: number }) => `Buscar até ${f.formatNumber(p.n)} (rodou de novo)`,
    transactionStatements: (p: { count: number }) => `${f.count(p.count, statements)} na transação`,
    onCloseTab: 'ao fechar a aba',
  },
};
