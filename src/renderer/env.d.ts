/// <reference types="vite/client" />
import type { CaisApi } from '@shared/ipc';

declare global {
  interface Window {
    cais: CaisApi;
  }
}

export {};
