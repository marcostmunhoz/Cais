/** Area "text", pt-BR (the reference catalog: `en.ts` must follow its shape). */
export const ptBR = {
  /** Why SQL cannot be shown honestly (`hiddenTextProblem`). `marker` is ⟨U+XXXX⟩, never translated. */
  hidden: {
    invisible: (p: { marker: string }) => `O SQL tem um caractere invisível ou de direção de texto (${p.marker}). Reescreva sem ele.`,
    oddBreak: (p: { marker: string }) => `O SQL tem uma quebra de linha diferente de \\n (${p.marker}). Use só \\n.`,
    control: (p: { marker: string }) => `O SQL tem um caractere de controle (${p.marker}). Reescreva sem ele.`,
  },
  /** The marker line that stands for a run of blank lines in reviewed SQL. */
  blankLines: (p: { count: number }) => `⋯ ${p.count} linhas em branco`,
};
