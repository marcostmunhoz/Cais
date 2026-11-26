# Roadmap

O que está fora da versão atual, com o que cada item exige, e o que ainda falta conferir. Nada aqui tem data. Um item só entra quando houver uso, como diz o princípio "Poucas opções" em [comportamento.md](comportamento.md#princípios).

## BigQuery depois da versão só leitura

| Item | O que exige |
|---|---|
| **Auto-commit para a pessoa** (DML e DDL) | Confirmação em produção como no MySQL, e o custo da DML no mesmo limite de bytes. DDL com objeto temporário (`CREATE TEMP TABLE`, `CREATE TEMP FUNCTION`) depende de uma sessão do BigQuery por aba. |
| **Modo Transação** | Uma sessão do BigQuery por aba (`createSession` e `session_id`). O `BEGIN TRANSACTION` roda numa consulta e o `COMMIT` em outra. `UPDATE` e `DELETE` seguram lock da tabela inteira até o fim da transação, e uma transação concorrente na mesma tabela é cancelada, não espera. Um comando que falha deixa a transação aberta até o `ROLLBACK`. O estado vem do `transactionInfo` do job (o equivalente do `DO 0` é um `SELECT 1` na sessão). A sessão expira com 24 horas sem uso ou 7 dias depois de criada. DDL permanente não roda dentro de transação. |
| **Escrita de agente** | O modo Transação, mais a aprovação e o Commit como no MySQL, com `MERGE` entre os verbos de escrita e os mesmos tetos de linhas (`numDmlAffectedRows`). Não há trigger nem chave estrangeira em cascata, então o commit automático fica mais simples. Linhas que ainda estão no streaming buffer não aceitam `UPDATE` nem `DELETE`. |
| **Scripts e procedures** (`DECLARE`, `SET`, `BEGIN … END`, `IF`, `LOOP`, `CALL`) | Sessão por aba e uma classificação de script inteiro, já que o tipo do servidor é `SCRIPT` e os filhos só aparecem depois de rodar. |
| **Parâmetros de consulta** (`@nome`) | Um jeito de informar os valores sem montar SQL com texto. |
| **Edição na grade** | O BigQuery não garante chave primária: só daria para tabela com `PRIMARY KEY … NOT ENFORCED` declarada, com o aviso de que o servidor não confere unicidade, e com Auto-commit ou Transação. |
| **Vários projetos na árvore** | Dados num projeto e jobs cobrados em outro é comum. Exige uma lista de projetos de dados por ambiente, cada um lido à parte. |
| **Prévia de tabela sem custo** | O duplo clique poderia usar `tabledata.list`, que não cobra, em vez do `SELECT … LIMIT 100`. Fica fora do caminho do SQL, então precisa de linha própria na Trilha. |
| **Partição e cluster** | Mostrar na árvore e avisar no editor quando a consulta não filtra pela partição. |
| **Campo de localização** | Só se aparecer um caso em que a região inferida pela consulta e pelo dataset padrão não baste. Uma consulta que mistura regiões é recusada pelo servidor. |
| **`EXTERNAL_QUERY`** | Liberar no Somente leitura só se o banco externo rodar em transação só de leitura (veja "A conferir"). |
| **Strings de três aspas para agentes** | Realce do editor e do modal que leia `'''…'''` e `"""…"""` como o servidor. |
| **Resultados grandes em Arrow** | `queryResultsFormat: ARROW`, para buscar mais que 50.000 linhas sem pesar. |
| **Janela de bytes entre pedidos de agente** | O limiar de 10 GiB vale por pedido: vários pedidos de até 10 GiB, sem aprovação, somam além disso. Falta uma janela por ambiente (bytes de agente nos últimos 15 minutos), no molde de `AUTO_COMMIT_WINDOW_ROWS`. Muda o contrato do `approval_reason` e pede decisão de produto. |
| **Vários motivos de aprovação** | `approval_reason` é um motivo só: quando função e bytes pedem aprovação juntos, vem o da função (os bytes aparecem por comando no modal). Mostrar todos pede uma lista no modelo, na Trilha e no modal. |
| **Progresso com contagem ao ler colunas** | A linha do dataset já mostra "Lendo…". A contagem pediria um canal novo do processo principal para o renderer, por alguns segundos de espera. |

## Editor

| Item | O que exige |
|---|---|
| **Colunas de tabela derivada e de CTE no autocomplete** | O escopo já separa a subquery, a tabela derivada e o corpo da CTE, mas só tabelas do schema têm colunas. Para `WITH w AS (SELECT a, b FROM t) SELECT | FROM w` oferecer `a` e `b`, o escopo teria de ler a lista do `SELECT` (nomes e apelidos, `*` expandido pelo schema). |
| **Palavra-chave que a gramática espera** | O `dt-sql-parser` sabe quais palavras-chave cabem na posição (`getSuggestionAtCaretPosition`), mas pede um parse por tecla e, no comando incompleto, tropeça. Hoje a ordem de palavra-chave, tabela e coluna vem da palavra antes do cursor. |
| **Verificação de sintaxe de DDL, `SET`, `SHOW` e rotinas** | A gramática de terceiros lê errado parte do que o MySQL 8.4 aceita. Cada verbo entra na lista de verificados quando o corpus válido dele (`tests/support/mysql-corpus.ts`, conferido no servidor pelo `PREPARE`) passar sem marcação. |
| **Erro de sintaxe do BigQuery** | Não há gramática do GoogleSQL embutida; o erro de sintaxe vem do servidor. |

## Técnico

| Item | Por quê |
|---|---|
| **`safeStorage` assíncrono** | A API síncrona (`isEncryptionAvailable`, `encryptString`, `decryptString`) sai no Electron 46: o `Vault` precisa virar assíncrono antes de atualizar o Electron. Quando `decryptStringAsync` pedir para cifrar de novo (`shouldReEncrypt`), a senha cifrada muda, e a assinatura dos ambientes que usam a credencial cobre esse texto: cifrar de novo e assinar de novo têm de ir na mesma gravação, ou os ambientes abrem bloqueados. No Linux, conferir como a API assíncrona aponta o provedor sem chaveiro, que a documentação não descreve. |
| **npm 12** | O npm 12 deixa de rodar scripts de instalação que não estão no `allowScripts`. Cada dependência nova com script precisa ser revisada (`npm install-scripts ls`). |

## Distribuição no macOS

| Item | O que exige |
|---|---|
| **Developer ID e notarização** | Uma conta Apple Developer, o certificado Developer ID e uma senha específica de app guardados como segredos do repositório, e um passo do `notarytool` no `release.yml`. Até lá, o dmg leva só a assinatura ad-hoc e a primeira abertura exige liberar o app à mão (README). |
| **macOS x64 (Intel)** | Os builds de macOS são só arm64. Entra se alguém usar um Mac Intel, e dobra o custo dos minutos de macOS na release. |

## Linux fora da escolha atual

| Item | Por que está fora |
|---|---|
| **AppImage** | O caminho do app muda a cada abertura, então o comando `cais` teria de ser copiado para um lugar fixo a cada versão, em vez de linkado. Não há instalação para pôr o perfil do AppArmor de que o sandbox do Chromium precisa no Ubuntu 24.04. |
| **rpm** | Fedora e openSUSE. Entra se alguém usar. |
| **arm64** | Dobra o build e o que testar. Entra com uma máquina Linux arm64 em uso. |

## A conferir

Verificações abertas que pedem um recurso que os testes não têm. Nenhuma está coberta pelo `npm run check`.

| O quê | O que se confere, e o que muda |
|---|---|
| **Rotina por dentro de uma view** | Se o dry run lista em `referencedRoutines` uma função chamada só na definição de uma view. A suíte ao vivo confere um nível, com `CAIS_BQ_LIVE_ROUTINE` e `CAIS_BQ_LIVE_VIEW` (AGENTS.md); uma view sobre essa view se confere à mão: criar a view e rodar o dry run por `jobs.insert`. Se não listar, uma função remota atrás de uma view chega a um agente sem aprovação: veja [seguranca.md](seguranca.md#bigquery-só-leitura). |
| **`maximumBytesBilled` com reserva de slots** | Num projeto com reserva, se o servidor aceita, ignora ou recusa o campo. Se recusar, o limite vazio no ambiente o desliga; se ignorar, o teto só vale no on-demand e o texto deve dizer isso. |
| **`EXTERNAL_QUERY` em transação só de leitura** | Com uma conexão descartável para um Cloud SQL, se uma escrita dentro da consulta externa é barrada. Enquanto não for conferido, segue recusado para todos. |
| **`print-access-token` com `--impersonate-service-account`** | Com uma conta de serviço e o papel `roles/iam.serviceAccountTokenCreator`, se o token personificado serve ao BigQuery (`SELECT SESSION_USER()` dá a conta de serviço) e se o stdout traz só o token. |
| **`net.fetch` atrás do proxy do sistema** | No app, com um proxy configurado no sistema (GNOME: Configurações › Rede › Proxy), **Testar conexão** de um ambiente BigQuery passa; com o proxy derrubado, aparece "Sem resposta de bigquery.googleapis.com". Um proxy com certificado próprio precisa dele no repositório do sistema. |
| **Instalação do deb no Linux** | `sudo apt install ./dist/cais_<versão>_amd64.deb` e conferir: o ícone certo e agrupado na barra do GNOME; o nome Cais na notificação; o item do Cais no chaveiro e as contas do `gcloud` no cadastro; **Arquivo › Instalar comando cais** (cria `~/.local/bin/cais` apontando para `/opt/Cais/resources/cli/cais.mjs`); `cais llm guide` no Node do sistema e `cais llm envs` com o acesso ligado; instalar uma versão nova por cima (mantém o link) e desinstalar (deixa o link quebrado, que a próxima instalação troca). Também apertar `Ctrl+.` (Cancelar) uma vez com o editor em foco: no GNOME o IBus usa `Super+.` para emoji, então deve estar livre. |
| **Ubuntu 24.04 e o perfil do AppArmor** | No 24.04, o sandbox do Chromium depende do perfil do AppArmor que o deb instala (`/etc/apparmor.d/cais-app`); só foi conferido num Ubuntu 26.04, onde funciona com a restrição de user namespaces ligada. |
| **`npm run check` e `npm run dist` no Mac** | `npm run check` verde no macOS, e `npm run dist` gerando o dmg e o `Cais.app` com assinatura ad-hoc, que abre direto da pasta `dist/`. |
