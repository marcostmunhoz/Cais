import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    // dt-sql-parser ships ES modules without file extensions and without "type": "module": the bundler reads it, Node cannot
    server: { deps: { inline: ['dt-sql-parser'] } },
  },
});
