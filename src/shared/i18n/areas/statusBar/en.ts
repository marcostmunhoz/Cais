import { createFormat, type Shape } from '../../core';
import type { ptBR } from './pt-BR';

const f = createFormat('en');

/** Area "statusBar", English. */
export const en: Shape<typeof ptBR> = {
  rows: (p) => f.count(p.n, { one: 'row', other: 'rows' }),
  affectedRows: (p) => f.count(p.n, { one: 'row affected', other: 'rows affected' }),
  truncated: (p) => `Cut off at ${f.formatNumber(p.n)} rows`,
  fetchMore: (p) => `Fetch up to ${f.formatNumber(p.n)}`,
  bytesProcessed: (p) => `${f.formatBytes(p.bytes)} processed`,
  bytesBilled: (p) => `${f.formatBytes(p.bytes)} billed`,
  cacheHit: 'from cache',
  estimate: (p) => `Will process ${f.formatBytes(p.bytes)}`,
  estimateOverLimit: (p) => `Will process ${f.formatBytes(p.bytes)}, over the limit of ${f.formatBytes(p.limit)}: it will ask first`,
  estimating: 'Estimating…',
  estimateError: 'The statement has an error',
  estimateUnavailable: 'Could not estimate',
  estimateRefused: (p) => `Not estimated: ${p.reason}`,
  agentsTitle: 'Open the Agents panel',
  agentsOn: 'Agents on',
  requests: (p) => f.count(p.n, { one: 'request', other: 'requests' }),
  runHint: (p) => `${p.shortcut} runs the statement under the cursor`,
};
