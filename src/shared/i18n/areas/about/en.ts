import type { Shape } from '../../core';
import type { ptBR } from './pt-BR';

/** Area "about", English. */
export const en: Shape<typeof ptBR> = {
  title: 'About Cais',
  tagline: 'Desktop SQL client, organized by project and environment.',
  version: (p) => `Version ${p.version}`,
  labels: {
    electron: 'Electron',
    chromium: 'Chromium',
    node: 'Node',
    system: 'System',
    license: 'License',
    repository: 'Repository',
  },
  licenseValue: 'MIT',
  copy: 'Copy info',
  copied: 'Info copied.',
  close: 'Close',
  openFailed: 'Could not open the address in the browser.',
  copyText: (p) => `Cais ${p.version}\nElectron ${p.electron}\nChromium ${p.chromium}\nNode ${p.node}\nSystem: ${p.system}`,
  update: {
    heading: 'Latest version',
    hint: 'The lookup goes to GitHub only when you click Check. Nothing is checked on its own, and Cais never downloads or installs anything.',
    check: 'Check',
    checking: 'Checking…',
    newer: (p) => `A new version is available: ${p.latest}.`,
    current: 'You are on the latest version.',
    unavailable: 'Could not check.',
    openRelease: (p) => `See version ${p.latest}`,
    openReleases: 'Open releases',
  },
};
