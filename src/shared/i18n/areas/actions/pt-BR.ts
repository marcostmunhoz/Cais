/** Area "actions", pt-BR: toasts and confirmations raised by the renderer's actions. */
export const ptBR = {
  scriptProjectHasNoEnvironments: 'O projeto do script não tem ambientes.',
  scriptSaved: 'Script salvo.',
  deleteScript: {
    title: 'Excluir script',
    body: (p: { name: string }) => `Excluir o script ${p.name}? Não dá para desfazer.`,
    confirm: 'Excluir',
  },
  implicitCommit: {
    title: 'Esta operação faz commit implícito',
    body: (p: { engine: string }) =>
      `O ${p.engine} confirma a transação aberta antes de executar este comando. O que já foi alterado não poderá ser desfeito com Rollback.`,
    confirm: 'Executar mesmo assim',
  },
  productionAutocommit: {
    title: 'Auto-commit em produção',
    body: (p: { environment: string }) =>
      `Em auto-commit cada comando é confirmado na hora, sem Rollback. Este ambiente (${p.environment}) é de produção.`,
    confirm: 'Usar auto-commit',
  },
  rollbackIncomplete: 'Rollback incompleto: tabelas não transacionais ficaram com o que foi gravado nelas.',
};
