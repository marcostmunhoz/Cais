import { createFormat, type Shape } from '../../core';
import type { ptBR } from './pt-BR';

const f = createFormat('en');

/** Area "statusBar", English. */
export const en: Shape<typeof ptBR> = {
  rows: (p) => f.count(p.n, { one: 'row', other: 'rows' }),
  affectedRows: (p) => f.count(p.n, { one: 'row affected', other: 'rows affected' }),
  truncated: (p) => `Cut off at ${f.formatNumber(p.n)} rows`,
  fetchMore: (p) => `Fetch up to ${f.formatNumber(p.n)}`,
  agentsTitle: 'Open the Agents panel',
  agentsOn: 'Agents on',
  requests: (p) => f.count(p.n, { one: 'request', other: 'requests' }),
  runHint: (p) => `${p.shortcut} runs the statement under the cursor`,
};
