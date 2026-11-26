// The syntax check runs here, off the page's thread: the grammar takes tens of milliseconds on a statement it has not
// read before and more than a hundred on one with an error.
import { checkMysql } from './mysql';
import type { SyntaxReply, SyntaxRequest } from './client';

const scope = self as unknown as { onmessage: ((e: { data: SyntaxRequest }) => void) | null; postMessage(message: SyntaxReply): void };

scope.onmessage = (e) => {
  let issues: SyntaxReply['issues'] = [];
  try {
    issues = checkMysql(e.data.text);
  } catch {
    // a grammar that throws on a text says nothing about it
  }
  scope.postMessage({ id: e.data.id, issues });
};
