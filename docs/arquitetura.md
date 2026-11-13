# Arquitetura

Como o Cais é montado: processos, módulos, contratos, arquivos e empacotamento. As regras de produto estão em [comportamento.md](comportamento.md) e o modelo de segurança em [seguranca.md](seguranca.md).

## Visão geral

```
┌───────────────────────── Cais (Electron) ─────────────────────────┐
│                                                                    │
│  renderer (React, sandbox)  ──window.cais──▶  preload              │
│                                                │ ipcRenderer       │
│                                                ▼                   │
│  main: ipc (zod) ─▶ SessionManager ─▶ Driver (mysql2) ─▶ MySQL     │
│        CatalogStore · ScriptStore · Settings · Seal · Vault        │
│        Trail · GcloudTokenProvider                                 │
│        AgentServer ─▶ AgentBroker ─▶ AgentSessions ─▶ Driver       │
│             ▲                                                      │
└─────────────┼──────────────────────────────────────────────────────┘
              │ socket local 0600 (uma linha JSON por mensagem)
        cais llm … (CLI no Node do sistema)
```

- **main** (`src/main`): o processo principal. Guarda segredos, abre conexões, decide políticas, grava arquivos e a Trilha. É o único lugar que fala com o banco e com o `gcloud`.
- **preload** (`src/preload`): expõe `window.cais` (o contrato `CaisApi` de `src/shared/ipc.ts`) por `contextBridge`. Repassa o código dos erros do IPC e lê o idioma escolhido pelo main.
- **renderer** (`src/renderer`): a interface em React, isolada e sem acesso ao Node.
- **shared** (`src/shared`): TypeScript puro, sem Node e sem DOM, usado pelos dois lados: modelo, resultados, contrato de IPC, dialetos, i18n, regras de texto, edição na grade.
- **cli** (`src/cli`): o comando `cais llm`, empacotado num arquivo só que roda no Node do sistema.

**Por que Electron:** o app precisa falar o protocolo do MySQL, chamar o `gcloud` local e usar um driver maduro (`mysql2`), o que um web app não faz; o custo é um app maior. **Por que CodeMirror 6:** o autocomplete de SQL com schema e apelidos vem pronto, e o editor é mais leve que o Monaco.

## Contratos agnósticos de motor

A interface não conhece o motor: tudo o que depende do banco vem de dois contratos, registrados por `engine`.

- **Dialeto** (`src/shared/dialects/types.ts`, MySQL em `src/shared/dialects/mysql`): `splitStatements` (comandos com posições no texto original, respeitando strings, crases, comentários e `DELIMITER`), `classify` (tipo, verbo, permitido em somente leitura, commit implícito, controle de transação, funções chamadas, comentário executável...), `warnings` (alertas do modal), `identifiers`, palavras-chave, `quoteIdent`, literais e `buildUpdate` para a edição na grade, e as regras de texto que só valem para SQL de agente. Roda nos dois lados: o renderer usa para achar o comando sob o cursor e realçar; o main **reclassifica** antes de executar.
- **Driver** (`src/main/drivers/types.ts`, MySQL em `src/main/drivers/mysql`): `open`, `introspect` (conexão curta própria) e `test`, e a `DbSession` com `applyMode`, `execute`, `cancel` (`KILL QUERY` por conexão de controle), `commit`, `rollback`, `currentDatabase`, `reset`, `applyLimits` e `onFatalError`. O driver MySQL usa `mysql2` com `multipleStatements: false`, `charset: 'utf8mb4'`, datas como texto, inteiros grandes como texto e binário como `{ kind: 'binary', hex, length }`.

Um motor novo é um dialeto e um driver registrados; a interface e as políticas não mudam.

## Processo principal

| Módulo | Papel |
|---|---|
| `index.ts` | Ciclo de vida do app e da janela, menu, trava de instância única, recusa de opções de depuração, ganchos de teste, notificações |
| `ipc.ts` | Handlers do IPC: só a janela principal, entrada validada com zod, erros traduzidos |
| `sessions.ts` | `SessionManager`: uma sessão por aba, modos, transação, confirmações, inatividade, linhas da Trilha da pessoa |
| `scheduler.ts` | Relógio injetável, usado pelas sessões da pessoa e dos agentes (os testes usam um relógio falso) |
| `auth/credentials.ts`, `auth/gcloud.ts` | Resolução de credencial e `GcloudTokenProvider` (com `spawn` injetável; só `auth list` e `sql generate-login-token`) |
| `drivers/` | Contrato e driver MySQL (conexão, sessão, introspecção, valores, erros) |
| `store/` | `CatalogStore`, `ScriptStore`, `SettingsStore`, `TabsStore`, `Seal`, `Vault` e a escrita atômica |
| `trail.ts` | A Trilha: um arquivo por dia, encadeamento, tetos, máscara de senha, listagem e conferência |
| `agents/` | Acesso de agentes: `server`, `broker`, `policy`, `sessions`, `access`, `audit`, `redact`, `errors` |
| `cli-install.ts` | "Instalar comando cais no terminal" (pastas recebidas por parâmetro, para os testes nunca tocarem a máquina) |
| `i18n.ts` | Resolve o idioma do main antes do menu |

## Arquivos na pasta de dados

Tudo fica em `app.getPath('userData')` (no macOS, `~/Library/Application Support/Cais`), gravado de forma atômica com permissão 0600. Um arquivo JSON inválido é guardado ao lado como `<nome>.corrupt-<data>.json` e o app abre vazio naquele ponto, com aviso.

| Arquivo | Conteúdo |
|---|---|
| `catalog.json` | Projetos, ambientes e credenciais (sem senha) |
| `secrets.json` | `{ [credentialId]: base64(senha cifrada pelo safeStorage) }` |
| `seal.json` | Chave de assinatura (cifrada pelo cofre), as assinaturas dos ambientes e do interruptor de agentes, e a lista de ambientes que esperam conferência |
| `settings.json` | `{ version: 1, agentAccess: boolean }`, desligado por padrão |
| `scripts.json` | Scripts salvos por projeto |
| `tabs.json` | Abas abertas (ambiente, texto, banco, script ligado) e a aba ativa |
| `trail/AAAA-MM-DD.jsonl` | A Trilha, um arquivo por dia (UTC), pasta 0700, 90 dias |
| `agent-endpoint.json` | `{ socket, pid, protocol }`, só com o acesso de agentes ligado |
| `agent.sock` | O socket dos agentes, só com o acesso ligado (veja [seguranca.md](seguranca.md#isolamento-do-canal-dos-agentes)) |

## IPC

`src/shared/ipc.ts` define o contrato `CaisApi` e os nomes dos canais. Cada chamada do renderer passa pelo preload, chega a um handler em `src/main/ipc.ts` que confere o remetente (só a janela principal), valida os argumentos com zod e devolve `{ ok, value }` ou `{ ok: false, error: { message, code } }`. Grupos:

- `catalog`: ler, salvar, renomear, duplicar e apagar projetos, ambientes e credenciais; contas do `gcloud`.
- `connection.test`: testar um rascunho de ambiente.
- `session`: abrir, conectar, desconectar, trocar modo, rodar, cancelar, commit, rollback, trocar banco, fechar, estado.
- `schema`: árvore de bancos, tabelas e colunas, com cache por ambiente.
- `tabs`, `scripts`, `trail`, `agents` (decisões da pessoa sobre pedidos e o interruptor) e `app` (a pessoa desistiu de sair com transações abertas).
- Eventos do main para o renderer: mudanças de sessão, pedidos de agentes, pedido para resolver transações antes de sair.

## Idioma (i18n)

- `src/shared/i18n/areas/<área>/{pt-BR,en}.ts`: um catálogo por área (menu, sidebar, sessionBar, grid, registry, agentsUi, trail, mainSessions, mainCatalog, dialect...). O `pt-BR` é a referência e o `en` é tipado pelo formato dele, então o `tsc` acusa chave faltando ou sobrando. Um valor é texto ou função `(params) => string`.
- `core.ts` tem números, datas e plural com `Intl`; `locale.ts` tem `resolveLocale`, `LOCALES` e `AGENT_LOCALE` (`pt-BR`, fixo).
- **Resolução:** o main chama `app.getPreferredSystemLanguages()` no `whenReady`, antes do menu, e passa o resultado ao renderer por `additionalArguments` (`--cais-locale=`). O preload confere contra a lista; o renderer nunca escolhe o idioma do main.
- **Duas audiências:** texto que serve à pessoa e ao agente (alertas do modal, `approval_reason`, `commit_reason`, erros de comando) circula como `MessageRef` (`{ key, params }`). A tela renderiza no idioma do app; a resposta ao agente renderiza em `AGENT_LOCALE`. O que só o agente lê (saída do CLI, `guide`, recusas da política) é escrito direto em português.
- O pacote declara `en` e `pt-BR` (`CFBundleLocalizations` e as pastas `.lproj` de `electronLanguages`), para o idioma por app do macOS funcionar.

## Acesso de agentes

- **`server.ts`** (`AgentServer`): `net.createServer` no socket ou named pipe, só com o acesso ligado. Uma linha JSON por mensagem (`{ id, method, params }` → `{ id, ok, result | error }`), até 1 MB, validada com zod. Grava e apaga o `agent-endpoint.json`.
- **`policy.ts`**: `decide()`, função pura que recebe o modo, a marcação de produção, o nível do ambiente, o estado da Trilha e os comandos classificados, e devolve rodar, pedir aprovação ou recusar com um código.
- **`broker.ts`** (`AgentBroker`): ciclo de vida dos pedidos, fila, expiração, liberações de 15 minutos, segunda decisão, commit automático e seus limites, as respostas ao agente (redigidas, em `AGENT_LOCALE`) e as linhas da Trilha.
- **`sessions.ts`** (`AgentSessions`): conexões próprias dos agentes. Leitura: até 3 sessões somente leitura por ambiente, zeradas entre pedidos e fechadas depois de 5 minutos ociosas. Escrita: uma sessão nova em modo Transação por pedido, fechada no fim. Metadados frescos para decidir o commit automático.
- **`access.ts`**: liga e desliga o acesso (servidor, pendentes, transações abertas, liberações). **`audit.ts`**: o lado do broker na Trilha (gravar uma linha e saber se ela foi gravada). **`redact.ts`**: a redação dos erros de conexão.

## CLI

- `src/cli/cais.ts` é a entrada; `args.ts` analisa os argumentos, `endpoint.ts` acha o socket (`CAIS_SOCKET` ou o `agent-endpoint.json` da pasta de dados), `client.ts` fala o protocolo, `exit.ts` mapeia códigos de saída, `output.ts` escreve JSON e trata `EPIPE` (saída fechada por `| head` não é erro) e `guide.ts` tem o texto do `cais llm guide`.
- `scripts/build-cli.mjs` empacota tudo em `out/cli/cais.mjs`: um arquivo, só módulos do Node (`node:*`), alvo Node 20, com shebang e permissão de execução.
- O CLI não tem dependências e não traz nada do Electron.

## Empacotamento

- `npm run build`: `electron-vite build` (saída em `out/main`, `out/preload`, `out/renderer`) e o CLI em `out/cli/cais.mjs`. A CSP do build é a restritiva; a do servidor de desenvolvimento libera o necessário para a recarga.
- `npm run dist`: electron-builder para macOS arm64 (`dmg` e `dir`), com:
  - `electronFuses`: `runAsNode` desligado, `enableCookieEncryption`, sem `NODE_OPTIONS`, sem argumentos de inspeção, `enableEmbeddedAsarIntegrityValidation` e `onlyLoadAppFromAsar`;
  - `afterSign: scripts/adhoc-sign.cjs`, que assina o `.app` ad-hoc (`codesign --sign -`) depois dos fuses, porque o Apple Silicon recusa binário com assinatura quebrada;
  - `extraResources`: o CLI vai em `Cais.app/Contents/Resources/cli/cais.mjs`, fora do asar, porque o Node do sistema não lê dentro dele;
  - `electronLanguages: en, pt_BR` e `CFBundleLocalizations: en, pt-BR`.
- Ícones: `build/icon.icns` e `build/icon.png` para o pacote; `resources/icon.png` para o Dock em desenvolvimento e o ícone da janela em Linux e Windows; `resources/logo-mark.png` para a marca no topo da barra lateral e no estado vazio.

## Testes

- `tests/unit`: Vitest sem Docker. Dialeto (separador, classificador), `SessionManager` com driver falso e relógio falso, `gcloud` com `spawn` falso, stores, assinatura, Trilha, política e broker de agentes, servidor do socket (socket real em pasta temporária), CLI, i18n, edição na grade.
- `tests/integration`: Vitest contra um `mysql:8.4` em container próprio `cais-test-*`, em porta aleatória, removido no fim. Cobre o driver, o Somente leitura no app e no servidor, a transação vista de uma segunda conexão, a edição na grade e o acesso de agentes ponta a ponta (ataques ao classificador, segredos, limites, níveis).
- `tests/e2e`: Playwright com `_electron`, abrindo o app de verdade com `userData` e socket temporários e o CLI real como processo filho.
- `tests/support`: o container de teste, o broker de agentes montado para testes e fixtures.
