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
    include: ['tests/integration/**/*.test.ts'],
    // dt-sql-parser ships ES modules without file extensions: the bundler reads it, Node cannot (the syntax corpus runs it)
    server: { deps: { inline: ['dt-sql-parser'] } },
    globalSetup: ['tests/support/mysql-global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
