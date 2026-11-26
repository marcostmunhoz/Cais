import { createFormat } from '../../core';

const f = createFormat('pt-BR');

/** Area "native": system dialogs, notifications and console lines written by main. pt-BR. */
export const ptBR = {
  ok: 'Ok',
  debugRefused: 'Cais: opções de depuração não são aceitas.',
  startupFailed: 'Não foi possível iniciar o Cais',
  installDone: 'Comando instalado',
  installFailed: 'Não foi possível instalar o comando',
  skillDialog: {
    message: 'Instalar a skill do Cais para agentes',
    detail:
      'A skill é um arquivo de texto (SKILL.md) que ensina um agente a usar o comando cais llm. O Cais a copia para uma pasta "cais" dentro da pasta onde o agente guarda as skills, e não muda mais nada. O Claude Code lê as skills de ~/.claude/skills. Para outro agente, escolha a pasta de skills dele.',
    claudeCode: 'Claude Code',
    chooseFolder: 'Escolher pasta…',
    cancel: 'Cancelar',
    chooseTitle: 'Escolha a pasta onde o agente guarda as skills',
    done: 'Skill instalada',
    upToDate: 'Skill já atualizada',
    failed: 'Não foi possível instalar a skill',
  },
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
