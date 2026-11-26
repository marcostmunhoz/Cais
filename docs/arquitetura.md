# Arquitetura

Como o Cais é montado: processos, módulos, contratos, arquivos e empacotamento. As regras de produto estão em [comportamento.md](comportamento.md) e o modelo de segurança em [seguranca.md](seguranca.md).

## Visão geral

```
┌───────────────────────── Cais (Electron) ─────────────────────────┐
│                                                                    │
│  renderer (React, sandbox)  ──window.cais──▶  preload              │
│                                                │ ipcRenderer       │
│                                                ▼                   │
│  main: ipc (zod) ─▶ SessionManager ─▶ Driver ─┬▶ mysql2 ─▶ MySQL   │
│                                               └▶ REST ─▶ BigQuery  │
│        CatalogStore · ScriptStore · Settings · Seal · Vault        │
│        Trail · GcloudTokenProvider                                 │
│        AgentServer ─▶ AgentBroker ─▶ AgentSessions ─▶ Driver       │
│             ▲                                                      │
└─────────────┼──────────────────────────────────────────────────────┘
              │ socket local 0600 (uma linha JSON por mensagem)
        cais llm … (CLI no Node do sistema)
```

- **main** (`src/main`): o processo principal. Guarda segredos, abre conexões, decide políticas, grava arquivos e a Trilha. É o único lugar que fala com o banco, com a API do BigQuery e com o `gcloud`.
- **preload** (`src/preload`): expõe `window.cais` (o contrato `CaisApi` de `src/shared/ipc.ts`) por `contextBridge`. Repassa o código dos erros do IPC e lê o idioma escolhido pelo main.
- **renderer** (`src/renderer`): a interface em React, isolada e sem acesso ao Node.
- **shared** (`src/shared`): TypeScript puro, sem Node e sem DOM, usado pelos dois lados: modelo, resultados, contrato de IPC, dialetos, i18n, regras de texto, edição na grade.
- **cli** (`src/cli`): o comando `cais llm`, empacotado num arquivo só que roda no Node do sistema.

**Por que Electron:** o app precisa falar o protocolo do MySQL, chamar o `gcloud` local e usar um driver maduro (`mysql2`), o que um web app não faz; o custo é um app maior. **Por que CodeMirror 6:** o realce e as palavras-chave de SQL vêm prontos, e o editor é mais leve que o Monaco.

## Contratos agnósticos de motor

A interface não conhece o motor: tudo o que depende do banco vem de dois contratos, registrados por `engine`.

- **Dialeto** (`src/shared/dialects/types.ts`, MySQL em `src/shared/dialects/mysql`): `splitStatements` (comandos com posições no texto original, respeitando strings, crases, comentários e `DELIMITER`), `classify` (tipo, verbo, permitido em somente leitura, commit implícito, controle de transação, funções chamadas, comentário executável...), `warnings` (alertas do modal), `identifiers`, palavras-chave, `quoteIdent`, literais, `buildUpdate` e `buildUpdateLocated` (o mesmo UPDATE, com a posição de cada literal do `SET`, para o editor selecioná-los em Gerar UPDATE da célula) `buildDelete` (um DELETE pela chave inteira, sem LIMIT, em Excluir linha) e `buildInsert` (um INSERT de várias linhas, em Gerar INSERT) para a edição na grade, e as regras de texto que só valem para SQL de agente. Roda nos dois lados: o renderer usa para achar o comando sob o cursor e realçar; o main **reclassifica** antes de executar.
- **Capacidades** (`src/shared/engines.ts`, TypeScript puro): `capabilitiesOf(engine)` devolve `{ modes, gridEdit, lazyColumns, dryRun, syntaxCheck }`, porque o renderer também precisa saber o que o motor aceita e não enxerga o driver. O MySQL aceita os três modos e a edição na grade; o BigQuery só Somente leitura, sem edição, com colunas lidas por dataset (`lazyColumns`) com dry run (`dryRun`, que liga a confirmação de bytes e o dry run do broker) e sem verificação local de sintaxe (`syntaxCheck`, que o MySQL tem: liga o sublinhado de erro do editor). `initialModeFor` escolhe o modo de uma aba nova (Somente leitura em produção; fora dela, Auto-commit se o motor aceitar, senão o primeiro modo aceito). O `SessionManager` recusa, em `open()` e em `setMode()`, um modo que o motor não aceita (`mode-not-supported`); a `SessionBar` lista no seletor só os modos aceitos e, quando o motor aceita um só (`fixedModeOf(caps)`), mostra um selo fixo no lugar do seletor, sem citar o motor; `gridEditability` e `insertability` (as colunas e a chave de um Gerar INSERT, em `src/shared/grid.ts`) recusam com o motivo `grid.reason.engineNoEdit` quando `gridEdit` é falso. Os testes injetam um motor de capacidades restritas por `SessionDeps.capabilitiesOf`.
- **Alvo da conexão** (`connectionTargetKey` e `sameTarget`, em `src/shared/engines.ts`): o que identifica onde o ambiente se conecta (no MySQL, `host`, `port` e `credentialId`; no BigQuery, `gcpProject`, `maxBytesBilled` e `credentialId`). `changedForAgents` e a conferência do broker usam só essa função, então um motor novo acrescenta os campos dele num lugar só.
- **Regras de agente** (`Dialect.agentRules`): `systemSchemas`, `secretSchemas`, `deniedFunctions`, `writeVerbs`, `isValidDatabaseName(name)` e as mensagens de recusa ligadas a esquemas (`messages.systemSchemaWrite` e `messages.systemSchemaRead`, em português fixo, só para agentes). `decide()` recebe as regras em `DecideInput.rules` e o broker usa `isValidDatabaseName` para o `--database`; os valores e os textos do MySQL ficam no dialeto MySQL (`src/shared/dialects/mysql`). `Dialect.tablePreviewSql(database, table)` é o que o duplo clique numa tabela roda (no MySQL, `SELECT * FROM … LIMIT 100;`).
- **Driver** (`src/main/drivers/types.ts`, MySQL em `src/main/drivers/mysql`): `open`, `introspect(params, scope?)` (conexão curta própria; sem escopo, bancos e tabelas, e com `{ database }`, também as colunas daquele banco; o MySQL ignora o escopo e devolve tudo) e `test`, e a `DbSession` com `applyMode`, `execute(sql, { maxRows, stopAtCap?, maxBytesBilled?, refetch?, estimateCeiling? })` (o MySQL lê só os dois primeiros; `maxBytesBilled` é o teto do job, `refetch` lê mais páginas do mesmo job e `estimateCeiling` faz o driver recusar, sem cobrar, uma leitura cujo dry run passou do que foi aprovado: `bytes_over_approved`), `useDatabase(name)` (no MySQL, um `USE`; o `SessionManager` e `agents/sessions.ts` trocam de banco só por ele, e a Trilha grava a linha com o verbo do motor), `transactionProbe?()` (o `DO 0` do MySQL, para saber se a transação continua aberta depois de cancelar entre comandos; sem o método o `SessionManager` mantém o estado que tinha), `prepare?(sql, { signal? })` (opcional: o dry run, com o tipo que o servidor leu e os bytes estimados, e `errorInStatement` quando o servidor faltou o texto do comando e não o caminho até ele; o `SessionManager` o usa para recusar antes de sair, para a confirmação de bytes e para "Estimar ao digitar", e o broker de agentes para decidir; `signal` encerra o pedido que um mais novo substituiu), `cancel` (`KILL QUERY` por conexão de controle), `commit`, `rollback`, `currentDatabase`, `reset`, `applyLimits` e `onFatalError`. `StatementResult.stats?` leva `bytesProcessed`, `bytesBilled`, `bytesEstimated`, `cacheHit`, `jobId` e `reread` (uma releitura do mesmo job, que não conta bytes outra vez); o MySQL não preenche. O driver MySQL usa `mysql2` com `multipleStatements: false`, `charset: 'utf8mb4'`, datas como texto, inteiros grandes como texto e binário como `{ kind: 'binary', hex, length }`.

Um motor novo é um dialeto e um driver registrados; a interface e as políticas não mudam.

### Dialeto GoogleSQL

`src/shared/dialects/bigquery`: `lexer.ts` (nomes com e sem crase, nome de projeto com hífen num caminho, strings `'…'`, `"…"`, de três aspas e com prefixo `r`, `b`, `rb`, comentários `#`, `--` e `/* */`, parâmetros `@x` e `?`, variáveis de sistema `@@x`), `splitter.ts` (`;` fora de strings e comentários; `BEGIN … END`, `IF … END IF`, `LOOP`, `WHILE`, `REPEAT`, `FOR` e `CASE` ficam inteiros, para um script virar um comando só e ser recusado como script, não em pedaços), `classifier.ts` (só consulta passa no Somente leitura: `SELECT`, `WITH`, sintaxe pipe começando em `FROM`, consulta entre parênteses; o resto recebe o tipo pelo começo do comando), `keywords.ts` e `functions.ts` (a lista de funções nativas sem qualificador, para as regras de agente). A `Classification` tem campos só do BigQuery: `remoteCalls` (chamadas qualificadas fora dos prefixos embutidos, mais `ML.*` e `AI.*`), `externalQuery`, `jobsMetadata` (`INFORMATION_SCHEMA.JOBS*` e `SESSIONS*`) e `legacyDirective` (`#legacySQL`, `#standardSQL`). `Dialect.agentRules` tem também `isUnknownFunction` e `messages.jobsMetadata`; `codemirrorDialect` é `'GoogleSQL'`, `databaseTerm` é `dataset` (chave dos catálogos) e `valueKind` devolve `unsupported`. `quoteIdent` usa crase, com a crase e a barra invertida escapadas.

### Driver BigQuery

`src/main/drivers/bigquery`: REST em `https://bigquery.googleapis.com/bigquery/v2`, sem SDK.

- **`client.ts`:** `BigqueryClient`, com `fetch` e endereço injetáveis (no app, `net.fetch`: proxy e certificados do sistema; nos testes, o servidor falso). Respostas validadas com zod (inteiros de 64 bits chegam como texto), `Authorization: Bearer` com o token do `refresh()` e uma nova tentativa com token novo no 401. Falha de rede vira "Sem resposta de bigquery.googleapis.com".
- **`session.ts`:** `BigquerySession`, sem estado no servidor. O dataset atual fica na memória. Um comando é: dry run (`jobs.insert` com `configuration.dryRun`, `useLegacySql: false`, `defaultDataset`; só esse caminho traz `referencedRoutines`, que o `prepare` devolve como `routines`, `dataset.rotina` sem projeto), recusa se o tipo não é `SELECT`, `jobs.query` com `maximumBytesBilled`, `jobTimeoutMs` (nos pedidos de agente), `requestId`, o rótulo `cais: person|agent` e `useInt64Timestamp`, e páginas de `jobs.getQueryResults` até o teto de linhas (estatísticas finais de `jobs.get`, porque o `getQueryResults` não traz os bytes faturados). O job do último resultado fica guardado para o "Buscar até 50.000" (`refetch`); sem ele, o resultado vem como `RESULT_EXPIRED`. `cancel` usa `jobs.cancel` (com a localização do job), e `close` cancela o job em andamento.
- **`introspect.ts`:** `datasets.list`, `tables.list` e, com `{ database }`, `tables.get` de cada tabela (concorrência limitada) para as colunas.
- **`values.ts`:** conversão dos valores e o texto do tipo (`STRUCT<…>`, `ARRAY<…>`, `NUMERIC(p, s)`). **`errors.ts`:** os `reason` do BigQuery e os códigos HTTP viram mensagens dos catálogos, com a dica de papel.
- **`index.ts`:** o driver (`open`, `introspect`, `test`) e o `configureDrivers` do registro, que ajusta o transporte na partida.
- **Credencial:** `resolveCredential` recebe o motor; o BigQuery exige `gcloud-iam` e pede o token a `GcloudTokenProvider.getAccessToken(account, sa)`, com cache próprio de 50 minutos. `ConnectParams` do BigQuery leva o projeto, o token, `refresh()`, o limite de bytes e a origem (`person` ou `agent`).

### Custo e agentes

O `SessionManager` chama `prepare` por comando, compara a estimativa com o limite do ambiente e devolve `needsConfirmation` com `reason: 'bytes'`; o pedido confirmado volta com `confirmedBytes` por texto de comando, que vira o `maximumBytesBilled` do job. O `AgentExecutor.prepare` faz um dry run por comando na conexão de leitura do agente (só quando o motor tem `dryRun`: o MySQL não abre nem manda nada a mais), e o broker usa as rotinas do dry run (aprovação em qualquer nível, motivo `remoteFunction` com o primeiro `dataset.rotina`) e a estimativa para os 10 GiB fixos (`AGENT_BYTES_APPROVAL`), para o teto do job (o limiar, ou a estimativa arredondada ao GiB quando a pessoa aprovou por causa dos bytes) e para a aprovação por chamada de função. As linhas da Trilha levam `jobId`, `bytesEstimated` e `bytesBilled` por comando; na linha do pedido, os bytes somados e o `jobId` só quando houve um job.

**Estimar ao digitar.** O canal `session:estimate` (`tabId`, texto de um comando) chama `SessionManager.estimate`, que só age com `SessionDeps.estimateEnabled()` ligado (vem de `settings.json`), com a aba conectada, com `capabilitiesOf(engine).dryRun` e com exatamente um comando; reclassifica pelo dialeto, chama `prepare(texto, { signal })` e responde `EstimateResponse` (`ok` com bytes, `error` com `inStatement`, `refused`, `skipped` com o motivo). Um pedido novo da mesma aba aborta o anterior. Não toca o estado da aba nem o relógio de inatividade e não escreve na Trilha. No renderer, `lib/estimate.ts` decide quando perguntar, guarda as respostas (por ambiente, dataset e texto, 2 minutos) e descarta a resposta de um texto que já foi trocado; `lib/estimateLint.ts` é um `linter` do `@codemirror/lint` (800 ms de pausa, também ao mudar o cursor de comando e por um efeito quando o interruptor liga ou a aba conecta) que escolhe o comando como o "Rodar" e devolve o erro do servidor como diagnóstico, na palavra de `errorSpan` (`src/shared/estimate.ts`). O editor só instala esse linter quando o motor tem `dryRun`. O estado (`estimateAsYouType`, `estimates` por aba) fica no store e a barra de status o mostra.

**O modelo por motor.** `Environment` é uma união discriminada por `engine`: o MySQL guarda `host` e `port`; o BigQuery guarda `gcpProject` e `maxBytesBilled?` (bytes; ausente é sem limite), e não tem host nem porta. `ConnectParams` segue a mesma divisão, e `connectParamsFor` (`auth/credentials.ts`) monta os parâmetros de um ambiente ou de um rascunho, com a origem (`person` ou `agent`) que vira o rótulo `cais` dos jobs do BigQuery. As capacidades do motor (modos aceitos, edição na grade) ficam em `src/shared/engines.ts`: o BigQuery só tem Somente leitura. Ganchos de teste do BigQuery, só no app não empacotado: `CAIS_BIGQUERY_URL` (endereço da API) e, com `CAIS_E2E=1`, um token falso fixo no lugar do `gcloud`. A verificação de versão tem o seu: `CAIS_RELEASES_URL` (endereço da API de releases) e, com `CAIS_E2E=1` e sem ele, a verificação falha na hora, sem rede.

## Editor

O editor (`src/renderer/components/Editor.tsx`) junta o `lang-sql` (realce e palavras-chave) com três peças próprias, e nenhuma conhece o motor: o que depende dele vem do dialeto e das capacidades.

- **Escopo do comando** (`src/shared/dialects/scope.ts`, TypeScript puro; `Dialect.analyze(texto)`): lê as palavras, os nomes entre aspas e a pontuação do comando com o lexer do motor (`mysql/scope.ts` usa o `tokenize` do classificador; `bigquery/scope.ts` usa o `lex` do GoogleSQL e separa o caminho entre crases) e devolve os blocos de consulta, com as tabelas do `FROM`, do `JOIN`, do alvo de `UPDATE`, `DELETE ... USING` e `INSERT INTO` e o apelido de cada uma. `tablesAt(análise, posição)` diz o que a posição enxerga (a subquery enxerga a consulta em volta; tabela derivada e corpo de CTE não; cada braço de `UNION` é à parte) e `completionContext` diz o que se digita (nome, qualificador antes do ponto, aspas abertas) e o que a posição espera (`table`, `column` ou `any`). Lê por tokens e não por árvore de gramática, de propósito: o comando que se digita quase sempre está incompleto, e uma gramática desiste nele. Cada motor só entrega os tokens e a regra de decodificar um nome entre aspas.
- **Candidatos** (`src/shared/completion.ts`, puro): a partir do schema, do banco atual, da análise e da posição, devolve as opções (coluna, tabela, view, banco, apelido) com detalhe e peso. A cola com o CodeMirror (`src/renderer/lib/completion.ts`) acha o comando sob o cursor, escolhe as aspas e registra a fonte como dado de linguagem do SQL; o `sql()` não recebe mais o `schema`, para o `lang-sql` não oferecer os mesmos nomes de novo. A fonte não importa i18n nem DOM (as palavras do detalhe chegam por parâmetro), e os testes rodam num `EditorState`.
- **Colunas sob demanda** (`src/renderer/lib/datasets.ts`): nos motores com `lazyColumns`, uma pausa na digitação dispara `loadDatasetColumns` para os datasets que o comando sob o cursor cita, pelo canal `schema:get` com escopo que a árvore já usa. Sem canal novo.
- **Sintaxe** (`src/renderer/lib/syntax/`): `mysql.ts` passa o comando pela gramática MySQL do `dt-sql-parser` e devolve o primeiro erro (e decide o que não perguntar à gramática); `worker.ts` roda isso num Web Worker de módulo (`new Worker(new URL('./worker.ts', import.meta.url))`, que o Vite empacota num arquivo à parte de cerca de 3,7 MB, carregado só no primeiro comando; a CSP `script-src 'self'` o permite, porque o `worker-src` cai nela); `client.ts` é o lado da página (cache dos últimos 300 comandos, uma fila de um comando por vez com o tempo limite contado a partir de quando o worker começa nele, o descarte do que um passe mais novo tornou velho, o reinício do worker que não responde, e um worker que não sobe ou falha vira "sem erro" e nunca um erro na página); `lint.ts` monta o `linter` do `@codemirror/lint` sobre o comando do cursor e os que estão na tela, entre os que o dialeto separa; `index.ts` diz quais motores têm verificação (`syntaxCheck`). O `dt-sql-parser` (e o `antlr4ng` e o `antlr4-c3` que ele traz) são dependências de desenvolvimento, empacotadas no worker.

## Processo principal

| Módulo | Papel |
|---|---|
| `index.ts` | Ciclo de vida do app e da janela, menu (Sobre no menu do app no macOS e em Ajuda no Linux), trava de instância única, recusa de opções de depuração, ganchos de teste, notificações |
| `ipc.ts` | Handlers do IPC: só a janela principal, entrada validada com zod, erros traduzidos |
| `sessions.ts` | `SessionManager`: uma sessão por aba, modos, transação, confirmações, inatividade, linhas da Trilha da pessoa |
| `scheduler.ts` | Relógio injetável, usado pelas sessões da pessoa e dos agentes (os testes usam um relógio falso) |
| `auth/credentials.ts`, `auth/gcloud.ts` | Resolução de credencial e `GcloudTokenProvider` (com `spawn` injetável; só `auth list`, `sql generate-login-token` e `auth print-access-token`) |
| `drivers/` | Contrato (`ConnectParams` por motor, `DbSession`, `Driver`) e os drivers. `drivers/mysql`: conexão, sessão, introspecção, valores, erros. `drivers/bigquery`: cliente REST (`client.ts`, `fetch` e endereço injetáveis; no app, `net.fetch`), sessão sem estado no servidor (`session.ts`), valores, erros, introspecção por `datasets.list`, `tables.list` e `tables.get` (veja [Driver BigQuery](#driver-bigquery)). `registry.ts` entrega o driver do motor, e `configureDrivers` ajusta o transporte do BigQuery na partida |
| `store/` | `CatalogStore`, `ScriptStore`, `SettingsStore`, `TabsStore`, `Seal`, `Vault` e a escrita atômica |
| `trail.ts` | A Trilha: um arquivo por dia, encadeamento, tetos, máscara de senha, listagem e conferência |
| `agents/` | Acesso de agentes: `server`, `broker`, `policy`, `sessions`, `access`, `audit`, `redact`, `errors` |
| `updates.ts` | `ReleaseChecker`: a verificação de versão da janela Sobre (um `GET` à API de releases do GitHub, só sob clique), com `fetch`, endereço e relógio injetáveis, validação com zod, cache de 1 hora e as páginas fixas que o app abre no navegador (`linkUrl`) |
| `cli-install.ts` | "Instalar comando cais no terminal" (pastas recebidas por parâmetro, para os testes nunca tocarem a máquina) |
| `i18n.ts` | Resolve o idioma do main antes do menu |

## Arquivos na pasta de dados

Tudo fica em `app.getPath('userData')` (no macOS, `~/Library/Application Support/Cais`; no Linux, `${XDG_CONFIG_HOME:-~/.config}/Cais`), gravado de forma atômica com permissão 0600. Um arquivo JSON inválido é guardado ao lado como `<nome>.corrupt-<data>.json` e o app abre vazio naquele ponto, com aviso.

| Arquivo | Conteúdo |
|---|---|
| `catalog.json` | Projetos, ambientes e credenciais (sem senha) |
| `secrets.json` | `{ [credentialId]: base64(senha cifrada pelo safeStorage) }` |
| `seal.json` | Chave de assinatura (cifrada pelo cofre), as assinaturas dos ambientes e do interruptor de agentes, e a lista de ambientes que esperam conferência |
| `settings.json` | `{ version: 1, agentAccess: boolean, estimateAsYouType?: boolean }`, os dois desligados por padrão; só `agentAccess` entra no selo |
| `scripts.json` | Scripts salvos por projeto |
| `tabs.json` | Abas abertas (ambiente, texto, banco, script ligado) e a aba ativa |
| `trail/AAAA-MM-DD.jsonl` | A Trilha, um arquivo por dia (UTC), pasta 0700, 90 dias |
| `agent-endpoint.json` | `{ socket, pid, protocol }`, só com o acesso de agentes ligado |
| `agent.sock` | O socket dos agentes, só com o acesso ligado (veja [seguranca.md](seguranca.md#isolamento-do-canal-dos-agentes)) |

## IPC

`src/shared/ipc.ts` define o contrato `CaisApi` e os nomes dos canais. Cada chamada do renderer passa pelo preload, chega a um handler em `src/main/ipc.ts` que confere o remetente (só a janela principal), valida os argumentos com zod e devolve `{ ok, value }` ou `{ ok: false, error: { message, code } }`. Grupos:

- `catalog`: ler, salvar, renomear, duplicar e apagar projetos, ambientes e credenciais; contas do `gcloud`.
- `connection.test`: testar um rascunho de ambiente.
- `session`: abrir, conectar, desconectar, trocar modo, rodar, cancelar, commit, rollback, trocar banco, fechar, estado e `estimate` (o dry run do comando que está sendo escrito, só com o interruptor ligado).
- `settings`: ler as preferências da pessoa e ligar ou desligar "Estimar ao digitar" (o acesso de agentes tem os seus canais em `agents`).
- `schema`: árvore de bancos, tabelas e colunas, com cache por ambiente.
- `tabs`, `scripts`, `trail`, `agents` (decisões da pessoa sobre pedidos e o interruptor) e `app`: `app:quitCancelled` (a pessoa desistiu de sair com transações abertas), `app:about` (versões do app e do runtime para a janela Sobre), `app:checkLatest` (a verificação de versão, sem argumentos; só quando a pessoa clica) e `app:openLink` (abre no navegador uma de três páginas fixas, por nome: `repository`, `releases` ou `release`; o endereço é montado no main, veja [seguranca.md](seguranca.md#processo-principal-e-renderer)).
- Eventos do main para o renderer: mudanças de sessão, pedidos de agentes, pedido para resolver transações antes de sair e `event:openAbout` (o item Sobre do menu pede a janela, que é um diálogo do renderer: `AboutDialog`, em `components/About.tsx`).

## Idioma (i18n)

- `src/shared/i18n/areas/<área>/{pt-BR,en}.ts`: um catálogo por área (menu, sidebar, sessionBar, grid, registry, agentsUi, trail, mainSessions, mainCatalog, dialect...). O `pt-BR` é a referência e o `en` é tipado pelo formato dele, então o `tsc` acusa chave faltando ou sobrando. Um valor é texto ou função `(params) => string`.
- `core.ts` tem números, datas e plural com `Intl`; `locale.ts` tem `resolveLocale`, `LOCALES` e `AGENT_LOCALE` (`pt-BR`, fixo).
- **Resolução:** o main chama `app.getPreferredSystemLanguages()` no `whenReady`, antes do menu, e passa o resultado ao renderer por `additionalArguments` (`--cais-locale=`). O preload confere contra a lista; o renderer nunca escolhe o idioma do main.
- **Duas audiências:** texto que serve à pessoa e ao agente (alertas do modal, `approval_reason`, `commit_reason`, erros de comando) circula como `MessageRef` (`{ key, params }`). A tela renderiza no idioma do app; a resposta ao agente renderiza em `AGENT_LOCALE`. O que só o agente lê (saída do CLI, `guide`, recusas da política) é escrito direto em português.
- O pacote declara `en` e `pt-BR` (`CFBundleLocalizations` e as pastas `.lproj` de `electronLanguages`), para o idioma por app do macOS funcionar. No Linux, `getPreferredSystemLanguages()` lê o ambiente da sessão (`LANGUAGE`, `LANG`).

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
- `npm run dist`: `build` e `electron-builder --publish never`, que gera os alvos do sistema em que roda: macOS arm64 (`dmg` e `dir`) ou Linux x64 (`deb`). Nos dois, com `electronFuses`: `runAsNode` desligado, `enableCookieEncryption`, sem `NODE_OPTIONS`, sem argumentos de inspeção, `enableEmbeddedAsarIntegrityValidation` e `onlyLoadAppFromAsar`. O script `dist` roda com `umask 022` para o pacote não herdar permissão de escrita de grupo. No macOS, ainda:
  - `afterSign: scripts/adhoc-sign.cjs`, que assina o `.app` ad-hoc (`codesign --sign -`) depois dos fuses, porque o Apple Silicon recusa binário com assinatura quebrada;
  - `extraResources`: o CLI vai em `Cais.app/Contents/Resources/cli/cais.mjs`, fora do asar, porque o Node do sistema não lê dentro dele;
  - `electronLanguages: en, pt_BR` e `CFBundleLocalizations: en, pt-BR`.
- **Linux (`build.linux`, deb x64):** executável `cais-app` (instalado em `/opt/Cais`, com link em `/usr/bin` pelo `postinst`), entrada `cais-app.desktop` (categorias `Development;Database;`) e ícone `build/icon.png`. As dependências padrão do electron-builder já incluem `libsecret-1-0`, que o cofre pede. O CLI vai em `/opt/Cais/resources/cli/cais.mjs` (`extraResources`); o comando `cais` não vem no pacote e é instalado pelo app em `~/.local/bin`. O `postinst` ajusta o `chrome-sandbox` (setuid 4755 só quando user namespaces não estão disponíveis, senão 0755) e, com o AppArmor ligado, instala o perfil `cais-app` se o `apparmor_parser` o aceitar. Os fuses valem também no Linux (conferidos com `@electron/fuses read`); só a assinatura ad-hoc (`afterSign`) é do macOS.
- **CI e release** (`.github/workflows`): `ci.yml` roda `npm run check` no Linux (com `xvfb-run`) a cada push em qualquer branch. `release.yml`, disparado por uma tag `vX.Y.Z`, confere a tag contra o `package.json`, reusa o `ci.yml`, gera o deb no Linux e o dmg no macOS (`macos-15`, arm64, assinatura ad-hoc) e publica a GitHub Release com o `SHA256SUMS.txt`. O processo de versão está em AGENTS.md.
- Ícones: `build/icon.icns` e `build/icon.png` para o pacote; `resources/icon.png` para o Dock em desenvolvimento e o ícone da janela em Linux e Windows; `resources/logo-mark.png` para a marca no topo da barra lateral e no estado vazio.

## Testes

- `tests/unit`: Vitest sem Docker. Dialeto (separador, classificador), `SessionManager` com driver falso e relógio falso, `gcloud` com `spawn` falso, stores, assinatura, Trilha, política e broker de agentes, servidor do socket (socket real em pasta temporária), CLI, i18n, edição na grade, o escopo do comando e o autocomplete (num `EditorState`, sem DOM) e a verificação de sintaxe (a gramática de verdade, com um corpus de SQL válido e um de SQL errado em `tests/support/mysql-corpus.ts`). O Vitest lê o `dt-sql-parser` por `server.deps.inline`: o pacote entrega módulos ES sem extensão nos imports e sem `"type": "module"`, que o bundler lê e o Node não.
- `tests/integration`: Vitest contra um `mysql:8.4` em container próprio `cais-test-*`, em porta aleatória, removido no fim. Cobre o driver, o Somente leitura no app e no servidor, a transação vista de uma segunda conexão, a edição na grade, o acesso de agentes ponta a ponta (ataques ao classificador, segredos, limites, níveis) e o corpus da verificação de sintaxe (`PREPARE` lê cada comando sem rodá-lo: o servidor aceita todos os do corpus válido e recusa como erro de sintaxe os do corpus errado). Os arquivos `bigquery*.test.ts` e `agents-bigquery.test.ts` não usam Docker: falam com o servidor falso do BigQuery.
- `tests/live`: a suíte ao vivo do BigQuery (`npm run live:bigquery`), opcional e fora do `npm run check`. Precisa de `CAIS_BQ_LIVE_PROJECT` e `CAIS_BQ_LIVE_TOKEN` (o token vem do ambiente: a suíte nunca roda o `gcloud`), pula tudo sem eles e só lê: dry runs e consultas sem tabela (0 bytes), metadados e um cancelamento; o `SELECT` na tabela pública só roda com teto de 1 byte e é recusado sem cobrança. Confere que o que o classificador deixa passar o servidor lê como `SELECT`; `CAIS_BQ_LIVE_ROUTINE` e `CAIS_BQ_LIVE_VIEW` ligam o teste das rotinas no dry run.
- `tests/e2e`: Playwright com `_electron`, abrindo o app de verdade com `userData` e socket temporários e o CLI real como processo filho.
- `tests/support`: o container de teste, o broker de agentes montado para testes, fixtures e `bigquery-fake.ts`, o servidor falso do BigQuery: HTTP em `127.0.0.1`, porta aleatória, com o subconjunto da API que o Cais usa (`jobs.insert` com dry run de tipo, bytes e rotinas configuráveis, `jobs.query`, `getQueryResults` com páginas, `jobs.cancel`, `jobs.get`, datasets e tabelas) e ganchos para erro por comando, job lento, job que expira e token inválido. Não há emulador: o do projeto da comunidade não tem sessões nem boa parte do `INFORMATION_SCHEMA`, e o dry run é o centro do Somente leitura; o falso cobre o contrato e a suíte ao vivo cobre o servidor de verdade.
