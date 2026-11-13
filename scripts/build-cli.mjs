// Bundles src/cli/cais.ts into out/cli/cais.mjs: one file, only Node's own modules, shebang, executable.
import { chmodSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outFile = resolve(root, 'out/cli/cais.mjs');

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir: resolve(root, 'out/cli'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: false,
    lib: { entry: resolve(root, 'src/cli/cais.ts'), formats: ['es'], fileName: () => 'cais.mjs' },
    rollupOptions: {
      external: [/^node:/],
      output: { banner: '#!/usr/bin/env node' },
    },
  },
});

const head = readFileSync(outFile, 'utf8').slice(0, 40);
if (!head.startsWith('#!/usr/bin/env node')) throw new Error('cais.mjs lost its shebang');
chmodSync(outFile, 0o755);
