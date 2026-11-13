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
};
