import { describe, expect, it } from 'vitest';
import { getDialect } from '@shared/dialects/registry';
import { collapseBlankRuns, displaySql, markInvisible, stripInvisible } from '@shared/text';
import { cleanName, sameName } from '@shared/names';

describe('text safety for what a person reads', () => {
  it('marks bidi and invisible controls with a visible code and leaves other text alone', () => {
    expect(markInvisible("SELECT '‮' -- ‏⁦x﻿")).toBe("SELECT '⟨U+202E⟩' -- ⟨U+200F⟩⟨U+2066⟩x⟨U+FEFF⟩");
    expect(markInvisible('plain é ü 日本')).toBe('plain é ü 日本');
    for (const c of ['‎', '‏', '‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩', '﻿']) {
      expect(markInvisible(c)).toMatch(/^⟨U\+[0-9A-F]{4}⟩$/);
    }
  });

  it('strips them (and control characters) from free text', () => {
    expect(stripInvisible('a‮b⁩c﻿d\ne\u0000f')).toBe('abcd e f');
  });

  it('C1 controls too: a name with one never passes for another', () => {
    expect(stripInvisible('a\u0080b\u0081c\u009fd')).toBe('a b c d');
    expect(cleanName('pr\u0081od')).toBe('pr od');
    expect(sameName('prod', 'pr\u0081od')).toBe(false);
    expect(sameName('prod', 'prod\u0081')).toBe(true);
    expect(sameName('prod', 'pr\u0085od')).toBe(true);
  });

  it('folds runs of 2 or more blank lines into one visible marker and keeps single blank lines', () => {
    expect(collapseBlankRuns('a\n\n\n\nb')).toBe('a\n⋯ 3 linhas em branco\nb');
    expect(collapseBlankRuns('a\n\nb')).toBe('a\n\nb');
    expect(collapseBlankRuns(`UPDATE a SET x = 1;${'\n'.repeat(301)}DELETE FROM b;`)).toBe('UPDATE a SET x = 1;\n⋯ 300 linhas em branco\nDELETE FROM b;');
    expect(collapseBlankRuns('a\n  \t\n \nb')).toBe('a\n⋯ 2 linhas em branco\nb');
    expect(displaySql('a‮\n\n\n\nb')).toBe('a⟨U+202E⟩\n⋯ 3 linhas em branco\nb');
  });
});

describe('dialect identifiers', () => {
  const ids = (sql: string) => getDialect('mysql').identifiers(sql).sort();
  it('returns lower-case words and unquoted backtick names, whatever the qualifier', () => {
    expect(ids('UPDATE app.Legacy_Log SET `Col` = 1')).toEqual(['app', 'col', 'legacy_log', 'set', 'update']);
    expect(ids('DELETE FROM `app`.`legacy_log`')).toEqual(expect.arrayContaining(['app', 'legacy_log']));
    expect(ids("INSERT INTO t VALUES ('legacy_log')")).not.toContain('legacy_log'); // a string is not an identifier
  });
});
