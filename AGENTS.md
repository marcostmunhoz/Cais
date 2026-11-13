# AGENTS.md — Cais

Cliente SQL de desktop (Electron + React + TypeScript), organizado por projeto e ambiente. MySQL primeiro, com o motor isolado por contratos de driver e de dialeto; login IAM no Cloud SQL via `gcloud`; acesso de agentes de IA pelo CLI `cais llm`, com aprovação no app.

Antes de mudar comportamento, leia [docs/comportamento.md](docs/comportamento.md) (o que o produto faz e por quê) e [docs/seguranca.md](docs/seguranca.md) (o modelo de segurança). A arquitetura está em [docs/arquitetura.md](docs/arquitetura.md) e o contrato do CLI em [docs/agentes.md](docs/agentes.md).

## Mapa do código

| Pasta | O que tem |
|---|---|
| `src/main` | Processo principal: ciclo de vida, IPC (`ipc.ts`), sessões da pessoa (`sessions.ts`), drivers (`drivers/`), credenciais e `gcloud` (`auth/`), arquivos e cofre (`store/`), Trilha (`trail.ts`), acesso de agentes (`agents/`) |
| `src/preload` | A ponte `window.cais` (contrato `CaisApi`) |
| `src/renderer` | Interface em React (`components/`, `lib/`) |
| `src/shared` | TypeScript puro usado pelos dois lados: modelo, resultados, contrato de IPC, dialetos (`dialects/`), i18n (`i18n/`), regras de texto, edição na grade |
| `src/cli` | O comando `cais llm` (sem dependências, empacotado por `scripts/build-cli.mjs`) |
| `tests` | `unit`, `integration` (MySQL em container), `e2e` (Playwright com Electron), `support` |
| `scripts` | Empacotamento do CLI e assinatura ad-hoc do app (`afterSign`) |
| `skills/cais` | Skill para agentes usarem o CLI |
| `docs` | Documentação do produto, da segurança, da arquitetura e do CLI |

## Invariantes

- **Segredo nunca sai do processo principal** em texto puro e nunca vai para log. A senha entra pelo IPC só ao salvar e nunca volta ao renderer. Agentes nunca recebem senha, token, host nem id de credencial.
- **O processo principal nunca confia no renderer:** todo canal de IPC valida a entrada com zod, só aceita a janela principal, e o SQL é reclassificado pelo dialeto antes de executar.
- **A interface não conhece o motor:** dialeto, classificação de comandos e introspecção vêm de `src/shared/dialects` e `src/main/drivers`.
- **O app nunca altera o `gcloud`:** só `gcloud auth list` e `gcloud sql generate-login-token`.
- **Toda requisição de agente é reclassificada no main** (`src/main/agents/policy.ts`). Agente não aprova, não liga o acesso, não muda o nível de um ambiente e não edita nem apaga script. O socket só existe com o acesso ligado (`settings.json`, desligado por padrão). Em produção, escrita de agente sempre pede aprovação. Nada de agente roda sem a Trilha.
- **Somente leitura em duas camadas** (lista do app e `READ ONLY` no servidor). No classificador, na dúvida, recusa.
- **Poucas opções:** nada de opção de configuração sem o motivo registrado em `docs/comportamento.md`.
- **Idioma:** a interface segue o idioma do sistema, em pt-BR ou inglês. Todo texto que a pessoa vê sai dos catálogos de `src/shared/i18n/areas` (os dois idiomas, mesma chave), nunca escrito direto no componente. O que vai para agentes (saída do CLI, `guide`, respostas do broker) fica em português, fixo. Sem exclamação; termos do ofício como se fala (commit, rollback, schema, query).
- **O Cais roda uma instância por usuário** (`requestSingleInstanceLock`) e recusa abrir com opções de depuração remota (`--inspect*`, `--remote-debugging-*`), menos no gancho de e2e. O DevTools só existe fora do pacote.

## Convenções

- TypeScript `strict`; código, identificadores e comentários em inglês. A documentação em `docs/` e o README ficam em português.
- Dependências com versão exata (sem `^`), `package-lock.json` versionado.
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
| `npm run cli -- llm envs` | Recompila o CLI e roda `cais llm …`. Precisa do Cais aberto (`npm run dev`) com o acesso de agentes ligado. |
| `npm run dist` | `build` + electron-builder: `dist/Cais-<versão>-arm64.dmg` e `dist/mac-arm64/Cais.app`, com Electron fuses endurecidos (`electronFuses`) e assinatura ad-hoc local (`scripts/adhoc-sign.cjs`, hook `afterSign`). O CLI vai em `Cais.app/Contents/Resources/cli/cais.mjs` (`extraResources`: o Node do sistema não lê dentro do asar) e roda no Node do sistema, não pelo Electron (o fuse `runAsNode` fica desligado). |

## Testes

- **Ganchos de teste** só valem com `!app.isPackaged`; o app empacotado os ignora:
  - `CAIS_E2E=1`: cofre falso (sem Keychain), o `userData` de `CAIS_USER_DATA` e aceita as opções de depuração (o Playwright as usa);
  - `CAIS_SOCKET`: caminho do socket dos agentes (o CLI também o lê);
  - `CAIS_LOCALE` = `pt-BR` | `en`: o e2e fixa `pt-BR` por padrão e usa `en` só no teste de idioma;
  - `CAIS_IDLE_MS`: inteiro de 100 ms ou mais, encurta a desconexão por inatividade.
- **Banco:** os testes usam só o próprio container `cais-test-*`, em porta aleatória. Nunca a porta 3306 (para não colidir com um MySQL local), nunca outro container, nunca um banco real. Se um teste travar e deixar container para trás: `docker ps -a --filter name=cais-test-` e `docker rm -f` neles.
- **`gcloud`:** nunca rodar o `gcloud` de verdade nos testes. Eles usam um `gcloud` falso (`spawn` injetável).
- **Comando `cais`:** nunca instalar na máquina durante os testes. `installCli` recebe as pastas por parâmetro e os testes usam pasta temporária.
- **Acesso de agentes:** qualquer mudança em `src/main/agents/` ou em `src/cli/` precisa de `tests/unit/agent-*.test.ts` e `tests/integration/agents*.test.ts` (ataques, segredos, limites) verdes, e da saída do CLI estável byte a byte.
- Novas regras do classificador entram com teste unitário e, quando dependem do servidor, com teste de integração que confere o estado do servidor depois.

## Commits

Só com a suíte completa verde (`npm run check`). Sem linhas de atribuição de IA em commits ou pull requests.
