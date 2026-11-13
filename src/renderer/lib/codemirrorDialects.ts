// How CodeMirror reads each engine's SQL. Kept apart from the components so a test can use the same specs.
import { MySQL, SQLDialect } from '@codemirror/lang-sql';

/**
 * The sessions always run with backslash escapes on (the app removes NO_BACKSLASH_ESCAPES), so the highlighter
 * must read 'x\'' the same way the server does; the stock MySQL spec has them off.
 */
export const MYSQL_AS_SERVER = SQLDialect.define({ ...MySQL.spec, backslashEscapes: true });
/**
 * GoogleSQL as the highlighter can read it: backslash escapes, `#` and `--` comments (no space needed after the
 * dashes), backtick names, double-quoted strings, `b'…'` as bytes and `@name` / `@@name` / `?` parameters.
 * It does not read triple-quoted strings, nested-comment rules or backslashes inside backticks the way the
 * server does, so `agentCodeProblem` refuses those in agent SQL.
 */
export const GOOGLESQL = SQLDialect.define({
  backslashEscapes: true,
  hashComments: true,
  spaceAfterDashes: false,
  doubleQuotedStrings: true,
  treatBitsAsBytes: true,
  identifierQuotes: '`',
  operatorChars: '*+-%<>!=&|^~/',
  specialVar: '@?',
});
export const CODEMIRROR_DIALECTS = { MySQL: MYSQL_AS_SERVER, GoogleSQL: GOOGLESQL };
