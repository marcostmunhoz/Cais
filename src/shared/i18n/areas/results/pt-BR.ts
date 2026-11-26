import { createFormat } from '../../core';

const f = createFormat('pt-BR');

/** Area "results", pt-BR (the reference catalog: `en.ts` must follow its shape). */
export const ptBR = {
  /** Label of a result tab: "2 · SELECT · 10 linhas". */
  label: {
    statement: 'Comando',
    error: (p: { n: number; verb: string }) => `${p.n} · ${p.verb} · erro`,
    rows: (p: { n: number; verb: string; rows: number }) => `${p.n} · ${p.verb} · ${f.count(p.rows, { one: 'linha', other: 'linhas' })}`,
    affected: (p: { n: number; verb: string; rows: number }) =>
      `${p.n} · ${p.verb} · ${f.count(p.rows, { one: 'linha afetada', other: 'linhas afetadas' })}`,
  },
  code: (p: { code: string }) => `código: ${p.code}`,
  refused: 'Comando recusado',
  error: 'Erro',
  details: 'Detalhes',
  cannotContinue: 'Não foi possível continuar',
  gridLabel: 'Resultado',
  selectCell: 'Selecione uma célula para ver o valor completo.',
  bytes: (p: { length: number }) => `(${f.formatNumber(p.length)} bytes)`,
  bytesPartial: (p: { length: number; shown: number }) => `(${f.formatNumber(p.length)} bytes, mostrando os primeiros ${p.shown})`,
  cellValue: 'Valor da célula',
  value: 'Valor',
  copyValue: 'Copiar valor',
  copyTsv: 'Copiar (TSV, com cabeçalho)',
  copyCsv: 'Copiar como CSV',
  copyJson: 'Copiar como JSON',
  copyMarkdown: 'Copiar como tabela Markdown',
  copyPartial: 'Cópia parcial do binário:',
  connecting: 'Conectando ao ambiente…',
  /** Same text main uses for the `no-statement` refusal, shown as a placeholder. */
  noStatement: 'Nenhum comando sob o cursor.',
  empty: 'Rode uma query para ver o resultado aqui.',
  noRows: 'A query não devolveu linhas.',
  affectedRows: (p: { n: number }) => f.count(p.n, { one: 'linha afetada', other: 'linhas afetadas' }),
  insertId: (p: { id: string }) => `ID inserido: ${p.id}`,
  warnings: (p: { n: number }) => f.count(p.n, { one: 'aviso', other: 'avisos' }),
  section: 'Resultados',
  copy: 'Copiar',
  cellPanel: 'Painel do valor da célula',
};
