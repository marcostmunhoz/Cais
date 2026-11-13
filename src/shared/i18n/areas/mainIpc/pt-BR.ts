/** Area "mainIpc": the IPC layer (main/ipc.ts), its errors and the registry lines it writes on the trail. pt-BR (the reference). */
export const ptBR = {
  invalidData: 'Os dados enviados são inválidos.',
  unexpected: 'Erro inesperado.',
  unauthorizedOrigin: 'Origem não autorizada.',
  blockedCredentialTest:
    'Esta credencial é usada por um ambiente bloqueado (alterado fora do Cais ou ainda não conferido). Confira e salve o ambiente antes de testar.',
  trail: {
    /** One line per environment created by duplicating a project. */
    environmentCopied: (p: { source: string; level: string }) => `Ambiente criado (cópia de ${p.source}); acesso de agentes: ${p.level}.`,
    /** One line per environment of the renamed project. */
    projectRenamed: (p: { from: string; to: string }) => `Projeto renomeado: ${p.from} → ${p.to}.`,
    environmentCreated: (p: { level: string }) => `Ambiente criado; acesso de agentes: ${p.level}.`,
    environmentCreatedProduction: (p: { level: string }) => `Ambiente criado (produção); acesso de agentes: ${p.level}.`,
    /** `changes` joins the change* entries with "; ". */
    environmentChanged: (p: { changes: string }) => `Ambiente alterado: ${p.changes}.`,
    changeProduction: (p: { from: string; to: string }) => `produção: ${p.from} → ${p.to}`,
    changeAgentLevel: (p: { from: string; to: string }) => `acesso de agentes: ${p.from} → ${p.to}`,
    changeName: (p: { from: string; to: string }) => `nome: ${p.from} → ${p.to}`,
    changeProject: (p: { from: string; to: string }) => `projeto: ${p.from} → ${p.to}`,
    yes: 'sim',
    no: 'não',
    environmentReleased: 'Ambiente conferido e liberado pela pessoa (estava bloqueado).',
    environmentDeleted: 'Ambiente apagado.',
    agentAccessOn: 'Acesso de agentes ligado.',
    agentAccessOff: 'Acesso de agentes desligado.',
  },
};
