import { createFormat } from '../../core';

const f = createFormat('pt-BR');

/** Area "trail", pt-BR (the reference catalog: `en.ts` must follow its shape). The trail panel and main's trail store. */
export const ptBR = {
  title: 'Trilha',
  close: 'Fechar',
  period: {
    label: 'Período',
    d1: 'Últimas 24 horas',
    d7: 'Últimos 7 dias',
    d30: 'Últimos 30 dias',
    d90: 'Últimos 90 dias',
  },
  filter: {
    actorLabel: 'Quem',
    actorAll: 'Você e agentes',
    actorPerson: 'Só você',
    actorAgent: 'Só agentes',
    actorCais: 'Só o Cais',
    environmentLabel: 'Ambiente',
    environmentAll: 'Todos os ambientes',
    searchLabel: 'Buscar na trilha',
    searchPlaceholder: 'Buscar no SQL, motivo ou cliente',
  },
  tampered: (p: { days: string }) =>
    `A trilha destes dias não confere (alterada fora do Cais, ou a proteção do cadastro foi recriada): ${p.days}.`,
  verified:
    'Cada linha é encadeada com uma chave do cofre do sistema: linha alterada ou apagada no meio aparece aqui. Sem dados de resultado; 90 dias.',
  unverified: 'Sem verificação de integridade: o cofre do sistema não está disponível. Sem dados de resultado; 90 dias.',
  empty: 'Nada na trilha com esses filtros.',
  loadMore: 'Carregar mais',
  production: 'Produção',
  /** Suffix of a state that the policy committed by itself. */
  automatic: 'automático',
  /** Suffix of a line brought in from an agents-only trail file (agent-audit.jsonl). */
  imported: 'importada, sem verificação',
  actor: {
    person: 'você',
    cais: 'Cais',
    agent: (p: { client: string }) => `agente: ${p.client}`,
  },
  /** Default client names the broker writes on trail lines (persisted as is): shown in the app locale. */
  client: {
    agente: 'agente',
    pessoa: 'pessoa',
  },
  /** Trail `mode` codes: the tab's mode for the person, the request kind for agents. */
  mode: {
    'read-only': 'Somente leitura',
    transaction: 'Transação',
    autocommit: 'Auto-commit',
    read: 'leitura',
    write: 'escrita',
    schema: 'schema',
    script: 'script',
    grant: 'liberação 15 min',
    config: 'configuração',
  },
  /** Trail `event` codes (person lines). */
  event: {
    commit: 'Commit',
    rollback: 'Rollback',
    mode: 'modo',
    connection_lost: 'conexão caiu',
    config: 'configuração',
  },
  /** Trail `state` codes. */
  state: {
    ok: 'ok',
    error: 'erro',
    refused: 'recusado',
    cancelled: 'cancelado',
    running: 'em andamento',
    succeeded: 'concluído',
    failed: 'falhou',
    committed: 'commit feito',
    rolled_back: 'rollback feito',
    rejected: 'recusado por você',
    expired: 'expirou',
    created: 'criado',
    revoked: 'revogada',
    detected: 'detectado',
    environment_changed: 'ambiente mudou',
    access_off: 'acesso desligado',
    shutdown: 'Cais fechado',
  },
  /** Who approved or refused an agent request (`decidedBy` codes). */
  decidedBy: {
    user: 'você',
    policy: 'nível do ambiente',
    timeout: 'o tempo',
    shutdown: 'o fechamento do Cais',
    environment: 'a mudança do ambiente',
    grant: 'liberação de 15 min (sem aprovação própria)',
  },
  /** Who committed or rolled back an agent write (`secondDecidedBy` codes). */
  secondDecidedBy: {
    user: 'você',
    policy: 'automático (nível do ambiente)',
    timeout: 'o tempo',
    shutdown: 'o fechamento do Cais',
  },
  /** `rollbackReason` codes. */
  rollbackReason: {
    timeout: 'tempo esgotado',
    user: 'você',
    shutdown: 'o Cais foi fechado',
    access_off: 'o acesso de agentes foi desligado',
    unexpected_commit: 'o servidor encerrou a transação',
  },
  counts: {
    rows: (p: { count: number }) => f.count(p.count, { one: 'linha', other: 'linhas' }),
    affected: (p: { count: number }) => f.count(p.count, { one: 'afetada', other: 'afetadas' }),
    duration: (p: { count: number }) => `${f.formatNumber(p.count)} ms`,
  },
  detail: {
    when: 'Quando',
    who: 'Quem',
    environment: 'Ambiente',
    productionSuffix: '(produção)',
    database: 'Banco',
    reason: 'Motivo',
    decidedBy: 'Decidido por',
    secondDecidedBy: 'Commit/Rollback',
    result: 'Resultado',
    resultWithheld: 'retido: o agente só recebeu contagens',
    error: 'Erro',
    rollbackBy: 'Rollback por',
    warning: 'Atenção',
    rollbackIncomplete: 'rollback incompleto (tabela não transacional)',
    detail: 'Detalhe',
    sql: 'SQL',
    sqlCut: (p: { count: number }) => `cortado: ${f.formatNumber(p.count)} caracteres no original`,
    statements: 'Comandos',
    statementAffected: (p: { count: number }) => `${f.formatNumber(p.count)} afetadas`,
    statementRows: (p: { count: number }) => `${f.formatNumber(p.count)} linhas`,
  },
  /** Written by main when listing (TrailPage.writeError), in the app locale. */
  writeError: (p: { at: string }) => `A trilha não pôde ser gravada em ${p.at}.`,
  writeErrorRecovered: (p: { at: string }) => `A trilha não pôde ser gravada em ${p.at} (voltou a gravar depois).`,
};
