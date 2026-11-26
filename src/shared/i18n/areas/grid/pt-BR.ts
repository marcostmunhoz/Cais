import { createFormat } from '../../core';

const f = createFormat('pt-BR');

/** "2 UPDATEs e 1 DELETE": the statements Aplicar ran, by verb. */
const commands = (p: { updates: number; deletes: number }): string =>
  [
    p.updates > 0 ? f.count(p.updates, { one: 'UPDATE', other: 'UPDATEs' }) : '',
    p.deletes > 0 ? f.count(p.deletes, { one: 'DELETE', other: 'DELETEs' }) : '',
  ]
    .filter(Boolean)
    .join(' e ');

/** Area "grid", pt-BR (the reference catalog: `en.ts` must follow its shape). */
export const ptBR = {
  reason: {
    engineNoEdit: (p: { engine: string }) => `Nesta versão o ${p.engine} é só leitura.`,
    notRead: 'Edição na grade só para o resultado de um SELECT.',
    noTable: 'Edição na grade só para resultado de uma tabela: as colunas deste resultado não vêm de uma tabela.',
    severalTables: (p: { tables: string }) => `Edição na grade só para resultado de uma tabela (este vem de ${p.tables}).`,
    schemaLoading: 'Carregando o schema do ambiente para achar a chave primária. Tente de novo em instantes.',
    schemaFailed: (p: { message: string }) => `O schema do ambiente não pôde ser lido: ${p.message}`,
    unknownTable: (p: { table: string }) => `A tabela ${p.table} não está no schema carregado. Atualize a árvore do ambiente.`,
    view: (p: { table: string }) => `${p.table} é uma view: edição na grade só em tabela.`,
    noPrimaryKey: (p: { table: string }) => `A tabela ${p.table} não tem chave primária: a edição na grade precisa dela.`,
    missingKey: (p: { columns: string }) =>
      `Edição na grade só para resultado de uma tabela com a chave primária inteira (falta: ${p.columns}).`,
    staleSchema: 'A chave primária mudou desde que o schema foi carregado. Atualize a árvore do ambiente.',
    floatKey: (p: { column: string }) => `A chave ${p.column} é FLOAT ou DOUBLE: a comparação não é exata.`,
    zonedKey: (p: { column: string }) => `A chave ${p.column} é TIMESTAMP: o valor depende do fuso horário da sessão.`,
    nullKey: (p: { column: string }) => `Há linha com a chave ${p.column} em NULL: não dá para identificar a linha.`,
    truncatedKey: (p: { column: string }) => `A chave ${p.column} tem valor binário cortado na grade.`,
    duplicateKey: 'A chave primária se repete no resultado: não dá para saber qual linha editar.',
    expression: (p: { column: string }) => `${p.column} é uma expressão, não uma coluna da tabela.`,
    unknownColumn: (p: { column: string }) => `${p.column} não está no schema carregado. Atualize a árvore do ambiente.`,
    duplicateColumn: (p: { column: string }) => `${p.column} aparece mais de uma vez no resultado: edite a primeira.`,
    generated: (p: { column: string }) => `${p.column} é uma coluna gerada: o servidor calcula o valor.`,
    unsupportedType: (p: { column: string; type: string }) => `${p.column} é do tipo ${p.type}, que não é editável na grade.`,
    staleColumn: (p: { column: string }) => `O tipo de ${p.column} mudou desde que o schema foi carregado. Atualize a árvore do ambiente.`,
    truncatedValue: 'O valor binário está cortado na grade: não dá para editá-lo.',
    deleted: 'A linha está marcada para exclusão. Desfaça a exclusão para editá-la.',
  },
  invalid: {
    integer: (p: { column: string }) => `Valor inválido para ${p.column}: use um número inteiro.`,
    number: (p: { column: string }) => `Valor inválido para ${p.column}: use um número com ponto decimal.`,
    hex: (p: { column: string }) => `Valor inválido para ${p.column}: digite os bytes em hexadecimal.`,
  },
  bar: {
    summary: (p: { changes: number; rows: number; deletions: number }) =>
      [
        !(p.deletions > 0 && p.changes === 0) ? `${f.count(p.changes, { one: 'alteração', other: 'alterações' })} em ${f.count(p.rows, { one: 'linha', other: 'linhas' })}` : '',
        p.deletions > 0 ? f.count(p.deletions, { one: 'exclusão', other: 'exclusões' }) : '',
      ]
        .filter(Boolean)
        .join(' · '),
    generate: 'Gerar SQL',
    generateTitle: 'Põe os UPDATEs e DELETEs no fim do editor, sem rodar',
    apply: 'Aplicar',
    applyTitle: 'Roda os UPDATEs e DELETEs nesta aba',
    applyReadOnly: 'Troque para Transação ou Auto-commit',
    discard: 'Descartar',
  },
  menu: {
    edit: 'Editar célula',
    setNull: 'Definir como NULL',
    undo: 'Desfazer edição',
    generateCell: 'Gerar UPDATE da célula',
    generateCells: (p: { count: number }) => `Gerar UPDATE de ${p.count} células`,
    generateTooMany: (p: { max: number }) => `Gerar UPDATE da célula aceita até ${p.max} células por vez. Selecione menos linhas.`,
    deleteRow: 'Excluir linha',
    deleteRows: (p: { count: number }) => `Excluir ${p.count} linhas`,
    undoDelete: 'Desfazer exclusão',
    insert: 'Gerar INSERT',
    insertNoKey: 'Gerar INSERT sem chave primária',
  },
  insert: {
    stale: 'O resultado mudou sob a seleção. Selecione as linhas de novo.',
    noColumns: 'Nenhuma coluna deste resultado pode ir num INSERT: são expressões, colunas geradas ou de tipo sem suporte.',
    truncated: (p: { column: string; row: number }) =>
      `O valor binário de ${p.column} na linha ${p.row} está cortado na grade: não dá para gerar o INSERT.`,
    omitted: (p: { columns: string }) => `Fora do INSERT: ${p.columns} (coluna gerada, repetida, expressão ou de tipo sem suporte).`,
    tooMany: (p: { max: number }) => `Gerar INSERT aceita até ${p.max} linhas por vez. Selecione menos linhas.`,
  },
  reach: {
    cascade: (p: { table: string; tables: string }) =>
      `A tabela ${p.table} tem chaves estrangeiras em cascata (ON DELETE ou ON UPDATE): excluir pode apagar ou alterar linhas de ${p.tables}.`,
    trigger: (p: { table: string }) => `A tabela ${p.table} tem trigger: se algum for de exclusão, o que ele grava não entra na contagem de linhas.`,
    unknown: 'Parte dos metadados do banco (triggers ou chaves estrangeiras) não pôde ser lida: a exclusão pode alcançar outras tabelas.',
  },
  cell: {
    editorLabel: (p: { column: string }) => `Novo valor de ${p.column}`,
    original: (p: { value: string }) => `Alterada. Valor original: ${p.value}`,
  },
  confirmApply: {
    title: 'Aplicar em Auto-commit em produção',
    body: (p: { environment: string }) =>
      `Cada comando é confirmado na hora, sem Rollback. Este ambiente (${p.environment}) é de produção.`,
    confirm: 'Aplicar',
  },
  confirmDelete: {
    title: 'Excluir linhas em Auto-commit',
    body: (p: { rows: number }) =>
      `Cada comando é confirmado na hora, sem Rollback. ${p.rows === 1 ? 'A linha marcada será excluída' : `As ${f.formatNumber(p.rows)} linhas marcadas serão excluídas`} do banco.`,
    rows: (p: { rows: number }) => `${p.rows === 1 ? 'A linha marcada será excluída' : `As ${f.formatNumber(p.rows)} linhas marcadas serão excluídas`} do banco.`,
    confirm: 'Excluir',
  },
  confirmDiscard: {
    title: 'Descartar as edições da grade',
    body: (p: { changes: number }) =>
      `${f.count(p.changes, { one: 'alteração pendente', other: 'alterações pendentes' })} na grade ainda não ${p.changes === 1 ? 'foi aplicada' : 'foram aplicadas'} nem ${p.changes === 1 ? 'foi para' : 'foram para'} o editor.`,
    confirm: 'Descartar',
  },
  notice: {
    close: 'Fechar',
    applied: (p: { updates: number; deletes: number }) => `Edição aplicada: ${commands(p)}.`,
    appliedInTransaction: (p: { updates: number; deletes: number }) => `Rodaram na transação: ${commands(p)}. Faça Commit para gravar.`,
    notOne: (p: { verb: string; statement: number; rows: number }) =>
      `O ${p.verb} ${f.formatNumber(p.statement)} ${p.rows === 0 ? 'não encontrou a linha' : `encontrou ${f.count(p.rows, { one: 'linha', other: 'linhas' })}`} (esperado: 1).`,
    failed: (p: { verb: string; statement: number; message: string }) => `O ${p.verb} ${f.formatNumber(p.statement)} falhou: ${p.message}`,
    transaction: 'A transação continua aberta: confira e faça Rollback se algo não está certo.',
    autocommitSaved: (p: { count: number }) =>
      p.count === 0
        ? 'Em Auto-commit: nenhum comando foi gravado antes do erro.'
        : `Em Auto-commit, ${p.count === 1 ? 'o comando anterior ao erro já está gravado' : `os ${f.formatNumber(p.count)} comandos anteriores ao erro já estão gravados`}.`,
    refreshFailed: (p: { message: string }) => `A consulta não pôde ser rodada de novo: ${p.message}`,
    otherTable: 'ela leu outra tabela (o banco da sessão mudou). O resultado anterior foi mantido.',
  },
};
