/**
 * Area "mainScripts": the saved-scripts store (main/store/scripts.ts). pt-BR (the reference catalog).
 * Its errors can reach agents (a script an agent saves): main renders them for the person and keeps a MessageRef,
 * which the broker renders in AGENT_LOCALE.
 */
export const ptBR = {
  nameRequired: 'Informe o nome do script.',
  nameTooLong: (p: { max: number }) => `O nome pode ter até ${p.max} caracteres.`,
  nameTaken: (p: { project: string }) => `Já existe um script com esse nome em ${p.project}.`,
  nameTakenHere: 'Já existe um script com esse nome neste projeto.',
  projectNotFound: 'Projeto não encontrado.',
  notFound: 'Script não encontrado.',
  agentsCannotEdit: 'Agentes não editam scripts.',
  otherProject: 'O script pertence a outro projeto.',
  environmentNotInProject: 'Ambiente não encontrado neste projeto.',
  inconsistent: (p: { duplicates: number; orphans: number }) => {
    const parts = [
      p.duplicates ? `${p.duplicates} com nome repetido no mesmo projeto` : '',
      p.orphans ? `${p.orphans} de projeto que não existe mais` : '',
    ].filter(Boolean);
    return `O arquivo scripts.json tem scripts inconsistentes (${parts.join('; ')}). Eles foram mantidos.`;
  },
};
