import type { AgentRules, Dialect } from '../types';
import { hiddenTextProblem } from '../../text';
import { classify, identifiers, warnings } from './classifier';
import { MYSQL_KEYWORDS } from './keywords';
import { appendStatements, splitStatements } from './splitter';
import { agentCodeProblem } from './lexer';
import { analyze } from './scope';
import { buildUpdate, quoteIdent, quoteLiteral, valueKind } from './literals';

/** MySQL identifiers are at most 64 characters; anything else in --database is refused before it reaches a modal. */
const MAX_DATABASE_NAME = 64;

const agentRules: AgentRules = {
  systemSchemas: ['mysql', 'performance_schema', 'sys', 'information_schema'],
  secretSchemas: ['mysql'],
  // named locks (they outlive the request), waits that hold a connection, server files
  deniedFunctions: ['GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS', 'SLEEP', 'BENCHMARK', 'LOAD_FILE'],
  writeVerbs: ['INSERT', 'REPLACE', 'UPDATE', 'DELETE'],
  isValidDatabaseName: (name) => name.length <= MAX_DATABASE_NAME && hiddenTextProblem(name) === null && !/[\r\n`]/.test(name),
  messages: {
    systemSchemaWrite: 'Agentes não escrevem nos esquemas do sistema (mysql, performance_schema, sys, information_schema).',
    systemSchemaRead: 'Agentes não leem o esquema mysql (contas e hashes de senha).',
  },
};

export const mysqlDialect: Dialect = {
  engine: 'mysql',
  displayName: 'MySQL',
  codemirrorDialect: 'MySQL',
  databaseTerm: 'database',
  keywords: MYSQL_KEYWORDS,
  splitStatements,
  appendStatements,
  classify,
  warnings,
  identifiers,
  analyze,
  agentCodeProblem,
  quoteIdent,
  agentRules,
  tablePreviewSql: (database, table) => `SELECT * FROM ${quoteIdent(database)}.${quoteIdent(table)} LIMIT 100;`,
  valueKind,
  quoteLiteral,
  buildUpdate,
};

export { splitStatements, appendStatements, classify, warnings, identifiers, buildUpdate, quoteLiteral, valueKind };
