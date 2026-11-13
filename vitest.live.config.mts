import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// The optional live suites: they talk to real services with credentials the person provides, and never run in
// `npm run check`. Each file skips itself when its variables are missing.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/live/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
