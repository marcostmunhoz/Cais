import { createFormat } from '../../core';

const f = createFormat('pt-BR');

/** Area "native": system dialogs, notifications and console lines written by main. pt-BR. */
export const ptBR = {
  ok: 'Ok',
  debugRefused: 'Cais: opções de depuração não são aceitas.',
  startupFailed: 'Não foi possível iniciar o Cais',
  installDone: 'Comando instalado',
  installFailed: 'Não foi possível instalar o comando',
  notification: {
    title: 'Cais',
    pendingMany: (p: { count: number }) => `Pedidos de agente: ${f.formatNumber(p.count)} esperando você`,
    awaitingCommit: (p: { environment: string }) => `Escrita de agente esperando seu Commit em ${p.environment}`,
    commitUncertain: (p: { environment: string }) =>
      `Commit automático de agente com resultado incerto em ${p.environment}: confira no banco`,
    pendingOne: (p: { mode: 'read' | 'write'; environment: string }) =>
      `Pedido de agente: ${p.mode === 'write' ? 'escrever' : 'ler'} em ${p.environment}`,
  },
};
