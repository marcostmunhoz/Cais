import type { Dialect } from '../types';
import { classify, identifiers, warnings } from './classifier';
import { MYSQL_KEYWORDS } from './keywords';
import { appendStatements, splitStatements } from './splitter';
import { agentCodeProblem } from './lexer';
import { buildUpdate, quoteIdent, quoteLiteral, valueKind } from './literals';

export const mysqlDialect: Dialect = {
  engine: 'mysql',
  displayName: 'MySQL',
  codemirrorDialect: 'MySQL',
  keywords: MYSQL_KEYWORDS,
  splitStatements,
  appendStatements,
  classify,
  warnings,
  identifiers,
  agentCodeProblem,
  quoteIdent,
  valueKind,
  quoteLiteral,
  buildUpdate,
};

export { splitStatements, appendStatements, classify, warnings, identifiers, buildUpdate, quoteLiteral, valueKind };
