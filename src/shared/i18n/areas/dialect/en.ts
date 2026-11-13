import type { Shape } from '../../core';
import type { ptBR } from './pt-BR';

/** Area "dialect", English. */
export const en: Shape<typeof ptBR> = {
  literal: {
    invalid: (p) => `Invalid value for ${p.type}.`,
    unsupported: (p) => `Values of type ${p.type} cannot be written.`,
    truncated: 'The binary value is cut off, so it cannot be written back.',
    noKey: 'The UPDATE needs columns to change and the whole key of the row.',
  },
  noStatement: 'No statement under the cursor.',
  classify: {
    transactionMode: 'Use the tab mode (Read-only, Transaction or Auto-commit) to control transactions and autocommit.',
    readOnly: (p) => `Read-only: ${p.what}`,
    notListed: 'this statement is not on the list of allowed statements.',
    setOnly: 'only SET of user variables (@variable), SET NAMES utf8mb4 or SET CHARACTER SET utf8mb4 on its own is allowed.',
    changesData: (p) => `${p.verb} is not allowed. Change the tab mode to change data.`,
    changesStructure: (p) => `${p.verb} is not allowed. Change the tab mode to change the structure.`,
    explainWrite: 'EXPLAIN of a write does not run in read-only. Use Transaction mode: EXPLAIN changes nothing.',
    explainReadsOnly: 'EXPLAIN is only allowed for reads.',
    explainAnalyzeReadsOnly: 'EXPLAIN ANALYZE is only allowed for reads.',
    useTransactionMode: 'use the tab’s Transaction mode to open a transaction.',
    release: (p) => `${p.verb} RELEASE closes the connection and is not allowed.`,
    chain: (p) => `${p.verb} AND CHAIN opens another transaction. Use the tab’s Transaction mode.`,
    nonAsciiFunction: (p) => `function name with a non-ASCII letter (${p.name}): the server may find another function.`,
    serverStateFunction: (p) => `the function ${p.name} changes the server state.`,
    versionedComment: (p) =>
      `a versioned executable comment (${p.versioned} or ${p.mariadb}) can hide a statement other than the one shown. Remove the comment.`,
    executableComment: (p) => `executable comments (${p.syntax}) are not allowed.`,
    intoOutfile: 'SELECT ... INTO OUTFILE is not allowed.',
    intoDumpfile: 'SELECT ... INTO DUMPFILE is not allowed.',
    lockingRead: (p) => `locking reads (${p.clause}) are not allowed.`,
  },
  warning: {
    noWhere: (p) => `${p.verb} without WHERE`,
    alwaysTrue: (p) => `${p.verb} with a WHERE that is always true`,
    executableComment: (p) => `Executable comment (${p.syntax}): the server may run something else`,
  },
  agentCode: {
    nestedComment:
      'Comment with /* inside: MySQL ends the comment at the first */ and the review may show something else. Remove the inner /*.',
    dashComment: 'Comment "--" without a space right after it: use "-- " (dash, dash, space).',
    quotedVariable: 'Variable name in quotes or backticks: use @name, with ASCII letters, digits and _ only.',
    nonAsciiFunction: (p) => `Function name with a non-ASCII character (${p.name}): MySQL finds functions ignoring accents.`,
    nonAsciiCode: (p) =>
      `Non-ASCII character in the code (${p.marker} "${p.char}"), outside strings and backtick-quoted names: MySQL reads it as part of a name. Put the name in backticks or the value in quotes.`,
  },
};
