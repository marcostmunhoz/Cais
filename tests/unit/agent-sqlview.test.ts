import { describe, expect, it } from 'vitest';
import { sql } from '@codemirror/lang-sql';
import { getDialect } from '@shared/dialects/registry';
import { agentCodeProblem, lex } from '@shared/dialects/bigquery/lexer';
import { classify } from '@shared/dialects/bigquery/classifier';
import { CODEMIRROR_DIALECTS, GOOGLESQL, MYSQL_AS_SERVER } from '../../src/renderer/lib/codemirrorDialects';

type Range = [number, number];

/** What the review (SqlView) marks as text or comment: the nodes a reader takes for "not code". */
function reviewRanges(text: string, dialect: (typeof CODEMIRROR_DIALECTS)[keyof typeof CODEMIRROR_DIALECTS]): Range[] {
  const tree = sql({ dialect }).language.parser.parse(text);
  const out: Range[] = [];
  const quiet = new Set(['String', 'LineComment', 'BlockComment', 'Bytes', 'Bits', 'QuotedIdentifier']);
  tree.iterate({
    enter: (node) => {
      if (quiet.has(node.name)) out.push([node.from, node.to]);
    },
  });
  return out;
}

/** What the server reads as a string, a quoted name or a comment. */
function serverRanges(text: string): Range[] {
  return lex(text, true)
    .filter((t) => t.kind === 'string' || t.kind === 'comment' || (t.kind === 'ident' && t.text.startsWith('`')))
    .map((t): Range => [t.pos, t.end]);
}

const same = (a: Range[], b: Range[]): boolean => JSON.stringify(a) === JSON.stringify(b);

const HIDING = [
  "SELECT 1 --'\n, my_ds.fn(x) AS a --'\n",
  "SELECT 1 --'\n, (SELECT query FROM `region-us`.INFORMATION_SCHEMA.JOBS LIMIT 1) AS q --'\n",
  "SELECT * FROM t WHERE a = b'a' OR my_ds.fn(1) = 'b'",
];

describe('the review of an agent request reads the SQL like its engine', () => {
  it('BigQuery environments use the GoogleSQL reading, MySQL ones the MySQL reading', () => {
    expect(CODEMIRROR_DIALECTS[getDialect('bigquery').codemirrorDialect]).toBe(GOOGLESQL);
    expect(CODEMIRROR_DIALECTS[getDialect('mysql').codemirrorDialect]).toBe(MYSQL_AS_SERVER);
  });

  it('the stock MySQL reading does read the three texts differently from the server (why the engine matters)', () => {
    for (const text of HIDING) expect(same(reviewRanges(text, MYSQL_AS_SERVER), serverRanges(text)), text).toBe(false);
  });

  it('with the dialect the review uses for BigQuery, strings and comments sit where the server puts them', () => {
    const readable = [
      "SELECT 1 -- 'x'\n, my_ds.fn(x) AS a",
      "SELECT * FROM t WHERE a = 'a' OR my_ds.fn(1) = 'b'",
      'SELECT "a", `p.d.t`.c, /* c */ 1 # note\n',
      "SELECT 1 --\n, 2",
    ];
    for (const text of readable) {
      expect(agentCodeProblem(text), text).toBeNull();
      expect(reviewRanges(text, GOOGLESQL), text).toEqual(serverRanges(text));
    }
  });

  it('a text that could read differently is refused for the agent', () => {
    for (const text of HIDING) {
      expect(classify(text).allowedInReadOnly, text).toBe(true);
      expect(agentCodeProblem(text), text).not.toBeNull();
    }
    expect(agentCodeProblem("SELECT rb'a', BR'b'")).not.toBeNull();
    expect(agentCodeProblem("SELECT 'b', \"rb\"")).toBeNull();
  });
});
