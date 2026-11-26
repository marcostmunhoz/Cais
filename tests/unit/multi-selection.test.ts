import { describe, expect, it } from 'vitest';
import { getDialect, multiSelectionBlock } from '@shared/dialects/registry';

const doc = 'UPDATE t SET a = 1 WHERE id = 1;\nUPDATE t SET a = 2 WHERE id = 2;\nUPDATE t SET a = 3 WHERE id = 3;\nSELECT 1;';
const statements = getDialect('mysql').splitStatements(doc);
const inStatement = (i: number) => ({ from: statements[i]!.start + 7, to: statements[i]!.start + 8 });

describe('multiSelectionBlock', () => {
  it('runs the block when each range is in its own statement and the statements are contiguous', () => {
    const block = multiSelectionBlock(statements, [inStatement(0), inStatement(1), inStatement(2)], doc);
    expect(block).toEqual({ from: statements[0]!.start, to: statements[2]!.end });
  });

  it('is null for a single range', () => {
    expect(multiSelectionBlock(statements, [{ from: 0, to: 6 }], doc)).toBeNull();
  });

  it('is null when two ranges share a statement', () => {
    expect(multiSelectionBlock(statements, [{ from: 0, to: 6 }, { from: 10, to: 11 }], doc)).toBeNull();
  });

  it('is null when a statement in between holds no range (a cursor added far below)', () => {
    const a = { from: 0, to: 0 };
    const c = { from: statements[2]!.start + 3, to: statements[2]!.start + 3 };
    expect(multiSelectionBlock(statements, [a, c], doc)).toBeNull();
  });

  it('is null when a range spans two statements or sits outside any statement', () => {
    expect(multiSelectionBlock(statements, [{ from: 0, to: 40 }, { from: 50, to: 51 }], doc)).toBeNull();
    expect(multiSelectionBlock(statements, [{ from: 0, to: 3 }, { from: doc.length + 5, to: doc.length + 5 }], doc)).toBeNull();
  });

  it('accepts ranges in any order as long as the shape holds', () => {
    const r1 = { from: statements[1]!.start + 2, to: statements[1]!.start + 4 };
    const r0 = { from: statements[0]!.start + 2, to: statements[0]!.start + 4 };
    expect(multiSelectionBlock(statements, [r1, r0], doc)).toEqual({ from: statements[0]!.start, to: statements[1]!.end });
  });
});
