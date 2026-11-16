/** Area "tabs", pt-BR (the reference catalog: `en.ts` must follow its shape). */
export const ptBR = {
  strip: 'Abas de consulta',
  removedEnvironment: 'Ambiente removido',
  unsaved: 'Alterações não salvas',
  transactionOpen: 'Transação aberta',
  close: (p: { label: string }) => `Fechar aba ${p.label}`,
  newTab: 'Nova aba',
  newTabTitle: (p: { shortcut: string }) => `Nova aba (${p.shortcut})`,
};
