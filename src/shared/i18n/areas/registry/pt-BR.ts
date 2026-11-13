import { createFormat } from '../../core';

const f = createFormat('pt-BR');

/** Area "registry", pt-BR (the reference catalog: `en.ts` must follow its shape). */
export const ptBR = {
  duplicate: 'Duplicar',
  duplicateTitle: 'Abre um ambiente novo com estes dados',
  duplicateOf: (p: { source: string }) => `Cópia de ${p.source}. Confira e salve para criar o ambiente novo.`,
  duplicateSourceBlocked:
    'O ambiente de origem está bloqueado (foi alterado fora do Cais, ou ainda não foi conferido). Confira host, porta, credencial, a marcação de produção e o acesso de agentes antes de salvar a cópia.',
  renameProject: (p: { name: string }) => `Renomear o projeto ${p.name}`,
  renameProjectTitle: 'Renomear projeto',
  dialogTitle: 'Cadastro',
  close: 'Fechar',
  sections: {
    environments: 'Ambientes',
    credentials: 'Credenciais',
  },
  newEnvironment: 'Novo ambiente',
  newCredential: 'Nova credencial',
  pickEnvironment: 'Escolha um ambiente ou crie um novo.',
  pickCredential: 'Escolha uma credencial ou crie uma nova.',
  /** Side notes of the list rows. */
  row: {
    blocked: 'bloqueado',
    freeWrites: 'escrita livre',
    freeReads: 'leitura livre',
    password: 'senha',
    iam: 'IAM',
  },
  save: 'Salvar',
  saved: 'Salvo',
  delete: 'Apagar',
  confirmDelete: 'Confirmar exclusão',
  cancel: 'Cancelar',
  credential: {
    name: 'Nome',
    namePlaceholder: 'ex.: root dev',
    kind: 'Tipo',
    kindLabel: 'Tipo de credencial',
    password: 'Usuário e senha',
    iam: 'Google IAM via gcloud',
    username: 'Usuário',
    secret: 'Senha',
    secretKeep: 'deixe vazio para manter',
    secretHint: 'A senha fica cifrada no cofre do sistema e nunca volta para esta tela.',
    account: 'Conta do gcloud',
    accountPlaceholder: 'nome@empresa.com',
    impersonate: 'Impersonar service account (opcional)',
    impersonatePlaceholder: 'sa@projeto.iam.gserviceaccount.com',
    dbUser: 'Usuário no banco',
    dbUserHint: 'Preenchido a partir da conta. Pode editar.',
    iamOnly: 'Para o BigQuery: a conta do gcloud que roda as consultas.',
    usedBy: (p: { count: number }) => `Usada em ${f.count(p.count, { one: 'ambiente', other: 'ambientes' })}`,
  },
  environment: {
    gcpProjectPlaceholder: 'meu-projeto-123',
    project: 'Projeto',
    newProject: 'Novo projeto…',
    newProjectLabel: 'Nome do novo projeto',
    newProjectPlaceholder: 'Nome do projeto',
    name: 'Nome do ambiente',
    namePlaceholder: 'dev, hml, pro…',
    host: 'Host',
    port: 'Porta',
    database: { database: 'Banco padrão (opcional)', dataset: 'Dataset padrão (opcional)' },
    engine: 'Motor',
    engineLabel: 'Motor do ambiente',
    gcpProject: 'Projeto do Google Cloud',
    gcpProjectHint: 'O projeto onde as consultas rodam e são cobradas.',
    invalidProject: 'Informe o id do projeto do Google Cloud (letras minúsculas, números e hífens).',
    maxGib: 'Limite de bytes por consulta (GiB)',
    maxGibHint: 'Acima do limite o Cais pergunta antes de rodar. Vazio: sem limite.',
    invalidMaxGib: 'Informe um número inteiro de GiB a partir de 1, ou deixe vazio para não ter limite.',
    iamHint: 'O BigQuery usa o login do gcloud: só credenciais Google IAM servem.',
    noIamCredential: 'Nenhuma credencial Google IAM ainda. Crie uma em "Nova credencial…".',
    bigqueryProductionHint: 'Marca o ambiente como produção: a aba e a trilha mostram o aviso.',
    credential: 'Credencial',
    noCredential: '(nenhuma credencial)',
    newCredential: 'Nova credencial…',
    production: 'Produção',
    productionHint: 'Abre em somente leitura e pede confirmação para usar auto-commit.',
    agents: 'Acesso de agentes',
    testMissing: 'Preencha host, porta e credencial para testar.',
    testMissingBigquery: 'Preencha o projeto e a credencial para testar.',
    connectedBigquery: 'Conectado ao BigQuery',
    connected: (p: { version: string }) => `Conectado · versão ${p.version}`,
    invalidPort: 'Informe uma porta válida (1 a 65535).',
    testing: 'Testando…',
    test: 'Testar conexão',
    blocked:
      'Este ambiente está bloqueado (foi alterado fora do Cais, ou ainda não foi conferido desde que a proteção do cadastro foi criada): nada conecta nele, nem você nem agentes. Confira host, porta, credencial, a marcação de produção e o acesso de agentes, e salve para liberar.',
  },
  /** Hint under the agent level. */
  levelHint: {
    locked:
      'O cofre do sistema não está disponível: sem ele o Cais não protege o cadastro, e agentes ficam em "Tudo com aprovação".',
    productionFreeReads:
      'Leitura de agente roda direto, inclusive dados de produção. Escrita em produção sempre pede a sua aprovação e depois o seu Commit.',
    productionApproveAll:
      'Cada leitura e cada escrita de agente pede a sua aprovação. Leituras podem ser liberadas por 15 minutos no próprio pedido. Em produção, escrita sempre pede aprovação.',
    'approve-all': 'Cada leitura e cada escrita de agente pede a sua aprovação no Cais.',
    'free-reads': 'Leitura de agente roda direto. Escrita pede a sua aprovação e depois o seu Commit.',
    /** Agent levels on a read-only engine (BigQuery). */
    bigquery: {
      'approve-all': 'Cada consulta de agente pede a sua aprovação no Cais.',
      'free-reads': 'Consulta de agente roda direto.',
    },
    'free-reads-writes': (p: { count: number }) =>
      `Leitura e escrita de agente rodam direto. A escrita roda em transação e faz commit sozinha quando não há alerta e afeta até ${f.formatNumber(p.count)} linhas; fora disso, espera você. Tudo fica na trilha.`,
  },
};
