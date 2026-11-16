/**
 * Area "mainMisc": main-process text with no better home: bootstrap, credentials, gcloud, the MySQL driver,
 * the JSON stores and the CLI installer. pt-BR (the reference catalog).
 * Driver and credential messages can reach agents: main keeps a MessageRef next to the message so the broker
 * renders them in AGENT_LOCALE.
 */
export const ptBR = {
  credentialNotFound: 'Credencial não encontrada.',
  sealRecreated:
    'A chave da proteção foi recriada (seal.json removido ou ilegível): a trilha anterior a este momento não pode mais ser verificada.',
  credentialNoPassword: (p: { name: string }) => `A credencial "${p.name}" não tem senha salva.`,
  /** Friendly rewrites of MySQL errors (the server's own text is kept as `detail` and never translated). */
  driver: {
    noResponse: (p: { host: string; port: number }) => `Sem resposta de ${p.host}:${p.port}. A VPN está ligada?`,
    iamRefused:
      'Login IAM recusado. Confira se o usuário IAM existe na instância e se a conta tem permissão de login no Cloud SQL.',
    passwordRefused: 'Usuário ou senha recusados.',
    readOnly: 'A sessão está em somente leitura.',
    cancelled: 'Query cancelada.',
    lost: 'Conexão perdida.',
    unknown: 'Erro desconhecido',
    autocommitTurnedOn:
      'O comando ligou o autocommit da sessão (por exemplo dentro de uma procedure): o que ele gravou já foi confirmado. O Cais voltou a sessão para Transação.',
    cancelFailed: (p: { message: string }) => `Não foi possível cancelar a query: ${p.message}`,
  },
  gcloud: {
    timeout: 'O gcloud demorou demais para responder.',
    notFound: 'gcloud não encontrado. Instale o Google Cloud SDK ou abra o Cais pelo terminal.',
    /** `detail` is the first line of gcloud's stderr (sanitized), possibly empty. */
    listFailed: (p: { detail: string }) => `Não foi possível listar as contas do gcloud. ${p.detail}`,
    listUnexpected: 'Resposta inesperada do gcloud ao listar as contas.',
    reauth: (p: { account: string }) => `A conta ${p.account} precisa entrar de novo: rode \`gcloud auth login ${p.account}\` no terminal.`,
    tokenFailed: (p: { account: string; detail: string }) => `O gcloud não gerou o token de login da conta ${p.account}. ${p.detail}`,
    noToken: (p: { account: string }) => `O gcloud não devolveu um token para a conta ${p.account}.`,
    accessTokenFailed: (p: { account: string; detail: string }) => `O gcloud não gerou o token de acesso da conta ${p.account}. ${p.detail}`,
  },
  /** The BigQuery driver (REST). Messages can reach agents: the driver keeps a MessageRef next to them. */
  bigquery: {
    noResponse: 'Sem resposta de bigquery.googleapis.com. A VPN está ligada? Confira também o proxy.',
    unexpectedResponse: 'O BigQuery respondeu em um formato que o Cais não reconhece.',
    modeNotSupported: 'O BigQuery só lê nesta versão: a sessão é sempre Somente leitura.',
    refusedType: (p: { type: string }) => `Somente leitura: o BigQuery leu este comando como ${p.type}, e não como consulta (SELECT).`,
    resultExpired: 'O resultado dessa consulta não está mais disponível. Rode a consulta de novo.',
    refusedUnknown: 'Somente leitura: o BigQuery não disse que tipo de comando é este.',
    datasetNotFound: (p: { name: string }) => `O dataset ${p.name} não existe neste projeto, ou a conta não o enxerga.`,
    datasetInvalid: 'Nome de dataset inválido: só letras, números e sublinhado.',
    hintJobUser: 'A conta precisa do papel roles/bigquery.jobUser no projeto.',
    hintDataViewer: 'Para ler as tabelas, a conta precisa de roles/bigquery.dataViewer nos datasets.',
    error: {
      accessDenied: 'O BigQuery negou o acesso. A conta precisa do papel roles/bigquery.jobUser no projeto e de roles/bigquery.dataViewer nos datasets que a consulta lê.',
      unauthenticated: 'O BigQuery não aceitou o token da conta. Rode `gcloud auth login` no terminal e tente de novo.',
      notFound: 'O BigQuery não encontrou o projeto, o dataset ou a tabela. Confira o nome e se a conta enxerga o recurso.',
      invalidQuery: (p: { detail: string }) => `O BigQuery recusou o comando: ${p.detail}`,
      bytesBilledLimitExceeded:
        'A consulta leria mais bytes do que o limite do ambiente permite. O BigQuery não a rodou e nada foi cobrado.',
      quotaExceeded: 'A cota do BigQuery acabou. Espere um pouco ou veja as cotas do projeto no Google Cloud.',
      rateLimitExceeded: 'O BigQuery limitou o ritmo das consultas. Espere um pouco e tente de novo.',
      responseTooLarge: 'O resultado é grande demais para o BigQuery devolver. Peça menos colunas ou menos linhas.',
      backendError: 'O BigQuery falhou do lado dele. Tente de novo em instantes.',
      stopped: 'O BigQuery interrompeu a consulta.',
      timeout: 'A consulta passou do tempo limite e o BigQuery a interrompeu.',
    },
  },
  store: {
    unreadable: (p: { name: string; aside: string }) =>
      `O arquivo ${p.name} estava ilegível e foi guardado em ${p.aside}. O Cais abriu sem esses dados.`,
    agentAccessTampered:
      'O acesso de agentes estava ligado sem ter sido ligado pelo Cais (settings.json alterado ou proteção recriada) e foi desligado. Ligue de novo no painel Agentes, se quiser.',
  },
  cliInstall: {
    targetMissing: 'O arquivo do comando não foi encontrado neste app. Rode a compilação e tente de novo.',
    notOurLink: (p: { path: string }) => `${p.path} já existe e não é um link do Cais.`,
    otherProgram: (p: { path: string }) => `${p.path} já aponta para outro programa.`,
    dirFailed: (p: { dir: string; reason: string }) => `${p.dir}: ${p.reason}`,
    noPermission: 'sem permissão',
    failed: (p: { failures: string }) => `Não foi possível instalar o comando cais. ${p.failures}`,
    alreadyInstalled: (p: { path: string }) => `O comando cais já estava instalado em ${p.path}.`,
    installed: (p: { path: string }) => `Comando cais instalado em ${p.path}.`,
    notOnPath: (p: { dir: string }) => `A pasta ${p.dir} não está no PATH do terminal: adicione-a para usar o comando.`,
  },
};
