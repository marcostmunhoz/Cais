/** Area "about", pt-BR (the reference catalog: `en.ts` must follow its shape). The About window. */
export const ptBR = {
  title: 'Sobre o Cais',
  tagline: 'Cliente SQL de desktop, organizado por projeto e ambiente.',
  version: (p: { version: string }) => `Versão ${p.version}`,
  labels: {
    electron: 'Electron',
    chromium: 'Chromium',
    node: 'Node',
    system: 'Sistema',
    license: 'Licença',
    repository: 'Repositório',
  },
  licenseValue: 'MIT',
  copy: 'Copiar informações',
  copied: 'Informações copiadas.',
  close: 'Fechar',
  openFailed: 'Não foi possível abrir o endereço no navegador.',
  /** What "Copiar informações" puts on the clipboard (to paste in a bug report). */
  copyText: (p: { version: string; electron: string; chromium: string; node: string; system: string }) =>
    `Cais ${p.version}\nElectron ${p.electron}\nChromium ${p.chromium}\nNode ${p.node}\nSistema: ${p.system}`,
  update: {
    heading: 'Versão mais recente',
    hint: 'A consulta vai ao GitHub só quando você clica em Verificar. Nada é verificado sozinho, e o Cais nunca baixa nem instala nada.',
    check: 'Verificar',
    checking: 'Verificando…',
    newer: (p: { latest: string }) => `Há uma versão nova: ${p.latest}.`,
    current: 'Você está na versão mais recente.',
    unavailable: 'Não foi possível verificar.',
    openRelease: (p: { latest: string }) => `Ver a versão ${p.latest}`,
    openReleases: 'Abrir as releases',
  },
};
