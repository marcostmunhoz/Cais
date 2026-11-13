/** Area "common", pt-BR (the reference catalog: `en.ts` must follow its shape). */
export const ptBR = {
  /** Suffix of a duplicated name: "Nome (cópia)", then "Nome (cópia 2)"... */
  copySuffix: '(cópia)',
  copySuffixN: (p: { n: number }) => `(cópia ${p.n})`,
};
