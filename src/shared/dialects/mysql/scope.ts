import { analyzeScope, type ScopeAnalysis, type ScopeRules, type ScopeToken } from '../scope';
import { tokenize } from './classifier';

/** A backtick name is one name: the only escape is a doubled backtick. */
const rules: ScopeRules = { decodeQuoted: (content) => [content.replaceAll('``', '`')] };

/** The words, quoted names and punctuation of a statement, with strings and comments left out (the classifier's own reading). */
export function scopeTokens(text: string): ScopeToken[] {
  const out: ScopeToken[] = [];
  for (const token of read(text)) {
    // `we``ird` is one name; the classifier's scanner ends a backtick name at the first closing backtick
    const last = out[out.length - 1];
    if (token.kind === 'quoted' && last?.kind === 'quoted' && last.end === token.pos && last.text[0] === '`' && token.text[0] === '`') {
      out[out.length - 1] = { ...last, text: last.text + token.text, end: token.end };
    } else {
      out.push(token);
    }
  }
  return out;
}

function read(text: string): ScopeToken[] {
  return tokenize(text).map((t): ScopeToken => {
    const end = t.pos + t.v.length;
    switch (t.t) {
      case 'w':
        // `v` is the word in ASCII upper case; the name as written is in the text
        return { kind: 'word', text: text.slice(t.pos, end), upper: t.v, pos: t.pos, end };
      case 'i':
        return { kind: 'quoted', text: t.v, upper: '', pos: t.pos, end };
      case 'p':
        return { kind: 'punct', text: t.v, upper: '', pos: t.pos, end };
      default:
        return { kind: 'other', text: t.v, upper: '', pos: t.pos, end };
    }
  });
}

export function analyze(text: string): ScopeAnalysis {
  return analyzeScope(scopeTokens(text), text.length, rules);
}
