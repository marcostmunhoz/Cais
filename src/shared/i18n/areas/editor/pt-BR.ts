/** Area "editor", pt-BR (the reference catalog: `en.ts` must follow its shape). */
export const ptBR = {
  ariaLabel: 'Editor SQL',
  /** Autocomplete details next to a schema name. */
  tableDetail: 'tabela',
  viewDetail: 'view',
  databaseDetail: { database: 'banco', dataset: 'dataset' },
  /** Diagnostic of the syntax check: the parser's message (English, as the grammar words it) goes after this. */
  syntaxError: (p: { message: string }) => `Possível erro de sintaxe: ${p.message}`,
  /** CodeMirror's own phrases that reach the person (tooltip of a control character, screen reader text). */
  codemirror: {
    controlCharacter: 'Caractere de controle',
    completions: 'Sugestões',
    selectionDeleted: 'Seleção apagada',
  },
};
