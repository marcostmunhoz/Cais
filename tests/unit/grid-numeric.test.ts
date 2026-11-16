import { beforeAll, describe, expect, it, vi } from 'vitest';

// The renderer's format module reads `window` when it loads and is outside the node project: loaded by a variable path
const RENDERER_FORMAT = '../../src/renderer/lib/format';
let isNumericType: (type: string) => boolean;
beforeAll(async () => {
  vi.stubGlobal('window', { cais: { locale: 'pt-BR' } });
  vi.stubGlobal('document', { documentElement: {} });
  isNumericType = ((await import(/* @vite-ignore */ RENDERER_FORMAT)) as { isNumericType: (type: string) => boolean }).isNumericType;
});

describe('numeric columns are aligned to the right', () => {
  it('MySQL types as the server names them', () => {
    for (const type of ['int', 'bigint', 'decimal', 'double', 'year']) expect(isNumericType(type), type).toBe(true);
    for (const type of ['varchar', 'datetime', 'blob', 'json']) expect(isNumericType(type), type).toBe(false);
  });
  it('BigQuery numbers, in capitals and with parameters', () => {
    for (const type of ['INT64', 'NUMERIC', 'BIGNUMERIC', 'FLOAT64', 'NUMERIC(10, 2)', 'BIGNUMERIC(40)']) expect(isNumericType(type), type).toBe(true);
    for (const type of ['STRING', 'BOOL', 'TIMESTAMP', 'DATE', 'BYTES', 'JSON', 'ARRAY<INT64>', 'STRUCT<a INT64>', 'INTERVAL']) expect(isNumericType(type), type).toBe(false);
  });
});
