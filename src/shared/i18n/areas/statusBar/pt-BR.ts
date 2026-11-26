import { createFormat } from '../../core';

const f = createFormat('pt-BR');

/** Area "statusBar", pt-BR (the reference catalog: `en.ts` must follow its shape). */
export const ptBR = {
  rows: (p: { n: number }) => f.count(p.n, { one: 'linha', other: 'linhas' }),
  affectedRows: (p: { n: number }) => f.count(p.n, { one: 'linha afetada', other: 'linhas afetadas' }),
  truncated: (p: { n: number }) => `Truncado em ${f.formatNumber(p.n)} linhas`,
  fetchMore: (p: { n: number }) => `Buscar até ${f.formatNumber(p.n)}`,
  /** BigQuery footer: what the job read and what it billed. */
  bytesProcessed: (p: { bytes: number }) => `${f.formatBytes(p.bytes)} processados`,
  bytesBilled: (p: { bytes: number }) => `${f.formatBytes(p.bytes)} faturados`,
  cacheHit: 'do cache',
  /** BigQuery, "Estimar ao digitar": what the statement under the cursor would read, from a dry run. */
  estimate: (p: { bytes: number }) => `Vai processar ${f.formatBytes(p.bytes)}`,
  estimateOverLimit: (p: { bytes: number; limit: number }) =>
    `Vai processar ${f.formatBytes(p.bytes)}, acima do limite de ${f.formatBytes(p.limit)}: vai pedir confirmação`,
  estimating: 'Estimando…',
  estimateError: 'A consulta tem erro',
  estimateUnavailable: 'Não foi possível estimar',
  estimateRefused: (p: { reason: string }) => `Não estimado: ${p.reason}`,
  agentsTitle: 'Abrir o painel Agentes',
  agentsOn: 'Agentes ligado',
  requests: (p: { n: number }) => f.count(p.n, { one: 'pedido', other: 'pedidos' }),
  runHint: (p: { shortcut: string }) => `${p.shortcut} roda o comando sob o cursor`,
};
