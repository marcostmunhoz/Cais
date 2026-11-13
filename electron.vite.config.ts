import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig as defineElectronConfig } from 'electron-vite';

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@main': resolve(__dirname, 'src/main'),
};

/** Strict CSP in the build; the dev server needs inline scripts and websockets for hot reload. */
function csp(): Plugin {
  const strict =
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'";
  const dev =
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: http:; base-uri 'none'; form-action 'none'";
  return {
    name: 'cais-csp',
    transformIndexHtml(html, ctx) {
      return html.replace('__CSP__', ctx.server ? dev : strict);
    },
  };
}

export default defineElectronConfig({
  main: {
    resolve: { alias },
    build: { outDir: 'out/main' },
  },
  preload: {
    resolve: { alias },
    build: { outDir: 'out/preload' },
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias },
    plugins: [react(), csp()],
    build: { outDir: 'out/renderer' },
  },
});

