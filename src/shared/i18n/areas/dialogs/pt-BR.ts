import { createFormat } from '../../core';

const f = createFormat('pt-BR');

/** Area "dialogs", pt-BR (the reference catalog: `en.ts` must follow its shape). */
export const ptBR = {
  projectName: {
    renameTitle: 'Renomear projeto',
    duplicateTitle: 'Duplicar projeto',
    label: 'Nome do projeto',
    rename: 'Renomear',
    duplicate: 'Duplicar',
    cancel: 'Cancelar',
    duplicateHint: (p: { source: string }) =>
      `Copia todos os ambientes de ${p.source}, com a mesma credencial. Os scripts não são copiados.`,
    renameHint: 'Liberações de agentes deste projeto são revogadas e pedidos pendentes expiram, porque o endereço projeto/ambiente muda.',
  },
  /** BigQuery: statements estimated above the environment's byte limit, asked before anything runs. */
  bytesConfirm: {
    title: 'Consulta acima do limite de bytes',
    heading: 'Esta execução passa do limite de bytes do ambiente',
    body: (p: { limit: string; cap: string }) =>
      `Nada rodou ainda. O limite do ambiente é ${p.limit}. Se você rodar mesmo assim, o teto de bytes faturados sobe para ${p.cap} só nesta execução.`,
    estimate: (p: { bytes: string }) => `estimativa ${p.bytes}`,
    confirm: 'Rodar mesmo assim',
  },
  cancel: 'Cancelar',
  commit: 'Commit',
  rollback: 'Rollback',
  closeTransaction: {
    title: 'Transação aberta',
    heading: 'Esta aba tem uma transação aberta',
    body: (p: { count: number }) =>
      `${f.count(p.count, { one: 'comando ainda não foi confirmado', other: 'comandos ainda não foram confirmados' })}. Escolha o que fazer antes de fechar a aba. Rollback desfaz tudo.`,
  },
  quit: {
    title: 'Transações abertas',
    heading: 'Há transações abertas',
    body: (p: { count: number }) =>
      `${f.count(p.count, { one: 'aba tem', other: 'abas têm' })} transação aberta. Escolha o que fazer antes de sair. Rollback desfaz tudo.`,
  },
  tabPicker: {
    title: 'Nova aba',
    placeholder: 'Projeto · ambiente (ex.: loja pro)',
    searchLabel: 'Buscar ambiente',
    listLabel: 'Ambientes',
    production: 'Produção',
    empty: 'Nenhum ambiente encontrado',
  },
  closeDirty: {
    title: 'Alterações não salvas',
    heading: 'Salvar as alterações do script?',
    body: (p: { name: string }) => `O script ${p.name} tem alterações que ainda não foram salvas.`,
    discard: 'Descartar',
    save: 'Salvar',
  },
  scriptName: {
    renameTitle: 'Renomear script',
    saveTitle: 'Salvar script',
    rename: 'Renomear',
    save: 'Salvar',
    label: 'Nome do script',
  },
  scriptPicker: {
    title: 'Abrir script',
    placeholder: 'Projeto · nome do script',
    searchLabel: 'Buscar script',
    listLabel: 'Scripts',
    agent: 'agente',
    noScripts: 'Nenhum script salvo',
    empty: 'Nenhum script encontrado',
  },
};
