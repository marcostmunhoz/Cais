import { createFormat, type Shape } from '../../core';
import type { ptBR } from './pt-BR';

const f = createFormat('en');

/** Area "grid", English. */
export const en: Shape<typeof ptBR> = {
  reason: {
    notRead: 'Grid editing only works on the result of a SELECT.',
    noTable: 'Grid editing only works on the result of one table: the columns of this result do not come from a table.',
    severalTables: (p) => `Grid editing only works on the result of one table (this one comes from ${p.tables}).`,
    schemaLoading: 'Loading the schema of the environment to find the primary key. Try again in a moment.',
    schemaFailed: (p) => `The schema of the environment could not be read: ${p.message}`,
    unknownTable: (p) => `Table ${p.table} is not in the loaded schema. Refresh the environment tree.`,
    view: (p) => `${p.table} is a view: grid editing only works on tables.`,
    noPrimaryKey: (p) => `Table ${p.table} has no primary key, which grid editing needs.`,
    missingKey: (p) => `Grid editing only works on the result of one table with its whole primary key (missing: ${p.columns}).`,
    staleSchema: 'The primary key changed since the schema was loaded. Refresh the environment tree.',
    floatKey: (p) => `Key ${p.column} is FLOAT or DOUBLE, so comparing it is not exact.`,
    zonedKey: (p) => `Key ${p.column} is TIMESTAMP, so its value depends on the session time zone.`,
    nullKey: (p) => `A row has NULL in key ${p.column}, so the row cannot be identified.`,
    truncatedKey: (p) => `Key ${p.column} has a binary value that is cut off in the grid.`,
    duplicateKey: 'The primary key repeats in the result, so the row to edit is unclear.',
    expression: (p) => `${p.column} is an expression, not a column of the table.`,
    unknownColumn: (p) => `${p.column} is not in the loaded schema. Refresh the environment tree.`,
    duplicateColumn: (p) => `${p.column} appears more than once in the result: edit the first one.`,
    generated: (p) => `${p.column} is a generated column: the server computes its value.`,
    unsupportedType: (p) => `${p.column} has type ${p.type}, which cannot be edited in the grid.`,
    staleColumn: (p) => `The type of ${p.column} changed since the schema was loaded. Refresh the environment tree.`,
    truncatedValue: 'The binary value is cut off in the grid, so it cannot be edited.',
  },
  invalid: {
    integer: (p) => `Invalid value for ${p.column}: use a whole number.`,
    number: (p) => `Invalid value for ${p.column}: use a number with a decimal point.`,
    hex: (p) => `Invalid value for ${p.column}: type the bytes in hexadecimal.`,
  },
  bar: {
    summary: (p) => `${f.count(p.changes, { one: 'change', other: 'changes' })} in ${f.count(p.rows, { one: 'row', other: 'rows' })}`,
    generate: 'Generate UPDATE',
    generateTitle: 'Puts the UPDATE statements at the end of the editor, without running them',
    apply: 'Apply',
    applyTitle: 'Runs the UPDATE statements in this tab',
    applyReadOnly: 'Switch to Transaction or Auto-commit',
    discard: 'Discard',
  },
  menu: {
    edit: 'Edit cell',
    setNull: 'Set to NULL',
    undo: 'Undo edit',
  },
  cell: {
    editorLabel: (p) => `New value of ${p.column}`,
    original: (p) => `Changed. Original value: ${p.value}`,
  },
  confirmApply: {
    title: 'Apply in Auto-commit on production',
    body: (p) => `Each UPDATE is committed right away, with no Rollback. This environment (${p.environment}) is production.`,
    confirm: 'Apply',
  },
  confirmDiscard: {
    title: 'Discard the grid edits',
    body: (p) =>
      `${f.count(p.changes, { one: 'pending change', other: 'pending changes' })} in the grid ${p.changes === 1 ? 'has' : 'have'} not been applied or sent to the editor.`,
    confirm: 'Discard',
  },
  notice: {
    close: 'Close',
    applied: (p) => `Edit applied: ${f.count(p.count, { one: 'UPDATE', other: 'UPDATEs' })}.`,
    appliedInTransaction: (p) => `${f.count(p.count, { one: 'UPDATE ran', other: 'UPDATEs ran' })} in the transaction. Commit to save.`,
    notOne: (p) =>
      `UPDATE ${f.formatNumber(p.statement)} ${p.rows === 0 ? 'did not find the row' : `found ${f.count(p.rows, { one: 'row', other: 'rows' })}`} (expected: 1).`,
    failed: (p) => `UPDATE ${f.formatNumber(p.statement)} failed: ${p.message}`,
    transaction: 'The transaction is still open: check it and roll back if something is wrong.',
    autocommitSaved: (p) =>
      p.count === 0
        ? 'In Auto-commit: no UPDATE was saved before the error.'
        : `In Auto-commit, the ${p.count === 1 ? 'UPDATE before the error is' : `${f.formatNumber(p.count)} UPDATEs before the error are`} already saved.`,
    refreshFailed: (p) => `The query could not run again: ${p.message}`,
    otherTable: 'it read another table (the session database changed). The previous result was kept.',
  },
};
