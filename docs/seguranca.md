# Segurança

O modelo de segurança do Cais: o que ele protege, como, e o que fica de fora. O comportamento visível de cada regra está em [comportamento.md](comportamento.md) e o contrato do CLI em [agentes.md](agentes.md).

## Ameaças consideradas

- **Erro da própria pessoa:** escrever em produção sem querer, esquecer uma transação aberta, rodar algo diferente do que leu.
- **Um agente de IA que usa o `cais llm`** e tenta, de forma inteligente: rodar algo em produção sem aprovação, escrever sem o clique de aprovar ou sem o Commit, sair do somente leitura, rodar comando de administração (`KILL`, `SET GLOBAL`/`PERSIST`, `GRANT`...), enganar a pessoa no modal, ver um resultado retido, segurar lock ou derrubar o servidor, ou deixar estado de um pedido para o outro.
- **Um processo que edita a pasta de dados do Cais** para ganhar escrita sem revisão (tirar a marca de produção, ligar o acesso de agentes) ou para desviar a credencial para outro host.

Um processo sem sandbox rodando como o mesmo usuário do sistema não é contido pelo app; o que dá e o que não dá para fazer nesse caso está em [Limites conhecidos](#limites-conhecidos).

## Segredos

- **Senhas cifradas pelo cofre do sistema** (`safeStorage` do Electron, Keychain no macOS, Secret Service no Linux) em `secrets.json`. Sem o cofre, o Cais recusa salvar a senha: nunca grava senha em texto puro. No Linux, sem chaveiro (GNOME Keyring, KWallet) o Chromium usaria uma chave fixa no código, o que não é cofre; por isso o Cais também recusa quando o backend escolhido é `basic_text` ou `unknown`.
- **A senha não volta ao renderer.** Ela entra pelo IPC só ao salvar a credencial (vazia mantém a atual). Tokens IAM ficam em memória no processo principal por 50 minutos. Nada de senha ou token em log.
- **Agentes nunca recebem credencial**: nem senha, nem token, nem host, nem id de credencial. `cais llm envs` devolve só id, slug, projeto, nome, produção, motor, nível e banco padrão. Erros de conexão chegam ao agente genéricos (sem host, IP, usuário do banco nem texto do `gcloud`), e o erro de cada comando passa pela mesma redação.
- Os arquivos da pasta de dados são gravados de forma atômica (arquivo temporário e `rename`) com permissão 0600; a pasta da Trilha é 0700.

## Processo principal e renderer

- **O renderer roda isolado:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, sem recurso remoto (sem CDN, sem fontes da web). A interface só fala com o processo principal pela ponte tipada do preload (`window.cais`).
- **CSP restritiva no build:** `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'`. O `style-src 'unsafe-inline'` existe porque o CodeMirror injeta estilos.
- **O processo principal nunca confia no renderer:** todo canal de IPC valida a entrada com zod, só aceita chamadas da janela principal, e o SQL é reclassificado pelo dialeto antes de executar. As decisões sobre pedidos de agentes (aprovar, recusar, liberar, Commit, Rollback) só valem vindas da janela principal e para pedidos no estado certo.
- **O Cais recusa abrir com opções de depuração remota** (`--remote-debugging-port`, `--remote-debugging-pipe`, `--remote-debugging-address`, `--remote-allow-origins`, `--inspect`, `--inspect-brk`, `--inspect-port`, `--inspect-publish-uid`), empacotado ou em desenvolvimento; só o gancho de e2e (`CAIS_E2E=1`, app não empacotado) as aceita. O DevTools só existe fora do pacote. Um depurador ligado à janela faz tudo o que a pessoa faz (aprovar, dar Commit, ligar o acesso de agentes), e um agente com shell poderia reabrir o app com ele.
- **Ganchos de teste** (`CAIS_E2E`, `CAIS_USER_DATA`, `CAIS_SOCKET`, `CAIS_LOCALE`, `CAIS_IDLE_MS`) só valem com o app não empacotado. O app empacotado os ignora.
- **Electron fuses** em todos os pacotes (macOS e Linux): `runAsNode` desligado, cookies cifrados, `NODE_OPTIONS` e argumentos de inspeção ignorados, integridade do asar declarada (o Electron só a confere no macOS e no Windows) e o app carregado só de dentro do asar. O CLI roda no Node do sistema, não pelo Electron.
- **Integridade do `app.asar`:** o Electron só confere a integridade do asar no macOS e no Windows. No Linux essa checagem não existe; quem protege o `app.asar` é a pasta `/opt/Cais` pertencer ao root, o que impede um processo do usuário de trocá-lo.
- **Uma instância por usuário** (`requestSingleInstanceLock`): uma segunda abertura foca a janela que já existe.

## Somente leitura

O Somente leitura tem duas camadas: uma lista do que é permitido no app, que recusa o resto antes de sair, e a sessão em `READ ONLY` no servidor, reafirmada antes de cada comando. O classificador é a parte mais delicada, porque o que o app classifica precisa ser o que o servidor roda. As regras abaixo valem para a pessoa no Somente leitura e para todo SQL de agente.

- **Mesma tokenização do servidor, e na dúvida recusa.** Recusar a mais é aceitável; deixar passar não.
- **Comentário executável é recusado** (`/*! … */`, `/*!NNNNN … */`, `/*M! … */`): o servidor pula ou roda o conteúdo conforme a versão (ou a sintaxe do MariaDB), então `/*!99999 SELECT 1 */ KILL 123` pareceria um `SELECT`.
- **`*/` só fecha um comentário executável que esteja aberto.** Fora dele é multiplicação seguida de `/`: em `SET @a = 2 */* ' */ 1, PERSIST max_connections = 7 /* ' */` o servidor vê `SET PERSIST`, não uma string.
- **A sessão fala só utf8mb4.** `SET NAMES`/`SET CHARACTER SET` só com utf8mb4, e o driver fixa utf8mb4 ao abrir. Com outro conjunto (por exemplo latin1), o driver codifica cada caractere num byte, e letras viram aspas, quebras de linha ou `#` no servidor.
- **`sql_mode` sem `NO_BACKSLASH_ESCAPES` e `ANSI_QUOTES`.** A sessão é fixada assim, e o classificador ainda lê cada comando sob as duas regras de string e fica com a mais estrita.
- **Só letras ASCII viram palavra-chave** (`ſelect` é um nome, não `SELECT`). Função com nome fora do ASCII é recusada, porque o servidor acha funções ignorando acentos.
- **Funções que mudam o estado do servidor** fora de qualquer transação são recusadas em qualquer comando: failover e espera de replicação, group replication, keyring, firewall, audit log, version tokens, locking service, dicionários de mascaramento, `innodb_set_open_files_limit`, `innodb_redo_log_*`, `mysqlx_*`. Uma função dentro de `TRIM`/`SUBSTRING`/`EXTRACT … FROM f()` ou depois de `STRAIGHT_JOIN` conta como chamada.
- **Nome qualificado que começa com dígito** (`db.2fa_codes`, `db.2fn()`) é lido como o servidor lê: depois de um nome, o `.` começa a próxima parte do nome.
- **`SET` analisado de forma estrita:** só `@variável = …` e `NAMES`/`CHARACTER SET` sozinhos. O nome do alvo é reconstruído entre tokens, então uma variável de transação escrita com crase, espaço, comentário ou acento (`` `autocommit` ``, `@@session . autocommit`, `autocommìt`) é recusada em todos os modos.
- **`INTO OUTFILE`, `INTO DUMPFILE` e leituras com lock** são recusados. `COMMIT AND CHAIN`/`ROLLBACK AND CHAIN` contam como abrir transação. Uma transação aberta por qualquer caminho numa sessão somente leitura é desfeita na hora.
- `GET_LOCK` e `SLEEP` continuam permitidos no Somente leitura da pessoa (não escrevem); para agentes são recusados (veja abaixo).
- O realce do editor e do modal lê `\'` como o servidor lê.

## Transação da pessoa

- O estado da transação vem do servidor (indicador de transação aberta do protocolo), não do tipo do comando.
- `SET autocommit` e `SET … TRANSACTION` são recusados em todos os modos. Se um comando ligar o `autocommit` por outro caminho (dentro de um `CALL`), o Cais volta a sessão para 0 na hora e avisa que o que foi gravado já está confirmado.
- `CALL`, `EXECUTE` e comentário executável pedem a confirmação de commit implícito em Transação.

## Regras a mais para SQL de agentes

O que a pessoa aprova no modal precisa ser o que o servidor roda. Por isso o SQL de agente passa por regras de texto antes da classificação:

- **Recusado com caractere invisível, de direção de texto (bidi), de controle, espaço que não seja o espaço comum, ou quebra de linha que não seja `\n`** (CR sozinho, U+2028, VT, FF). Um CR sozinho apareceria como quebra de linha no modal, e o servidor continuaria um comentário `--` por cima do resto do `WHERE`. Emoji com junção (ZWJ) ou seletor de variação também é recusado (o agente usa `CHAR()` ou `X'…'`).
- **Só ASCII fora de strings, de nomes entre crases e de comentários.** O servidor lê NBSP e outros caracteres não ASCII como parte de um nome (`WHERE<NBSP>id` vira um apelido de tabela e a consulta traz tudo). Nome de variável ou de função fora do ASCII é recusado mesmo entre crases (`@іd` com letra cirílica).
- **Comentário com outro `/*` dentro, `--` sem espaço logo depois e variável entre aspas (`@'x'`) são recusados**: nos três casos o realce da revisão poderia ler diferente do servidor.
- **Comentário executável é recusado em qualquer lugar do texto**, inclusive dentro de strings.
- **Funções recusadas:** `GET_LOCK`, `RELEASE_LOCK`, `RELEASE_ALL_LOCKS` (o lock sobrevive ao pedido), `SLEEP`, `BENCHMARK` (seguram a conexão), `LOAD_FILE` (arquivo do servidor), as funções que mudam o estado do servidor e os hints `SET_VAR` e `MAX_EXECUTION_TIME`.
- **Esquemas do sistema:** agentes não escrevem em `mysql`, `performance_schema`, `sys` e `information_schema`, e não leem o esquema `mysql` nem `SHOW CREATE USER` (contas e hashes de senha).
- **Agentes não rodam DDL, comando com commit implícito nem controle de transação**, em nenhum modo, porque não dá para desfazer. Em escrita, só `INSERT`, `REPLACE`, `UPDATE` e `DELETE`, mais as leituras seguras.
- **O modal mostra a verdade:** cada comando separado, na ordem lógica (letras da direita para a esquerda não reordenam o texto), só `\n` quebra linha, caracteres invisíveis como `⟨U+XXXX⟩`, linhas em branco em sequência como um marcador, alertas no topo e Aprovar habilitado só depois de rolar até o fim. Motivo, cliente e nomes de script chegam sem caracteres invisíveis.

### Sessões dos agentes

- **Conexões próprias**, nunca as abas da pessoa. A sessão reafirma utf8mb4, `sql_mode`, `autocommit` e o modo antes de cada comando.
- **A conexão de leitura é zerada entre pedidos** (`COM_RESET_CONNECTION` e o modo de novo): variável de usuário, lock nomeado, conjunto de caracteres, tabelas temporárias e comandos preparados de um pedido não chegam ao próximo, nem de um pedido com resultado retido para um com resultado liberado.
- **Limites de tempo** (30 s no servidor e corte em 35 s por comando, 60 s por pedido de leitura, 60 s por escrita aprovada até a segunda decisão, 10 s de espera por lock) impedem um agente de segurar lock ou conexão. O `KILL QUERY` usa credencial nova, porque o token IAM da abertura pode ter vencido.
- **Escrita que grava fora da transação para o pedido** (`non_transactional_write`), avisando que o Rollback não a desfaz.
- **Aviso de tabela não transacional:** se o SQL alcança uma tabela que não é InnoDB, o modal avisa que o Rollback não a desfaz. O aviso segue views (inclusive views dentro de views), triggers da tabela e de tabelas embaixo de uma view, funções e procedures chamadas (inclusive rotinas de mesmo nome em todos os esquemas e rotinas chamadas por trigger ou por outra rotina). Sem metadados, sem acesso ao corpo de uma rotina ou sem o privilégio `TRIGGER`, avisa que não deu para conferir. Um Rollback incompleto aparece para a pessoa e para o agente (`rollback_incomplete`).
- **Resultado retido:** com "O agente pode ver o resultado" desmarcado, a resposta traz só contagens, e erros do servidor só com o código (a mensagem pode citar valores).
- **O commit automático só acontece no que o Cais consegue contar e desfazer** (regras em [agentes.md](agentes.md#commit-automático-em-leitura-e-escrita-liberadas)): sem trigger, sem cascata, sem view, sem função, com metadados frescos e com tetos de linhas.

### BigQuery (só leitura)

O BigQuery não tem sessão `READ ONLY` no servidor, então as duas camadas do Somente leitura são outras: o classificador do app e o dry run. Nesta versão nenhum caminho (pessoa ou agente) escreve.

- **Duas camadas:** o classificador do GoogleSQL recusa o que não é consulta antes de sair (na dúvida, recusa), e o dry run (`jobs.query` com `dryRun`) devolve o `statementType` que o servidor leu: só `SELECT` segue. Sem `statementType`, recusa. O `SessionManager` usa o dry run para recusar antes de sair e para a pergunta de custo; o driver repete o dry run dentro de `execute`, então a segunda camada vale também para quem o chama sem passar pelo `SessionManager`. Um dry run que falha (tabela que não existe, sem permissão) não decide nada: o erro aparece na execução.
- **Agentes não escrevem:** `--write` num ambiente BigQuery é recusado com `engine_read_only` no broker, e `AgentSessions.runWrite` recusa de novo; nenhum modo de escrita chega ao driver.
- **Texto do SQL:** o que a pessoa aprova no modal precisa ser o que o servidor roda. No GoogleSQL isso pede regras próprias, em `agentCodeProblem` e no classificador (veja abaixo).
- **Custo:** o limite de bytes do ambiente e os 10 GiB fixos dos agentes (o menor dos dois, quando o ambiente tem limite) viram `maximumBytesBilled` do job, então o BigQuery recusa sem cobrar o que passar do teto. Detalhes em [comportamento.md](comportamento.md#bigquery-só-leitura) e [agentes.md](agentes.md#bigquery).
- **Token:** o token de acesso vem de `gcloud auth print-access-token` e é um token OAuth de 1 hora. O Cais o guarda só em memória, por 50 minutos, vai só no cabeçalho `Authorization` das chamadas ao `bigquery.googleapis.com` feitas pelo processo principal e nunca entra em log, em mensagem de erro, na Trilha nem na resposta a agentes. Com 401, o driver pede outro uma vez e repete.
- **Rede:** só o processo principal fala com a API (`net.fetch` do Electron: proxy e certificados do sistema). O gancho `CAIS_BIGQUERY_URL` troca o endereço só no app não empacotado.
- **Redação para agentes:** erros e textos do BigQuery chegam ao agente sem o id do projeto e sem e-mails de conta ou de service account. Os e-mails são tirados antes do id do projeto, porque o domínio de uma service account carrega o id.

**Regras de texto de agente no GoogleSQL** (somadas às gerais):

- São recusados (`ambiguous_text`), porque o realce do modal não os lê como o servidor: strings de três aspas (`'''…'''`, `"""…"""`), string crua (`r'…'`) com barra invertida, string de bytes (`b'…'`), letra `x` colada numa string, nome entre crases com barra invertida, `--` sem espaço depois, comentário com outro `/*` dentro, CR dentro de comentário de linha, nome de parâmetro entre aspas ou crases e caractere fora do ASCII no código, fora de strings, de nomes entre crases e de comentários.
- `#legacySQL` e `#standardSQL` são recusados (`ambiguous_text`; `executable_comment` quando chega à política): a diretiva muda como o servidor lê o texto inteiro.
- `EXTERNAL_QUERY` é recusado (`function_not_allowed`): roda uma consulta em outro banco. `OBJ.GET_ACCESS_URL`, `OBJ.MAKE_REF` e `OBJ.FETCH_METADATA` também: a URL assinada do Cloud Storage (de escrita, no modo `rw`) é credencial que o agente não recebe.
- A chamada encadeada (`(x).f()`, `(x).(ds.f)()`) é `ambiguous_text`: o classificador só vê chamadas escritas como `f(x)`, e uma função remota ou de IA passaria sem aprovação.
- `INFORMATION_SCHEMA.JOBS*` e `SESSIONS*` são recusados (`system_schema`): mostram o SQL de outras pessoas do projeto. Agentes também não escrevem no `INFORMATION_SCHEMA`.
- Esperam aprovação, com `approval_reason`: chamada de função definida no projeto (pode ser uma função remota, que roda código fora do BigQuery), função sem qualificador que não é nativa e `ML.*`/`AI.*` (IA generativa e modelos, que custam além dos bytes). A lista de funções nativas (`src/shared/dialects/bigquery/functions.ts`) é escrita à mão e erra para o lado de pedir aprovação.
- Leitura estimada acima de 10 GiB (a soma dos comandos do pedido), ou acima do limite do ambiente quando ele é menor, sempre espera a pessoa, em qualquer nível, sob a liberação de 15 minutos e em ambiente sem limite.

**Limites conhecidos do BigQuery:**

- **Função remota e IA generativa dentro de um `SELECT`.** Uma chamada qualificada ou sem qualificador que o Cais não reconhece como nativa vai para aprovação, mas o que a pessoa aprova é o texto: a função remota roda código fora do BigQuery e `ML.GENERATE_*` custa fora dos bytes lidos, e nenhum dos dois é contido pelo limite de bytes.
- **A estimativa pode errar.** O dry run estima; o custo real pode diferir (o cache, o armazenamento em coluna, uma tabela que cresce). O Cais repete o dry run antes de rodar e o job leva `maximumBytesBilled`, que é o que impede o excesso. Um agente que passou do teto aprovado recebe `bytes_over_approved` e nada é cobrado. A soma vale por pedido: não há janela entre pedidos, e vários pedidos de até 10 GiB cada, sem aprovação, somam além disso (limite conhecido, no plano).
- **`maximumBytesBilled` sob reserva de slots.** Num projeto com reserva (capacidade fixa), o teto de bytes pode não se aplicar, e a cobrança é por slot, não por byte. Isso não foi conferido num projeto de verdade; o campo vazio existe para esse caso, e o limite fica sendo só uma confirmação.
- **`INFORMATION_SCHEMA` é cobrado.** Uma consulta do usuário a `INFORMATION_SCHEMA` custa como qualquer outra (com mínimo por consulta) e passa pelo mesmo limite. A árvore do Cais não o usa: lê colunas por `tables.get`, que não cobra.
- **O `LIMIT` não reduz os bytes lidos.** `SELECT * … LIMIT 100` lê a tabela inteira (ou as partições que o filtro não excluir). Por isso o duplo clique numa tabela passa pelo limite.
- **`statementType` do servidor.** A segunda camada depende de o dry run dizer o tipo. A suíte ao vivo (`npm run live:bigquery`) confere, contra um projeto de verdade, que tudo o que o classificador deixa passar o servidor lê como `SELECT`; ela não faz parte de `npm run check`. Rodada em 16/11/2026 (spike B0): o servidor deu `statementType` a todas as classes do corpus, e nada que o classificador libera veio diferente de `SELECT`.
- **Token de 1 hora em memória** (veja acima): um processo do mesmo usuário que consiga ler a memória do Cais, ou rodar `gcloud auth print-access-token` ele mesmo, fala com o BigQuery como a pessoa, fora do Cais. É o mesmo limite do `gcloud sql generate-login-token` no MySQL.
- **Permissões da conta.** O Cais lê com a conta da credencial: use uma conta (ou service account impersonada) só com `roles/bigquery.jobUser` no projeto e `roles/bigquery.dataViewer` nos datasets de que o trabalho precisa. Um agente lê tudo o que essa conta lê.

## Isolamento do canal dos agentes

- **O socket só existe com o acesso ligado**, e só a pessoa liga, no app. No Windows, fica num named pipe `\\.\pipe\cais-<usuário>`. Nos outros sistemas, em `<pasta de dados>/agent.sock`; quando esse caminho passa de 100 bytes, no Linux vai para `$XDG_RUNTIME_DIR/cais.sock` (pasta 0700 do usuário, se existir, for absoluta e couber em 100 bytes) e, senão, para `<tmp>/cais-<uid>.sock`. Nos sockets, permissão 0600: só o próprio usuário.
- O Cais apaga um socket antigo só se ninguém responde nele, e ao fechar apaga só o socket e o `agent-endpoint.json` que ele mesmo criou.
- **Protocolo:** uma linha JSON por mensagem, até 1 MB por mensagem e 100 KB de SQL, tudo validado com zod. O CLI confere a versão do protocolo.
- **O agente não aprova, não liga o acesso, não muda níveis e não edita nem apaga scripts.** O app nunca se abre nem liga o acesso por pedido do CLI.
- **Sem Trilha, nada de agente roda sozinho:** cada pedido grava uma linha antes de rodar, e se ela não pode ser gravada o pedido espera a pessoa (e mesmo uma aprovação não roda até a Trilha voltar).

## Cadastro assinado e Trilha encadeada

- **Proteção do cadastro:** cada ambiente (com o nome do projeto, a credencial e a senha cifrada que ele usa) e o interruptor do acesso de agentes são assinados com HMAC-SHA256, com uma chave guardada em `seal.json` e cifrada pelo cofre do sistema. Um ambiente que não confere ao abrir o app fica bloqueado (nada conecta nele), marcado como produção e com "Tudo com aprovação", até a pessoa conferir e salvar. Sem `seal.json`, todos ficam assim: apagar o arquivo não torna nada confiável. "Testar conexão" com a credencial de um ambiente bloqueado é recusado, porque o host do rascunho pode ser o editado. Um acesso de agentes ligado sem assinatura abre desligado. Detalhes em [comportamento.md](comportamento.md#proteção-do-cadastro).
- **Trilha encadeada:** cada linha leva um HMAC da linha com o código da anterior do mesmo dia, com a mesma chave. Uma linha alterada, inserida, apagada no meio ou sem código aparece como "não confere", também quando a chave foi recriada. As linhas de agente de um dia param em 64 MB, para um agente não deixar o dia ilegível.

## Limites conhecidos

- **Credencial de usuário e senha conecta sem TLS.** A senha não vai em claro no handshake, mas as consultas e os resultados vão: use rede privada ou VPN. O IAM exige TLS, sem verificar o certificado (o Cloud SQL usa uma CA própria), então quem controla a rota até a instância pode interceptar o token, que vale 1 hora.
- **Um agente sem sandbox, rodando como o mesmo usuário, não é contido pelo app.** Ele pode ler a pasta de dados do Cais (`catalog.json` revela hosts e usuários; as senhas em `secrets.json` são cifradas pelo cofre, cujo acesso o macOS protege com um aviso, mas isso não é barreira contra um processo determinado; no Linux o chaveiro entrega o segredo a qualquer processo do mesmo usuário pelo D-Bus, sem aviso nenhum, então o sandbox do agente pesa ainda mais), usar o `gcloud` da conta da pessoa (`gcloud sql generate-login-token`) com o cliente `mysql`, editar `catalog.json`, `settings.json`, `scripts.json` e a Trilha, reiniciar o Cais ou clicar na interface por automação do sistema. A aprovação protege contra o agente que **usa o comando**, não contra um agente que ignora o comando.
- **O que a proteção do cadastro e o encadeamento não pegam:** apagar o arquivo de um dia inteiro da Trilha, cortar o fim de um arquivo, editar um script (o efeito só vale quando a pessoa o roda) e voltar uma cópia antiga de `seal.json` junto com o cadastro e o `settings.json` da mesma época (exige ter lido a pasta do Cais antes; um contador à prova disso precisaria de um lugar que o agente não escreve).
- **Função `SQL SECURITY DEFINER` que já existe no banco** e faz administração roda dentro de uma leitura: o servidor não bloqueia. Use no Cais um usuário de banco sem privilégios de administração e revise as rotinas DEFINER.
- **Trigger num esquema que o usuário do banco não enxerga**, escrevendo numa tabela não transacional também invisível, escapa do aviso.
- **MyISAM com `autocommit=0`** ainda aparece como transação aberta no servidor, então a escrita não é barrada em tempo de execução: valem o aviso antes da aprovação e o `rollback_incomplete` depois.
- **Resultado retido** ainda devolve contagens e tempo num pedido aprovado um a um; o tempo de execução é um canal lateral residual.
- **Qualquer cliente `cais llm`** do mesmo usuário lê o status e o resultado dos pedidos dos outros: é a mesma fronteira de confiança. Agentes leem `performance_schema` e `sys`.
- **O alerta de `WHERE` amplo** cobre os casos óbvios (`WHERE 1`, `TRUE`, `x = x`, `OR 1=1`), não toda condição ampla; o modal do Commit mostra as linhas afetadas.
- **"Leitura e escrita liberadas" confia nos alertas e nos limites.** Um `UPDATE` com `WHERE` estreito no papel que pega mais do que devia, dentro de 1.000 linhas por pedido e 5.000 em 15 minutos, faz commit sozinho. Esse é o contrato do nível: use em ambientes de desenvolvimento e homologação. A conta dos 15 minutos fica em memória (o agente não reinicia o Cais pelo CLI).
- **UPDATE e DELETE automáticos exigem `PROCESS`** (ou privilégio global) no usuário do banco, para enxergar chaves estrangeiras vindas de bancos que ele não vê. O `PROCESS` também deixa ver os comandos das outras conexões.

### Recomendações

- Para bancos de produção, rode o agente com sandbox e, no Claude Code, permita só `Bash(cais llm:*)` e negue o que contorna o Cais:

  ```json
  {
    "permissions": {
      "allow": ["Bash(cais llm:*)"],
      "deny": [
        "Bash(gcloud:*)", "Bash(mysql:*)", "Bash(mycli:*)", "Bash(security:*)", "Bash(osascript:*)",
        "Bash(open:*)", "Bash(pkill:*)", "Bash(killall:*)", "Bash(nc:*)", "Bash(socat:*)",
        "Read(~/Library/Application Support/Cais/**)", "Edit(~/Library/Application Support/Cais/**)"
      ]
    }
  }
  ```

  No Linux, troque as regras específicas do macOS (`security`, `osascript`, `open` e a pasta `~/Library/Application Support/Cais`) por estas, mantendo as demais:

  ```json
  {
    "permissions": {
      "allow": ["Bash(cais llm:*)"],
      "deny": [
        "Bash(gcloud:*)", "Bash(mysql:*)", "Bash(mycli:*)", "Bash(secret-tool:*)", "Bash(busctl:*)",
        "Bash(gdbus:*)", "Bash(dbus-send:*)", "Bash(xdotool:*)", "Bash(ydotool:*)", "Bash(xdg-open:*)",
        "Bash(pkill:*)", "Bash(killall:*)", "Bash(nc:*)", "Bash(socat:*)",
        "Read(~/.config/Cais/**)", "Edit(~/.config/Cais/**)"
      ]
    }
  }
  ```

  Regras de negação de comando não substituem o sandbox: um script pode chamar o mesmo binário.
- Use no Cais um usuário de banco só com o que o trabalho precisa, sem acesso ao esquema `mysql` e sem privilégios de administração (`SUPER`, `SYSTEM_VARIABLES_ADMIN`, `CONNECTION_ADMIN`, `REPLICATION_SLAVE_ADMIN`). Um agente roda com os privilégios desse usuário. No Cloud SQL, um usuário IAM pode ter o papel `cloudsqlsuperuser` (com `CREATE USER` e `GRANT OPTION`); para agentes, prefira um usuário com menos privilégios.
- Deixe "Leitura e escrita liberadas" para ambientes onde uma correção errada é barata.
