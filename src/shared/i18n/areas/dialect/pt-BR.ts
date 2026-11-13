/** Area "dialect", pt-BR (the reference catalog: `en.ts` must follow its shape). */
export const ptBR = {
  literal: {
    invalid: (p: { type: string }) => `Valor inválido para ${p.type}.`,
    unsupported: (p: { type: string }) => `O tipo ${p.type} não pode ser escrito como valor.`,
    truncated: 'O valor binário está cortado: não dá para escrevê-lo de volta.',
    noKey: 'O UPDATE precisa de colunas para alterar e da chave inteira da linha.',
  },
  /** Run statement at the cursor with nothing under it. */
  noStatement: 'Nenhum comando sob o cursor.',
  /** Why the person's tab refuses a statement (classifier). SQL keywords stay as they are. */
  classify: {
    transactionMode: 'Use o modo da aba (Somente leitura, Transação ou Auto-commit) para controlar transação e autocommit.',
    /** Prefix of every read-only refusal: "Somente leitura: <what>". */
    readOnly: (p: { what: string }) => `Somente leitura: ${p.what}`,
    notListed: 'este comando não está na lista de comandos permitidos.',
    setOnly: 'apenas SET de variável de usuário (@variavel), SET NAMES utf8mb4 ou SET CHARACTER SET utf8mb4 sozinhos são permitidos.',
    changesData: (p: { verb: string }) => `${p.verb} não é permitido. Troque o modo da aba para alterar dados.`,
    changesStructure: (p: { verb: string }) => `${p.verb} não é permitido. Troque o modo da aba para alterar a estrutura.`,
    explainWrite: 'EXPLAIN de comando de escrita não roda em somente leitura. Use o modo Transação: o EXPLAIN não altera nada.',
    explainReadsOnly: 'EXPLAIN só é permitido para leituras.',
    explainAnalyzeReadsOnly: 'EXPLAIN ANALYZE só é permitido para leituras.',
    useTransactionMode: 'use o modo Transação da aba para abrir uma transação.',
    release: (p: { verb: string }) => `${p.verb} RELEASE encerra a conexão e não é permitido.`,
    chain: (p: { verb: string }) => `${p.verb} AND CHAIN abre outra transação. Use o modo Transação da aba.`,
    nonAsciiFunction: (p: { name: string }) => `nome de função com letra fora do ASCII (${p.name}): o servidor pode achar outra função.`,
    serverStateFunction: (p: { name: string }) => `a função ${p.name} altera o estado do servidor.`,
    /** `versioned` and `mariadb` are the SQL syntax (`/*!NNNNN … *\/`, `/*M! … *\/`), never translated. */
    versionedComment: (p: { versioned: string; mariadb: string }) =>
      `comentário executável com versão (${p.versioned} ou ${p.mariadb}) pode esconder outro comando do que aparece. Tire o comentário.`,
    executableComment: (p: { syntax: string }) => `comentário executável (${p.syntax}) não é permitido.`,
    /** Reads that are always refused (lexer danger scan), after "Somente leitura: ". */
    intoOutfile: 'SELECT ... INTO OUTFILE não é permitido.',
    intoDumpfile: 'SELECT ... INTO DUMPFILE não é permitido.',
    lockingRead: (p: { clause: string }) => `leituras com lock (${p.clause}) não são permitidas.`,
  },
  /** Alerts in the agent approval modal (person only). */
  warning: {
    noWhere: (p: { verb: string }) => `${p.verb} sem WHERE`,
    alwaysTrue: (p: { verb: string }) => `${p.verb} com WHERE sempre verdadeiro`,
    executableComment: (p: { syntax: string }) => `Comentário executável (${p.syntax}): o servidor pode rodar outra coisa`,
  },
  /** Why SQL from an agent may read differently to a person than to the server. Agents get it in pt-BR. */
  agentCode: {
    nestedComment:
      'Comentário com /* dentro: o MySQL termina o comentário no primeiro */ e a revisão pode mostrar outra coisa. Tire o /* de dentro.',
    dashComment: 'Comentário "--" sem espaço logo depois: use "-- " (traço, traço, espaço).',
    quotedVariable: 'Nome de variável entre aspas ou crases: use @nome, só com letras ASCII, dígitos e _.',
    nonAsciiFunction: (p: { name: string }) =>
      `Nome de função com caractere fora do ASCII (${p.name}): o MySQL acha funções ignorando acentos.`,
    nonAsciiCode: (p: { marker: string; char: string }) =>
      `Caractere fora do ASCII no código (${p.marker} "${p.char}"), fora de string e de nome entre crases: o MySQL o lê como parte de um nome. Escreva o nome entre crases ou o valor entre aspas.`,
  },
  /** GoogleSQL (BigQuery) dialect: read-only refusals shown to the person (after "Somente leitura: ") and agent code problems. */
  bigquery: {
    classify: {
      changesData: (p: { verb: string }) => `${p.verb} não é permitido: o BigQuery só lê nesta versão.`,
      changesStructure: (p: { verb: string }) => `${p.verb} não é permitido: o BigQuery só lê nesta versão.`,
      transaction: 'o BigQuery roda só consultas: não há transação nesta versão.',
      script: 'scripts e blocos (DECLARE, SET, BEGIN ... END, IF, LOOP, WHILE, FOR...) não são permitidos. Rode uma consulta por vez.',
      other: (p: { verb: string }) => `${p.verb} não é uma consulta. Só SELECT, WITH e FROM (sintaxe pipe) são permitidos.`,
      empty: 'não há comando para rodar.',
      multiple: 'mais de um comando no mesmo texto não é permitido. Rode um por vez.',
      mixed: (p: { verb: string }) => `a consulta mistura outro comando (${p.verb}). Rode um por vez.`,
      legacyDirective: 'a diretiva #legacySQL ou #standardSQL não é permitida.',
      externalQuery: 'EXTERNAL_QUERY não é permitido: ele roda uma consulta em outro banco.',
      unreadable:
        'o texto tem string, nome entre crases ou comentário sem fim, ou algo que o servidor pode ler de outro jeito (barra invertida em string crua ou entre crases).',
    },
    agentCode: {
      nestedComment:
        'Comentário com /* dentro: o GoogleSQL termina o comentário no primeiro */ e a revisão pode mostrar outra coisa. Tire o /* de dentro.',
      carriageReturn: 'Comentário de linha com retorno de carro (CR) dentro: o servidor e a revisão podem achar o fim da linha em lugares diferentes. Use só quebra de linha.',
      quotedVariable: 'Nome de parâmetro entre aspas ou crases: use @nome, só com letras ASCII, dígitos e _.',
      nonAsciiFunction: (p: { name: string }) => `Nome de função com caractere fora do ASCII (${p.name}).`,
      nonAsciiCode: (p: { marker: string; char: string }) =>
        `Caractere fora do ASCII no código (${p.marker} "${p.char}"), fora de string, de nome entre crases e de comentário. Escreva o nome entre crases ou o valor entre aspas.`,
      tripleQuote: 'String de três aspas (\'\'\'...\'\'\' ou """...""") não é permitida: a revisão não a lê como o servidor. Use uma string de aspas simples ou duplas.',
      legacyDirective: 'A diretiva #legacySQL ou #standardSQL não é permitida.',
      rawBackslash: 'String crua (r\'...\') com barra invertida: o servidor e a revisão podem achar o fim da string em lugares diferentes. Use uma string normal, dobrando as barras.',
      backslashIdent: 'Nome entre crases com barra invertida: o servidor e a revisão podem achar o fim do nome em lugares diferentes. Tire a barra.',
      dashComment: 'Comentário -- colado no texto seguinte: sem espaço depois dos dois traços, a revisão pode lê-lo como código. Ponha um espaço depois de --.',
      bytesPrefix: 'String de bytes (b\'...\'): a revisão pode lê-la como número binário e perder o fim da string. Use uma string normal ou FROM_BASE64.',
      hexPrefix: 'Letra x colada numa string (x\'...\'): a revisão a lê como número hexa. Separe com espaço ou use outro nome.',
    },
  },
};
