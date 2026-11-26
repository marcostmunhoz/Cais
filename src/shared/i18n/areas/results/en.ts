import { createFormat, type Shape } from '../../core';
import type { ptBR } from './pt-BR';

const f = createFormat('en');

/** Area "results", English. */
export const en: Shape<typeof ptBR> = {
  label: {
    statement: 'Statement',
    error: (p) => `${p.n} · ${p.verb} · error`,
    rows: (p) => `${p.n} · ${p.verb} · ${f.count(p.rows, { one: 'row', other: 'rows' })}`,
    affected: (p) => `${p.n} · ${p.verb} · ${f.count(p.rows, { one: 'row affected', other: 'rows affected' })}`,
  },
  code: (p) => `code: ${p.code}`,
  refused: 'Statement refused',
  error: 'Error',
  details: 'Details',
  cannotContinue: 'Could not continue',
  gridLabel: 'Result',
  selectCell: 'Select a cell to see its full value.',
  bytes: (p) => `(${f.formatNumber(p.length)} bytes)`,
  bytesPartial: (p) => `(${f.formatNumber(p.length)} bytes, showing the first ${p.shown})`,
  cellValue: 'Cell value',
  value: 'Value',
  copyValue: 'Copy value',
  copyTsv: 'Copy (TSV, with header)',
  copyCsv: 'Copy as CSV',
  copyJson: 'Copy as JSON',
  copyMarkdown: 'Copy as Markdown table',
  copyPartial: 'Partial copy of the binary value:',
  connecting: 'Connecting to the environment…',
  noStatement: 'No statement under the cursor.',
  empty: 'Run a query to see the result here.',
  noRows: 'The query returned no rows.',
  affectedRows: (p) => f.count(p.n, { one: 'row affected', other: 'rows affected' }),
  insertId: (p) => `Inserted ID: ${p.id}`,
  warnings: (p) => f.count(p.n, { one: 'warning', other: 'warnings' }),
  section: 'Results',
  copy: 'Copy',
  cellPanel: 'Cell value panel',
};
