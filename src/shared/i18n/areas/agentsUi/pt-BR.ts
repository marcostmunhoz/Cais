import { createFormat } from '../../core';

const f = createFormat('pt-BR');

/**
 * Area "agentsUi", pt-BR (the reference catalog: `en.ts` must follow its shape). The agents' panel and modals,
 * and the broker's text that the person reads. Entries under `approval`, `commitStop`, `rejection` and `error`
 * are also sent to agents, always rendered in AGENT_LOCALE (pt-BR), so their pt-BR text is part of the CLI's
 * output: change it only on purpose.
 */
export const ptBR = {
  /** Text built elsewhere, carried as is in a MessageRef (an already redacted driver message, for instance). */
  verbatim: (p: { text: string }) => p.text,

  status: {
    pending_approval: 'Aguardando aprovação',
    rejected: 'Recusado',
    expired: 'Expirou',
    running: 'Rodando',
    succeeded: 'Concluído',
    failed: 'Falhou',
    awaiting_commit: 'Aguardando commit',
    committed: 'Commit feito',
    rolled_back: 'Rollback feito',
  },
  decidedBy: {
    user: 'você',
    policy: 'nível do ambiente (sem aprovação)',
    timeout: 'o tempo',
    shutdown: 'o fechamento do Cais',
    environment: 'a mudança do ambiente',
    grant: 'liberação de 15 min (sem aprovação própria)',
  },
  secondDecidedBy: {
    user: 'você',
    policy: 'automático (nível do ambiente)',
    timeout: 'o tempo',
    shutdown: 'o fechamento do Cais',
  },
  rollbackReason: {
    timeout: 'tempo esgotado',
    user: 'você',
    shutdown: 'o Cais foi fechado',
    access_off: 'o acesso de agentes foi desligado',
    unexpected_commit: 'o servidor encerrou a transação',
  },
  kind: {
    read: 'leitura',
    write: 'escrita',
    other: 'outro',
  },

  /** Approval modal and the request details shared with the commit modal. */
  modal: {
    statements: 'Comandos do pedido',
    statement: (p: { n: number }) => `Comando ${p.n}`,
    environment: 'Ambiente',
    database: (p: { database: string }) => ` · banco ${p.database}`,
    dataset: (p: { database: string }) => ` · dataset ${p.database}`,
    client: 'Cliente',
    clientNote: '(informado pelo cliente)',
    reason: 'Motivo',
    titleWrite: 'Agente pede para escrever',
    titleRead: 'Agente pede para ler',
    queued: (p: { count: number }) => `mais ${p.count} na fila`,
    production: 'Produção',
    statementOne: 'comando',
    statementMany: 'comandos',
    estimate: (p: { bytes: number }) => `${f.formatBytes(p.bytes)} estimados`,
    billed: (p: { bytes: number }) => `${f.formatBytes(p.bytes)} faturados`,
    scrollToEnd: ' · role a lista até o fim para liberar o botão',
    writeNote:
      'Roda em transação. Depois você vê as linhas afetadas e decide Commit ou Rollback. Se algum comando gravar fora da transação, o pedido para e você fica sabendo.',
    grantNeedsShare: 'Só com "O agente pode ver o resultado" marcado',
    grantReads: (p: { environment: string }) => `Aprovar leituras em ${p.environment} por 15 min`,
    grantOnlyShared: ' (só se o agente puder ver o resultado)',
    share: 'O agente pode ver o resultado',
    rejectReason: 'Motivo da recusa (opcional)',
    reject: 'Recusar',
    runInTransaction: 'Rodar em transação',
    approve: 'Aprovar',
  },

  /** Second decision of an agent write. */
  commitModal: {
    title: 'Transação do agente aberta',
    rollbackIn: (p: { time: string }) => `rollback em ${p.time}`,
    autoCommitStopped: (p: { reason: string }) => `O commit automático não aconteceu: ${p.reason}`,
    error: 'erro',
    affectedOne: 'linha afetada',
    affectedMany: 'linhas afetadas',
    rowOne: 'linha',
    rowMany: 'linhas',
    noRows: 'sem linhas',
    note: 'Commit grava para todos. Rollback desfaz tudo. Sem decisão, o Cais faz rollback sozinho.',
    rollback: 'Rollback',
    commit: 'Commit',
  },

  /** A recent request, opened in the panel. */
  detail: {
    automatic: ' (automático)',
    decidedBy: 'Decidido por',
    at: (p: { time: string }) => ` às ${p.time}`,
    commitBy: 'Commit por',
    secondDecision: 'Segunda decisão',
    result: 'Resultado',
    withheld: 'retido: o agente só recebeu contagens',
    rejection: 'Recusa',
    attention: 'Atenção',
    rollbackIncomplete: 'Rollback incompleto: o servidor avisou que tabelas não transacionais ficaram com o que foi gravado.',
    rollbackBy: 'Rollback por',
    error: 'Erro',
    sql: 'SQL do pedido',
  },

  panel: {
    title: 'Agentes',
    close: 'Fechar',
    access: 'Acesso de agentes',
    phrase:
      'O que um agente roda sem pedir depende do ambiente (Acesso de agentes, no cadastro). Escrita em produção sempre pede a sua aprovação. Tudo fica na trilha.',
    pending: 'Pendentes',
    noPending: 'Nenhum pedido esperando você.',
    expiresIn: (p: { time: string }) => `expira em ${p.time}`,
    review: 'Revisar',
    grants: 'Liberações ativas',
    noGrants: 'Nenhuma leitura liberada por 15 minutos.',
    grantReads: (p: { environment: string }) => `Leituras em ${p.environment}`,
    remaining: (p: { time: string }) => `${p.time} restantes`,
    revoke: 'Revogar',
    byEnvironment: 'Por ambiente',
    noEnvironments: 'Nenhum ambiente cadastrado.',
    recent: 'Pedidos recentes',
    noRecent: 'Nenhum pedido ainda.',
  },

  /** Why a request the environment's level would let run waits for the person (also `approval_reason` to the agent). */
  approval: {
    alert: 'Este ambiente libera escrita, mas o pedido tem alerta: ele espera a sua aprovação.',
    openWrite: 'Já há uma escrita de agente aberta neste ambiente: esta espera a sua aprovação.',
    trailDown: 'A trilha não pôde ser gravada: nada roda sem a sua aprovação enquanto isso.',
    noMetadata: 'Este ambiente libera escrita, mas não foi possível ler os metadados do banco: o pedido espera a sua aprovação.',
    partialMetadata:
      'Este ambiente libera escrita, mas parte dos metadados do banco (triggers, views, rotinas ou chaves estrangeiras) não pôde ser lida: o pedido espera a sua aprovação.',
    foreignKeysHidden:
      'Este ambiente libera escrita, mas o usuário do banco não enxerga todas as chaves estrangeiras que podem apagar ou mudar linhas em cascata (precisa do privilégio PROCESS ou de privilégio global): o pedido espera a sua aprovação.',
    otherVerb: (p: { verb: string }) =>
      `Este ambiente libera escrita, mas só INSERT, REPLACE, UPDATE e DELETE fazem commit sozinhos (há ${p.verb}): o pedido espera a sua aprovação.`,
    otherStatement:
      'Este ambiente libera escrita, mas só INSERT, REPLACE, UPDATE e DELETE fazem commit sozinhos (há outro comando): o pedido espera a sua aprovação.',
    dbFunction: (p: { name: string }) =>
      `Este ambiente libera escrita, mas o comando chama a função ${p.name} do banco, que pode gravar o que quiser: o pedido espera a sua aprovação.`,
    view: (p: { name: string }) => `Este ambiente libera escrita, mas o comando usa a view ${p.name}: o pedido espera a sua aprovação.`,
    trigger: (p: { table: string }) =>
      `Este ambiente libera escrita, mas a tabela ${p.table} tem trigger, e o que ele grava não entra na contagem de linhas: o pedido espera a sua aprovação.`,
    cascade: (p: { table: string; tables: string }) =>
      `Este ambiente libera escrita, mas a tabela ${p.table} tem chave estrangeira em cascata (${p.tables}), e essas linhas não entram na contagem: o pedido espera a sua aprovação.`,
    bigRead: (p: { bytes: number; threshold: number }) =>
      `Esta leitura deve ler ${f.formatBytes(p.bytes)}, acima de ${f.formatBytes(p.threshold)}: ela espera a sua aprovação, qualquer que seja o nível do ambiente.`,
    overLimit: (p: { bytes: number; limit: number }) =>
      `Esta leitura deve ler ${f.formatBytes(p.bytes)}, acima do limite de ${f.formatBytes(p.limit)} do ambiente: ela espera a sua aprovação, qualquer que seja o nível do ambiente.`,
    remoteFunction: (p: { name: string }) =>
      `O comando usa a função ${p.name}, definida no projeto (direto ou por uma view): ela pode ser uma função remota, que roda código fora do BigQuery. O pedido espera a sua aprovação.`,
    generativeAi: (p: { name: string }) =>
      `O comando chama ${p.name}, de IA generativa ou de modelo: o custo não aparece nos bytes lidos. O pedido espera a sua aprovação.`,
    unknownFunction: (p: { name: string }) =>
      `O comando chama a função ${p.name}, que não é nativa do BigQuery e pode ser uma rotina do projeto (até uma função remota). O pedido espera a sua aprovação.`,
    triggersHidden: (p: { database: string }) =>
      `Este ambiente libera escrita, mas o usuário do banco não enxerga os triggers de ${p.database} (falta o privilégio TRIGGER): o pedido espera a sua aprovação.`,
  },

  /** Why an autonomous write did not commit by itself (also `commit_reason` to the agent). */
  commitStop: {
    levelChanged: 'O acesso de agentes do ambiente mudou enquanto o pedido rodava. Confira e decida.',
    windowRows: (p: { limit: number; count: number }) =>
      `Com esta escrita, os commits automáticos neste ambiente passam de ${f.formatNumber(p.limit)} linhas em 15 minutos (${f.formatNumber(p.count)} até agora). Confira e decida.`,
    tooManyRows: (p: { count: number; limit: number }) =>
      `Afetou ${f.formatNumber(p.count)} linhas; o commit automático vai até ${f.formatNumber(p.limit)}. Confira e decida.`,
    serverWarnings: (p: { count: number }) =>
      `O servidor deu ${p.count === 1 ? '1 aviso' : `${p.count} avisos`} na escrita (valor cortado ou convertido, por exemplo). Confira e decida.`,
  },

  rejection: {
    environmentChanged: 'O ambiente mudou.',
  },

  /** Errors the person can see (modal, panel, toasts); the agent gets them in pt-BR. */
  error: {
    accessOff: 'O acesso de agentes está desligado.',
    grantReadsOnly: 'A liberação por 15 minutos só vale para leitura.',
    grantNeedsShare: 'A liberação por 15 minutos exige que o agente possa ver o resultado.',
    trailPending: 'A trilha não pôde ser gravada: o pedido não rodou e continua pendente.',
    resolving: 'O pedido já está sendo resolvido.',
    notFound: 'Pedido não encontrado.',
    wrongState: 'O pedido não está mais nesse estado.',
    commitFailed: 'O commit falhou e o servidor desfez a transação.',
    unexpected: 'Erro inesperado ao executar o pedido.',
    timeout: 'Tempo limite para agentes esgotado.',
    bytesOverApproved: (p: { bytes: number; ceiling: number }) =>
      `A estimativa desta leitura passou de ${f.formatBytes(p.ceiling)}, o teto aprovado (agora ${f.formatBytes(p.bytes)}): ela não rodou. Peça de novo para a pessoa ver a nova estimativa.`,
    routineNotApproved: (p: { name: string }) => `Esta leitura alcança a rotina ${p.name}, que ninguém aprovou: ela não rodou. Peça de novo para a pessoa ver.`,
    accessClosed: 'O acesso de agentes foi desligado ou o ambiente mudou.',
    unexpectedCommit: 'O servidor encerrou a transação durante o pedido.',
    nonTransactionalWrite: 'O comando gravou fora da transação (tabela não transacional ou do sistema): o Rollback não desfaz.',
    commitUnknown: 'Não foi possível confirmar o commit: a conexão caiu depois do envio. Confira no banco antes de repetir.',
    connectFailed: 'Não foi possível conectar ao ambiente.',
    connectFailedDetail: (p: { detail: string }) => `Não foi possível conectar ao ambiente. ${p.detail}`,
    loginRefused: 'Login recusado pelo servidor.',
    credentialUnavailable: 'Não foi possível obter a credencial do ambiente. Peça para a pessoa conferir o cadastro no Cais.',
    socketPathTaken: 'Já existe um arquivo no caminho do socket de agentes.',
    socketInUse: 'Outro Cais já está com o acesso de agentes ligado.',
    socketFailed: (p: { code: string }) => `Não foi possível abrir o socket de agentes: ${p.code}.`,
    unknownError: 'erro desconhecido',
  },

  /** What replaces the server address and the database login in error text. */
  redact: {
    server: '<servidor>',
    user: '<usuário>',
    project: '<projeto>',
    account: '<conta>',
  },

  /** Alerts before a write: what the Rollback may not undo (person only). */
  nonTransactional: {
    cannotCheck: 'Não foi possível verificar se as tabelas são transacionais: o Rollback pode não desfazer tudo.',
    originTrigger: (p: { table: string }) => `Um trigger da tabela ${p.table}`,
    originRoutine: (p: { name: string }) => `A rotina ${p.name}`,
    writesTo: (p: { origin: string; table: string; engine: string }) =>
      `${p.origin} grava em ${p.table}, que não é transacional (${p.engine}): o Rollback não desfaz isso.`,
    routineUnreadFrom: (p: { name: string; origin: string }) =>
      `Não foi possível ler a rotina ${p.name} (chamada por ${p.origin}): o Rollback pode não desfazer o que ela gravar.`,
    routineUnread: (p: { name: string }) => `Não foi possível ler a rotina ${p.name}: o Rollback pode não desfazer o que ela gravar.`,
    table: (p: { table: string; engine: string }) =>
      `A tabela ${p.table} não é transacional (${p.engine}): o Rollback não desfaz o que for gravado nela.`,
    view: (p: { view: string; table: string }) =>
      `A view ${p.view} usa a tabela não transacional ${p.table}: o Rollback não desfaz o que for gravado por ela.`,
    viewTables: (p: { view: string }) => `Não foi possível ver as tabelas da view ${p.view}: o Rollback pode não desfazer tudo.`,
    triggersUnchecked: (p: { tables: string }) =>
      `Não foi possível conferir os triggers de ${p.tables} (falta o privilégio TRIGGER) e há tabelas não transacionais: o Rollback pode não desfazer tudo.`,
  },
};
