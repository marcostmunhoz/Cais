import { createFormat } from '../../core';

const f = createFormat('pt-BR');

/** Area "statusBar", pt-BR (the reference catalog: `en.ts` must follow its shape). */
export const ptBR = {
  rows: (p: { n: number }) => f.count(p.n, { one: 'linha', other: 'linhas' }),
  affectedRows: (p: { n: number }) => f.count(p.n, { one: 'linha afetada', other: 'linhas afetadas' }),
  truncated: (p: { n: number }) => `Truncado em ${f.formatNumber(p.n)} linhas`,
  fetchMore: (p: { n: number }) => `Buscar até ${f.formatNumber(p.n)}`,
  agentsTitle: 'Abrir o painel Agentes',
  agentsOn: 'Agentes ligado',
  requests: (p: { n: number }) => f.count(p.n, { one: 'pedido', other: 'pedidos' }),
  runHint: (p: { mod: string }) => `${p.mod}+Enter roda o comando sob o cursor`,
};
