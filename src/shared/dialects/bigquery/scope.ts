import { analyzeScope, type ScopeAnalysis, type ScopeRules, type ScopeToken } from '../scope';
import { asciiUpper, lex } from './lexer';

/** A name in backticks may be a whole path (`project.dataset.table`): its parts are the names of the path. A backslash escapes the next character. */
const rules: ScopeRules = {
  decodeQuoted: (content) => {
    const parts: string[] = [];
    let cur = '';
    for (let i = 0; i < content.length; i++) {
      const c = content[i]!;
      if (c === '\\' && i + 1 < content.length) {
        cur += content[++i];
      } else if (c === '.') {
        parts.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
    parts.push(cur);
    return parts;
  },
};

/** The words, quoted names and punctuation of a statement, with strings and comments left out. */
export function scopeTokens(text: string): ScopeToken[] {
  const out: ScopeToken[] = [];
  for (const t of lex(text, true)) {
    if (t.kind === 'comment') continue;
    const kind = t.kind === 'word' ? 'word' : t.kind === 'ident' ? 'quoted' : t.kind === 'punct' ? 'punct' : 'other';
    out.push({ kind, text: t.text, upper: kind === 'word' ? asciiUpper(t.text) : '', pos: t.pos, end: t.end });
  }
  return out;
}

export function analyze(text: string): ScopeAnalysis {
  return analyzeScope(scopeTokens(text), text.length, rules);
}
