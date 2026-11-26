# AGENTS.md — Cais

Cliente SQL de desktop (Electron + React + TypeScript), organizado por projeto e ambiente. MySQL primeiro e BigQuery só leitura, com o motor isolado por contratos de driver e de dialeto; login IAM no Cloud SQL via `gcloud`; acesso de agentes de IA pelo CLI `cais llm`, com aprovação no app.

Antes de mudar comportamento, leia [docs/comportamento.md](docs/comportamento.md) (o que o produto faz e por quê) e [docs/seguranca.md](docs/seguranca.md) (o modelo de segurança). A arquitetura está em [docs/arquitetura.md](docs/arquitetura.md) e o contrato do CLI em [docs/agentes.md](docs/agentes.md).

## Mapa do código

| Pasta | O que tem |
|---|---|
| `src/main` | Processo principal: ciclo de vida, IPC (`ipc.ts`), sessões da pessoa (`sessions.ts`), drivers (`drivers/mysql`, `drivers/bigquery`), credenciais e `gcloud` (`auth/`), arquivos e cofre (`store/`), Trilha (`trail.ts`), acesso de agentes (`agents/`) |
| `src/preload` | A ponte `window.cais` (contrato `CaisApi`) |
| `src/renderer` | Interface em React (`components/`, `lib/`) |
| `src/shared` | TypeScript puro usado pelos dois lados: modelo, resultados, contrato de IPC, dialetos (`dialects/mysql`, `dialects/bigquery`), capacidades por motor (`engines.ts`), i18n (`i18n/`), regras de texto, edição na grade |
| `src/cli` | O comando `cais llm` (sem dependências, empacotado por `scripts/build-cli.mjs`) |
| `tests` | `unit`, `integration` (MySQL em container; BigQuery em servidor falso, sem Docker), `e2e` (Playwright com Electron), `live` (BigQuery de verdade, opcional), `support` |
| `scripts` | Empacotamento do CLI e assinatura ad-hoc do app (`afterSign`) |
| `skills/cais` | Skill para agentes usarem o CLI |
| `docs` | Documentação do produto, da segurança, da arquitetura e do CLI |

## Invariantes

- **Segredo nunca sai do processo principal** em texto puro e nunca vai para log. A senha entra pelo IPC só ao salvar e nunca volta ao renderer. Agentes nunca recebem senha, token, host nem id de credencial, nem o projeto do Google Cloud e e-mails de conta (BigQuery).
- **O processo principal nunca confia no renderer:** todo canal de IPC valida a entrada com zod, só aceita a janela principal, e o SQL é reclassificado pelo dialeto antes de executar.
- **A interface não conhece o motor:** dialeto, classificação de comandos e introspecção vêm de `src/shared/dialects` e `src/main/drivers`.
- **O app nunca altera o `gcloud`:** só três comandos, todos de leitura: `gcloud auth list`, `gcloud sql generate-login-token` e `gcloud auth print-access-token` (token do BigQuery, com cache próprio de 50 minutos).
- **Toda requisição de agente é reclassificada no main** (`src/main/agents/policy.ts`). Agente não aprova, não liga o acesso, não muda o nível de um ambiente e não edita nem apaga script. O socket só existe com o acesso ligado (`settings.json`, desligado por padrão). Em produção, escrita de agente sempre pede aprovação. Nada de agente roda sem a Trilha.
- **Somente leitura em duas camadas:** a lista do app e, no servidor, `READ ONLY` (MySQL) ou o dry run que só deixa passar `SELECT` (BigQuery, repetido dentro de `BigquerySession.execute`). No classificador, na dúvida, recusa.
- **Custo no BigQuery:** leitura de agente estimada acima de 10 GiB (`AGENT_BYTES_APPROVAL`, fixo, somando o pedido) ou do limite do ambiente, se menor, espera a pessoa em qualquer nível, e todo job de agente leva `maximumBytesBilled`. O dry run vai por `jobs.insert` e leitura de agente que usa qualquer rotina (`referencedRoutines`; por dentro de uma view, ainda não conferido contra o servidor real: `docs/seguranca.md`) espera a pessoa em qualquer nível.
- **Linux:** o cofre só vale com chaveiro de verdade (Secret Service; `basic_text` e `unknown` são recusados em `SafeStorageVault`). Os textos de atalho mostrados na interface saem de `src/shared/shortcuts.ts` (símbolos no macOS, Ctrl+… nos outros), nunca fixos no componente; o tratamento das teclas fica em `App.tsx` (`useGlobalShortcuts`) e deve bater com esses textos. O socket dos agentes cai em `$XDG_RUNTIME_DIR` quando o caminho padrão passa de 100 bytes. O deb instala o executável `cais-app` em `/opt/Cais`.
- **Poucas opções:** nada de opção de configuração sem o motivo registrado em `docs/comportamento.md`.
- **Idioma:** a interface segue o idioma do sistema, em pt-BR ou inglês. Todo texto que a pessoa vê sai dos catálogos de `src/shared/i18n/areas` (os dois idiomas, mesma chave), nunca escrito direto no componente. O que vai para agentes (saída do CLI, `guide`, respostas do broker) fica em português, fixo. Sem exclamação; termos do ofício como se fala (commit, rollback, schema, query).
- **Rede:** só o processo principal sai da máquina (bancos, `bigquery.googleapis.com`, o subprocesso `gcloud` e, só quando a pessoa clica em Verificar na janela Sobre, `api.github.com`; lista completa em `docs/seguranca.md`). O que abre no navegador é fixo e montado no main (`app:openLink` recebe um nome, nunca um endereço). Nenhuma verificação roda sozinha.
- **O Cais roda uma instância por usuário** (`requestSingleInstanceLock`) e recusa abrir com opções de depuração remota (`--inspect*`, `--remote-debugging-*`), menos no gancho de e2e. O DevTools só existe fora do pacote.

## Convenções

- TypeScript `strict`; código, identificadores e comentários em inglês. A documentação em `docs/` e o README ficam em português.
- Dependências com versão exata (sem `^`), `package-lock.json` versionado.
- O lockfile muda conforme a versão do npm: usar npm 11.x nas duas máquinas. Scripts de instalação de dependências precisam estar no `allowScripts` do `package.json` (`npm install-scripts ls` tem de ficar sem pendências).
- `src/shared` é TypeScript puro: sem Node, sem DOM.
- `vitest` fica na 4.x (a 5.x exige Node 22). O `typescript` está na 7.x: sem `baseUrl`, os aliases usam `paths` com `./`.
- A CSP mantém `style-src 'unsafe-inline'` porque o CodeMirror injeta estilos.

## Comandos

Todos rodam na raiz do projeto, com Node 20.19 ou mais novo e npm.

| Comando | O que faz |
|---|---|
| `npm install` | Instala as dependências (versões exatas). |
| `npm run dev` | Abre o app em desenvolvimento (electron-vite, com recarga). |
| `npm run typecheck` | `tsc` estrito nos dois projetos (`tsconfig.node.json` e `tsconfig.web.json`). |
| `npm run unit` | Vitest sem Docker: dialeto, sessões (driver e relógio falsos), `gcloud` (spawn falso), stores, assinatura, Trilha, política e broker de agentes, servidor do socket (socket real em pasta temporária), CLI, i18n, edição na grade. |
| `npm run integration` | Vitest contra um `mysql:8.4` em container próprio `cais-test-*`, porta aleatória, removido no fim (inclui o acesso de agentes ponta a ponta). Precisa do Docker. |
| `npm run build` | `electron-vite build` (saída em `out/`) e `scripts/build-cli.mjs`, que empacota o CLI em `out/cli/cais.mjs` (um arquivo, só módulos do Node, executável). |
| `npm run e2e` | Playwright `_electron`: abre janelas de verdade com `userData` e socket temporários, sobe o próprio container `cais-test-*`, roda o CLI real como processo filho e regrava as capturas em `tests/e2e/screenshots/`. Precisa de `npm run build` antes e do Docker. |
| `npm run check` | `typecheck && unit && integration && build && e2e`. É o que precisa estar verde para commitar. |
| `npm run live:bigquery` | Suíte ao vivo opcional contra um projeto BigQuery sandbox, fora do `npm run check`. Precisa de `CAIS_BQ_LIVE_PROJECT` e `CAIS_BQ_LIVE_TOKEN` (o token é o do próprio `gcloud auth print-access-token`, que você roda); opcionais: `CAIS_BQ_LIVE_DATASET`, `CAIS_BQ_LIVE_ROUTINE` (função escalar persistente de um INT64, `dataset.rotina`) e `CAIS_BQ_LIVE_VIEW` (`dataset.view` que chama essa rotina). Pula tudo sem as duas primeiras, só lê: dry runs e consultas sem tabela (0 bytes), metadados e um cancelamento; o SELECT na tabela pública só roda com teto de 1 byte e é recusado sem cobrança. Nunca roda o `gcloud`; o cabeçalho de `tests/live/bigquery.test.ts` tem o passo a passo. Confere o que o servidor diz de cada classe de comando (o `statementType` do dry run) contra o classificador. |
| `npm run cli -- llm envs` | Recompila o CLI e roda `cais llm …`. Precisa do Cais aberto (`npm run dev`) com o acesso de agentes ligado. |
| `npm run dist` | `build` + electron-builder, que gera os alvos do sistema em que roda. macOS: `dist/Cais-<versão>-arm64.dmg` e `dist/mac-arm64/Cais.app`. Linux: `dist/cais_<versão>_amd64.deb` (x64, executável `cais-app`, CLI em `/opt/Cais/resources/cli/cais.mjs`). Nos dois, com Electron fuses endurecidos (`electronFuses`) e `umask 022`; no macOS, também assinatura ad-hoc local (`scripts/adhoc-sign.cjs`, hook `afterSign`). O CLI vai em `Cais.app/Contents/Resources/cli/cais.mjs` (`extraResources`: o Node do sistema não lê dentro do asar) e roda no Node do sistema, não pelo Electron (o fuse `runAsNode` fica desligado). |

## Versões e releases

- Uma release se faz assim: `npm version x.y.z` (cria o commit `chore(release): x.y.z` e a tag `vx.y.z`, pelo `.npmrc`) e depois `git push --follow-tags`. O workflow `release.yml` confere que a tag bate com a versão do `package.json`, roda o `npm run check`, gera o deb (Linux) e o dmg (macOS arm64, assinatura ad-hoc) e publica a GitHub Release com os dois arquivos e o `SHA256SUMS.txt`.
- Tag e release são feitas só pela pessoa, nunca por um agente, a menos que ela peça.
- O CI (`ci.yml`) roda `npm run check` no Linux a cada push em qualquer branch, e o resultado aparece no pull request. O macOS só roda na release, porque os minutos dele custam 10 vezes mais.
- As actions ficam fixadas por SHA completo, com a versão num comentário. Só `actions/*`, e o único segredo é o `github.token`.

## Testes

- **Ganchos de teste** só valem com `!app.isPackaged`; o app empacotado os ignora:
  - `CAIS_E2E=1`: cofre falso (sem Keychain), o `userData` de `CAIS_USER_DATA` e aceita as opções de depuração (o Playwright as usa);
  - `CAIS_SOCKET`: caminho do socket dos agentes (o CLI também o lê);
  - `CAIS_LOCALE` = `pt-BR` | `en`: o e2e fixa `pt-BR` por padrão e usa `en` só no teste de idioma;
  - `CAIS_IDLE_MS`: inteiro de 100 ms ou mais, encurta a desconexão por inatividade;
  - `CAIS_BIGQUERY_URL`: troca o endereço da API do BigQuery pelo do servidor falso;
  - `CAIS_RELEASES_URL`: troca o endereço da API de releases do GitHub (verificação de versão da janela Sobre) pelo de um servidor falso; com `CAIS_E2E=1` e sem ele, a verificação responde "não foi possível" sem sair para a rede;
  - com `CAIS_E2E=1`, o token do BigQuery é um valor falso fixo (`cais-test-access-token`) e a lista de contas do `gcloud` é uma conta falsa fixa (`ana@exemplo.com`): o e2e nunca roda o `gcloud`.
- **Banco:** os testes usam só o próprio container `cais-test-*`, em porta aleatória. Nunca a porta 3306 (para não colidir com um MySQL local), nunca outro container, nunca um banco real. Se um teste travar e deixar container para trás: `docker ps -a --filter name=cais-test-` e `docker rm -f` neles.
- **`gcloud`:** nunca rodar o `gcloud` de verdade nos testes. Eles usam um `gcloud` falso (`spawn` injetável).
- **BigQuery:** os testes nunca falam com o Google. O driver recebe `fetch` e endereço injetáveis, e `tests/support/bigquery-fake.ts` é um servidor HTTP local (porta aleatória) com o subconjunto da API que o Cais usa, com o tipo do dry run, os bytes, os erros e a lentidão configuráveis por teste. Os ganchos `CAIS_BIGQUERY_URL` e o token e a conta falsos do e2e estão na lista acima. A suíte ao vivo, `npm run live:bigquery` (`tests/live/`, fora do `npm run check`), precisa de `CAIS_BQ_LIVE_PROJECT` e `CAIS_BQ_LIVE_TOKEN`, pula tudo sem eles e nunca roda o `gcloud`.
- **Comando `cais`:** nunca instalar na máquina durante os testes. `installCli` recebe as pastas por parâmetro e os testes usam pasta temporária.
- **Acesso de agentes:** qualquer mudança em `src/main/agents/` ou em `src/cli/` precisa de `tests/unit/agent-*.test.ts` e `tests/integration/agents*.test.ts` (ataques, segredos, limites) verdes, e da saída do CLI estável byte a byte (a do MySQL não pode mudar por causa do BigQuery: `tests/unit/agent-bigquery.test.ts` confere as chaves e a ordem). Mudança nas regras de agente do BigQuery (`src/shared/dialects/bigquery`, `policy.ts`, `broker.ts`, `redact.ts`) também pede `tests/unit/agent-bigquery.test.ts` e `tests/integration/agents-bigquery.test.ts` verdes.
- Novas regras do classificador entram com teste unitário e, quando dependem do servidor, com teste de integração que confere o estado do servidor depois.

## Commits

Só com a suíte completa verde (`npm run check`). Sem linhas de atribuição de IA em commits ou pull requests.
