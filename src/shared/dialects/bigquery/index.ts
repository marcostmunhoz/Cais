import type { AgentRules, Dialect } from '../types';
import { classify, identifiers, warnings } from './classifier';
import { GOOGLESQL_KEYWORDS } from './keywords';
import { agentCodeProblem } from './lexer';
import { appendStatements, splitStatements } from './splitter';

/** A dataset name: letters, digits and underscore, up to 1024 characters. */
const DATASET_NAME = /^[A-Za-z0-9_]{1,1024}$/;

const agentRules: AgentRules = {
  systemSchemas: ['information_schema'],
  secretSchemas: [],
  deniedFunctions: ['EXTERNAL_QUERY'],
  writeVerbs: [],
  isValidDatabaseName: (name) => DATASET_NAME.test(name),
  messages: {
    systemSchemaWrite: 'Agentes não escrevem no INFORMATION_SCHEMA.',
    systemSchemaRead: 'Agentes não leem esse esquema.',
  },
};

/** The quote that makes a name safe to splice into a statement: backticks, with the backtick and the backslash escaped. */
export function quoteIdent(name: string): string {
  return `\`${name.replace(/[\\`]/g, '\\$&')}\``;
}

const unsupported = (what: string) => (): never => {
  throw new Error(`BigQuery is read-only: ${what} is not supported.`);
};

export const bigqueryDialect: Dialect = {
  engine: 'bigquery',
  displayName: 'BigQuery',
  codemirrorDialect: 'GoogleSQL',
  databaseTerm: 'dataset',
  keywords: GOOGLESQL_KEYWORDS,
  splitStatements,
  appendStatements,
  classify,
  warnings,
  identifiers,
  agentCodeProblem,
  quoteIdent,
  agentRules,
  tablePreviewSql: (database, table) => `SELECT * FROM ${quoteIdent(database)}.${quoteIdent(table)} LIMIT 100;`,
  valueKind: () => 'unsupported',
  quoteLiteral: unsupported('writing a literal'),
  buildUpdate: unsupported('UPDATE'),
};

export { splitStatements, appendStatements, classify, warnings, identifiers, agentCodeProblem };
