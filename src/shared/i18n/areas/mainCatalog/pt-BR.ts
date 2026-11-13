import { createFormat } from '../../core';

const f = createFormat('pt-BR');

/** Area "mainCatalog": the registry store (main/store/catalog.ts), its errors and integrity notes. pt-BR (the reference). */
export const ptBR = {
  projectNameRequired: 'Informe o nome do projeto.',
  projectExists: (p: { name: string }) => `Já existe um projeto chamado "${p.name}".`,
  projectNotFound: 'Projeto não encontrado.',
  environmentNameRequired: 'Informe o nome do ambiente.',
  environmentExists: (p: { name: string }) => `O projeto já tem um ambiente chamado "${p.name}".`,
  slashInName: 'O nome não pode ter "/": o endereço projeto/ambiente usado pelos agentes ficaria ambíguo.',
  duplicateBlocked: (p: { count: number; names: string }) =>
    p.count === 1
      ? `O ambiente ${p.names} está bloqueado. Confira e salve ele no cadastro antes de duplicar o projeto.`
      : `Os ambientes ${p.names} estão bloqueados. Confira e salve cada um no cadastro antes de duplicar o projeto.`,
  environmentUntrusted:
    'Este ambiente foi alterado fora do Cais. Confira host, porta e credencial no cadastro e salve antes de conectar.',
  projectHasEnvironments: (p: { names: string }) => `O projeto ainda tem ambientes: ${p.names}. Apague os ambientes primeiro.`,
  projectHasScripts: (p: { count: number }) => `O projeto tem ${f.count(p.count, { one: 'script', other: 'scripts' })}.`,
  hostRequired: 'Informe o host.',
  credentialRequired: 'Escolha uma credencial.',
  credentialNameRequired: 'Informe o nome da credencial.',
  credentialExists: (p: { name: string }) => `Já existe uma credencial chamada "${p.name}".`,
  usernameRequired: 'Informe o usuário.',
  passwordRequired: 'Informe a senha.',
  vaultUnavailable:
    'O cofre de senhas do sistema não está disponível. A senha não foi salva (o Cais nunca grava senha em texto puro).',
  gcloudAccountRequired: 'Informe a conta do gcloud.',
  dbUsernameRequired: 'Informe o usuário no banco.',
  credentialInUse: (p: { names: string }) => `A credencial está em uso por: ${p.names}.`,
  /** Integrity notes at load: shown as notices and written on the trail. `approveAll` is the level's label. */
  integrity: {
    sealCreated: (p: { count: number; names: string; approveAll: string }) =>
      'A proteção do cadastro foi criada agora (o arquivo seal.json não existia, foi removido ou não abre). ' +
      `Como não dá para saber se algo foi alterado, ${p.count === 1 ? 'o ambiente fica bloqueado e marcado' : 'os ambientes ficam bloqueados e marcados'} como produção (${p.names}) ` +
      `até você abrir o cadastro, conferir host, porta, credencial, a marcação de produção e o acesso de agentes e salvar ${p.count === 1 ? 'o ambiente' : 'cada um'}. O acesso de agentes voltou para "${p.approveAll}".`,
    waiting: (p: { count: number; names: string }) =>
      `${p.count === 1 ? 'Falta conferir' : 'Faltam conferir'} ${p.names} no cadastro: ${p.count === 1 ? 'ele segue bloqueado' : 'eles seguem bloqueados'} até você salvar.`,
    tampered: (p: { count: number; names: string; approveAll: string }) =>
      `O cadastro foi alterado fora do Cais (${p.names}). Por segurança, ` +
      `${p.count === 1 ? 'o ambiente ficou bloqueado, marcado' : 'os ambientes ficaram bloqueados, marcados'} como produção e com o acesso de agentes "${p.approveAll}". ` +
      'Nada conecta neles até você conferir host, porta e credencial no cadastro e salvar.',
  },
};
