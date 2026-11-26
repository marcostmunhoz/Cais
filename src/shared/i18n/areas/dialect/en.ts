import type { Shape } from '../../core';
import type { ptBR } from './pt-BR';

/**
 * Area "dialect", English. The `agentCode` entries (and any text the broker renders for agents) are sent to agents in
 * AGENT_LOCALE (English, fixed), so their text here is part of the CLI's output: change it only on purpose.
 */
export const en: Shape<typeof ptBR> = {
  literal: {
    invalid: (p) => `Invalid value for ${p.type}.`,
    unsupported: (p) => `Values of type ${p.type} cannot be written.`,
    truncated: 'The binary value is cut off, so it cannot be written back.',
    noKey: 'The UPDATE needs columns to change and the whole key of the row.',
    noColumns: 'The INSERT needs columns and rows.',
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
  /** GoogleSQL (BigQuery) dialect: read-only refusals shown to the person (after "Read-only: ") and agent code problems. */
  bigquery: {
    classify: {
      changesData: (p) => `${p.verb} is not allowed: BigQuery is read-only in this version.`,
      changesStructure: (p) => `${p.verb} is not allowed: BigQuery is read-only in this version.`,
      transaction: 'BigQuery only runs queries here: there are no transactions in this version.',
      script: 'scripts and blocks (DECLARE, SET, BEGIN ... END, IF, LOOP, WHILE, FOR...) are not allowed. Run one query at a time.',
      other: (p) => `${p.verb} is not a query. Only SELECT, WITH and FROM (pipe syntax) are allowed.`,
      empty: 'there is no statement to run.',
      multiple: 'more than one statement in the same text is not allowed. Run them one at a time.',
      mixed: (p) => `the query mixes in another statement (${p.verb}). Run them one at a time.`,
      legacyDirective: 'the #legacySQL or #standardSQL directive is not allowed.',
      externalQuery: 'EXTERNAL_QUERY is not allowed: it runs a query on another database.',
      unreadable:
        'the text has a string, backtick-quoted name or comment with no end, or something the server may read differently (a backslash in a raw string or between backticks).',
    },
    agentCode: {
      nestedComment:
        'Comment with /* inside: GoogleSQL ends the comment at the first */ and the review may show something else. Remove the inner /*.',
      carriageReturn: 'Line comment with a carriage return (CR) inside: the server and the review may find the end of the line in different places. Use line feeds only.',
      quotedVariable: 'Parameter name in quotes or backticks: use @name, with ASCII letters, digits and _ only.',
      nonAsciiFunction: (p) => `Function name with a non-ASCII character (${p.name}).`,
      nonAsciiCode: (p) =>
        `Non-ASCII character in the code (${p.marker} "${p.char}"), outside strings, backtick-quoted names and comments. Put the name in backticks or the value in quotes.`,
      tripleQuote: 'Triple-quoted string (\'\'\'...\'\'\' or """...""") is not allowed: the review does not read it as the server does. Use a single- or double-quoted string.',
      legacyDirective: 'The #legacySQL or #standardSQL directive is not allowed.',
      rawBackslash: 'Raw string (r\'...\') with a backslash: refused as a precaution, because the BigQuery documentation does not state the rule the server follows. Use a normal string and double the backslashes.',
      backslashIdent: 'Backtick-quoted name with a backslash: the server and the review may find the end of the name in different places. Remove the backslash.',
      dashComment: 'Comment -- glued to the text after it: with no space after the two dashes the review may read it as code. Put a space after --.',
      bytesPrefix: 'Bytes string (b\'...\'): the review may read it as a bit number and lose the end of the string. Use a normal string or FROM_BASE64.',
      chainedCall: 'Chained call ((expression).function(...) or (expression).(name)(...)): the review cannot see which function runs. Write the direct call, function(expression).',
      hexPrefix: 'The letter x glued to a string (x\'...\'): the review reads it as a hex number. Separate them with a space or use another name.',
    },
  },
};
