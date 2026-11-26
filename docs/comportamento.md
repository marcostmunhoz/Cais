# Comportamento do Cais

Como o Cais se comporta e por quê. Cada regra traz o motivo quando ele não é óbvio. O acesso de agentes tem documento próprio ([agentes.md](agentes.md)), assim como o modelo de segurança ([seguranca.md](seguranca.md)) e a arquitetura ([arquitetura.md](arquitetura.md)).

## Princípios

- **Produção não escreve por acidente.** Um ambiente de produção abre em Somente leitura; para escrever é preciso trocar o modo da aba, e o Auto-commit em produção pede confirmação.
- **Segredo não sai do processo principal.** A interface envia a senha uma vez, ao salvar, e nunca a recebe de volta. Nada de senha ou token em log.
- **A interface não conhece o motor.** Tudo o que depende do banco (dialeto, palavras-chave, introspecção, classificação de comandos) vem do driver e do dialeto. MySQL é o primeiro motor e o BigQuery, o segundo (só leitura).
- **O app não altera o `gcloud`.** Só lista as contas logadas e gera tokens: o de login do Cloud SQL e o de acesso do BigQuery.
- **Poucas opções.** Um padrão seguro vale mais que uma configuração. Os valores fixos deste documento (limites de linhas, tempo de inatividade, níveis de agentes) são fixos de propósito; uma opção nova só entra com o motivo registrado aqui.

## Telas

- **Principal:** barra lateral (projetos › ambientes › Scripts e bancos › tabelas e views › colunas), faixa de abas, barra da aba, editor em cima, resultados embaixo e barra de status. No rodapé da barra lateral ficam **Credenciais**, **Agentes** e **Trilha**.
- **Barra da aba:** `projeto › ambiente` (com o selo de produção quando é o caso), estado da conexão com Conectar, Reconectar ou Desconectar, seletor de banco, modo da sessão (**Somente leitura · Transação · Auto-commit**), Salvar e Rodar (que vira Cancelar durante a execução). Com transação aberta aparece a barra "Transação aberta · N comandos · tempo", com **Commit** e **Rollback**.
- **Cadastro:** projetos, ambientes (com o acesso de agentes de cada um) e credenciais.
- **Agentes:** o interruptor do acesso, os pedidos pendentes, as liberações ativas, o nível de cada ambiente e os pedidos recentes.
- **Trilha:** tudo o que rodou no Cais, só leitura.
- **Estados:** sem cadastro (estado vazio com o primeiro passo), desconectado (também por inatividade), conectando, conectado, executando, erro de conexão (com a mensagem), transação aberta (comandos e tempo) e resultado truncado.

A interface segue o tema claro ou escuro do sistema e usa as fontes do sistema. Produção aparece com faixa e cor de alerta na aba e na barra.

## Projetos, ambientes e credenciais

- **Projeto › ambientes.** Um ambiente tem nome, host, porta, banco padrão opcional, credencial, marcação de produção e o nível de acesso de agentes. **Produção** vem marcado quando o nome é `pro`, `prod` ou `production`, e pode ser trocado.
- **Credencial é um cadastro próprio**, usado por quantos ambientes precisar, para não repetir usuário e senha ambiente a ambiente. O cadastro mostra em quantos ambientes ela é usada. Apagar uma credencial em uso é recusado, com a lista de ambientes; apagar um projeto que ainda tem ambientes ou scripts também é recusado.
- **Dois tipos de credencial:**
  - *Usuário e senha.* A senha é cifrada pelo cofre do sistema (`safeStorage`, Keychain no macOS, Secret Service no Linux). Sem o cofre disponível, o Cais recusa salvar a senha: nunca grava senha em texto puro. No Linux o cofre só vale com um chaveiro de verdade (GNOME Keyring, KWallet): se o Chromium cair no armazenamento sem chaveiro (`basic_text`, que usa uma chave fixa no código) ou não souber qual usou (`unknown`), o Cais trata como indisponível e a recusa acrescenta como instalar ou desbloquear o chaveiro e a opção `--password-store=gnome-libsecret`. Credencial Google IAM não usa o cofre e segue funcionando. No formulário, senha vazia mantém a atual.
  - *Google IAM via gcloud.* Conta escolhida entre as logadas no `gcloud` (ou digitada), impersonação de service account opcional e usuário do banco derivado do e-mail e editável: conta de usuário vira a parte antes do `@`; service account vira o e-mail sem `.gserviceaccount.com`.
- **Testar conexão** confere host, porta e credencial antes de salvar.
- **Nomes de projeto e de ambiente** são aparados, normalizados em NFC e sem caracteres invisíveis, únicos sem diferenciar maiúsculas, e não têm `/`, porque o endereço `projeto/ambiente` usado pelos agentes ficaria ambíguo.
- **Duplicar ambiente** (menu do ambiente na árvore, ou o botão Duplicar no formulário) abre o formulário de ambiente novo preenchido, com "(cópia)" no nome e o projeto trocável. Salvar é a conferência da pessoa e assina o ambiente novo (veja [Proteção do cadastro](#proteção-do-cadastro)).
- **Duplicar projeto** (menu do projeto) pede o nome e copia todos os ambientes numa operação só, com a mesma credencial e o mesmo ajuste de nível do cadastro, sem os scripts. É recusado se algum ambiente do projeto estiver bloqueado: uma cópia não pode tornar confiável um ambiente alterado fora do Cais. A Trilha grava "Ambiente criado (cópia de projeto/ambiente)" por ambiente, com o nível de acesso de agentes da cópia.
- **Renomear projeto** pelo menu do projeto na árvore ou pelo lápis no cabeçalho do grupo no Cadastro. A Trilha grava uma linha por ambiente. Mudar só maiúsculas também conta como renomear. As conexões da pessoa continuam (host, porta e credencial não mudam).
- **Renomear projeto, renomear ambiente ou trocar um ambiente de projeto muda o endereço `projeto/ambiente` dos agentes**, então conta como mudança do ambiente: as liberações de 15 minutos são revogadas e os pedidos pendentes expiram. Um pedido pendente com o nome antigo enganaria quem aprova.
- **Arquivo corrompido não impede abrir.** Um arquivo de dados que não passa na validação é guardado ao lado (`<nome>.corrupt-<data>.json`, nunca apagado) e o app abre vazio naquele ponto, com aviso.

## Login IAM no Cloud SQL

- O Cais usa o login manual documentado do Cloud SQL: o token de `gcloud sql generate-login-token --account=<conta>` (com `--impersonate-service-account` quando configurado) entra como senha pelo plugin `mysql_clear_password`, com TLS obrigatório. Não há proxy nem connector rodando à parte: a conexão vai direto ao IP e à porta do ambiente.
- O TLS cifra sem verificar o certificado (`ssl-mode=REQUIRED`), porque o Cloud SQL usa uma CA própria.
- **O que a instância precisa:** a flag `cloudsql_iam_authentication=on`; a conta (ou a service account) cadastrada na instância como usuário IAM do banco, com os privilégios do MySQL de que o trabalho precisa; o papel Cloud SQL Instance User (`roles/cloudsql.instanceUser`) ou equivalente para a conta que gera o token (a impersonada, quando há impersonação); e uma rota de rede até o IP e a porta da instância.
- O token fica em memória por 50 minutos por conta e service account, e nunca vai para log.
- **Achar o `gcloud`:** um app aberto pelo Finder (macOS) ou pelo menu de aplicativos (Linux) não herda o PATH do shell. O Cais procura no PATH atual, depois pelo shell de login (`$SHELL -lc 'command -v gcloud'`, uma vez) e depois em `/usr/local/bin/gcloud`, `/opt/homebrew/bin/gcloud`, `~/google-cloud-sdk/bin/gcloud` e `/opt/homebrew/share/google-cloud-sdk/bin/gcloud` (macOS), e `/usr/bin/gcloud`, `/snap/bin/gcloud` e `/usr/lib/google-cloud-sdk/bin/gcloud` (Linux).
- Quando a conta precisa entrar de novo, o erro diz o comando: `gcloud auth login <conta>`.
- O app só roda três comandos: `gcloud auth list`, `gcloud sql generate-login-token` e `gcloud auth print-access-token --account=<conta>` (com `--impersonate-service-account` quando configurado; é o token do BigQuery, guardado em memória por 50 minutos, separado do token de login). Nenhum comando que altera o `gcloud`.

## BigQuery (só leitura)

O BigQuery é o segundo motor, e nesta versão só lê: para a pessoa e para agentes. O que está fora desta versão, e o que cada item exige, está em [roadmap.md](roadmap.md). A interface não muda de forma: o que depende do motor (dialeto, termo, capacidades) vem do dialeto e do driver, e a tela diz **dataset** onde o MySQL diz banco.

### Ambiente

- **Campos:** projeto do Google Cloud (o id onde os jobs rodam e são cobrados), dataset padrão opcional (é o "banco padrão") e limite de bytes por consulta, opcional. Não há host nem porta. Não há campo de localização: o BigQuery a infere pela consulta (o dataset padrão resolve a região de uma consulta sem tabela, que sem ele cairia em US), e o Cais repete a localização do job nas leituras seguintes (páginas, cancelamento). Uma consulta que mistura datasets de regiões diferentes é recusada pelo servidor ("Not found: Dataset … in location").
- **Credencial:** tem de ser "Google IAM via gcloud"; usuário e senha são recusados ao salvar. O Cais pede o token de acesso ao `gcloud` (`gcloud auth print-access-token --account=<conta>`, com `--impersonate-service-account` quando configurado), guarda-o em memória por 50 minutos e, se o servidor responder 401, pede outro uma vez e repete. O que a conta precisa: `roles/bigquery.jobUser` no projeto e `roles/bigquery.dataViewer` nos datasets lidos; a recusa do servidor chega com essa dica.
- **Testar conexão** confere o token, lista os datasets e faz o dry run de um `SELECT 1`, que confere a permissão de criar jobs no projeto.
- **Por que o campo de limite:** o BigQuery cobra pelo que lê, e uma consulta sem filtro numa tabela de terabytes custa caro antes de qualquer sinal de problema. Por isso o limite é por ambiente, e não um valor fixo do app: um projeto com tabelas de TB quer um teto baixo, enquanto um projeto com reserva de slots (capacidade paga à parte) não paga por byte lido e pode não precisar dele. Um ambiente novo já vem com 100 GiB (unidades binárias, GiB = 2^30 bytes), um teto que barra o erro caro e deixa passar o trabalho comum. Vazio é sem limite: nenhuma pergunta e nenhum `maximumBytesBilled`. O campo é um número inteiro de GiB, de 1 para cima. O limite protege os bytes lidos, e só eles (veja [seguranca.md](seguranca.md#bigquery-só-leitura)).
- Mudar o projeto, a credencial ou o limite conta como mudança do ambiente, como mudar host e porta no MySQL: as liberações de agentes são revogadas e os pedidos pendentes expiram, e a assinatura do cadastro cobre os campos novos.
- **Cais antigo:** um Cais sem o motor BigQuery que abrir um `catalog.json` com ambiente BigQuery o aparta como corrompido (`.corrupt-<data>.json`, nada se perde). Depois de cadastrar um ambiente BigQuery numa máquina, não se volta para uma versão anterior nela.

### Aba e árvore

- **Sempre Somente leitura**, em qualquer ambiente, produção ou não. Transação e Auto-commit aparecem desabilitados na barra, com o motivo; não há Commit, Rollback nem edição na grade. A barra de status diz BigQuery.
- **Seletor de dataset:** trocar de dataset confere que ele existe (`datasets.get`) e vira o padrão das consultas seguintes (nomes sem qualificador). A Trilha grava a linha com o verbo `DATASET`. O dataset atual fica na memória da aba: o BigQuery não guarda sessão nesta versão.
- **Árvore:** datasets › tabelas e views (view materializada e tabela externa levam marca própria) › colunas com o tipo completo (`STRUCT<…>`, `ARRAY<…>`, `NUMERIC(10, 2)`). As colunas de um dataset são lidas quando ele é aberto, por `tables.get` de cada tabela: não custa bytes (ler `INFORMATION_SCHEMA` custaria, com um mínimo por consulta). Enquanto as colunas chegam, a linha do dataset mostra "Lendo…" à direita; não há contagem, porque ela pediria um canal novo do processo principal para alguns segundos de espera. **Atualizar schema** lê de novo.
- **Editor:** realce de GoogleSQL (crases, `#` e `--` como comentário, aspas duplas como string) e autocomplete a partir da árvore, com as mesmas regras do MySQL (veja [Editor](#editor)): `dataset.` lista as tabelas, `dataset.tabela.` e `apelido.` listam as colunas, e a coluna sem qualificador vem das tabelas do `FROM` e do `JOIN` do comando sob o cursor. O caminho com crases (`` `projeto.dataset.tabela` ``) vale, e o projeto é ignorado. O editor lê sozinho as colunas dos datasets que o comando cita (`tables.get` de cada tabela, sem custo de bytes, e sem abrir o dataset na árvore): uma vez por dataset, depois de uma pausa na digitação, e uma leitura que falha não se repete até **Atualizar schema**. Não há verificação de sintaxe local no BigQuery: não há gramática do GoogleSQL embutida, e o erro de sintaxe vem do servidor.
- **Duplo clique numa tabela** roda `` SELECT * FROM `dataset`.`tabela` LIMIT 100; `` pelo caminho normal. No BigQuery o `LIMIT` não reduz os bytes lidos, então a estimativa e o limite do ambiente valem aqui também.

### Rodar

Cada comando passa por duas camadas, e uma recusa em qualquer uma o impede de rodar:

1. **O classificador do app** (mesmo dialeto no renderer e no main) só deixa passar consulta: `SELECT`, `WITH`, sintaxe pipe começando em `FROM` e consulta entre parênteses. Na dúvida, recusa.
2. **O dry run** (`jobs.insert` com `dryRun`, o único caminho que também traz as rotinas usadas) devolve o tipo que o servidor leu e os bytes que leria. Se o servidor não lê o comando como `SELECT` (ou não diz o tipo), o comando não roda. O driver repete o dry run dentro de `execute`, então a segunda camada vale também para quem o chama sem passar pelo `SessionManager`.

- **Regra de confirmação:** com limite, a estimativa até o limite roda, com o limite como `maximumBytesBilled` do job: o BigQuery recusa, sem cobrar, o que passar dele. Estimativa acima do limite pergunta antes de rodar qualquer comando; em "Rodar todos" a pergunta lista cada comando acima do limite com a estimativa. Quem confirma autoriza aquela estimativa: o job roda com o maior valor entre o limite e a estimativa confirmada arredondada para cima ao GiB. A confirmação vale só para o texto do comando sobre o qual foi dada. Se o texto mudar, ou a estimativa nova passar do que foi confirmado (a tabela cresceu entre a pergunta e a execução), o Cais pergunta de novo. Se o ambiente for editado durante o dry run, nada roda com os dados antigos: a pessoa roda de novo.
- **Sem limite**, o Cais não pergunta e não manda `maximumBytesBilled`; a estimativa aparece no rodapé mesmo assim.
- **Cada job** leva o rótulo `cais: person` (ou `cais: agent`), que separa no faturamento o que a pessoa e os agentes leram, e `jobTimeoutMs` de 30 s só nos pedidos de agente.
- **Recusado para a pessoa:** DML (`INSERT`, `UPDATE`, `DELETE`, `MERGE`), DDL (inclusive `CREATE TEMP`), scripts (`DECLARE`, `SET`, `BEGIN … END`, `IF`, `LOOP`...), controle de transação, `CALL`, `EXECUTE IMMEDIATE`, `EXPORT DATA`, `LOAD DATA`, `GRANT`, `REVOKE`, `ASSERT`, mais de um comando por vez, a diretiva `#legacySQL` (e `#standardSQL`) e `EXTERNAL_QUERY`, que roda uma consulta em outro banco e cuja leitura só em transação de leitura não foi conferida (veja [roadmap.md](roadmap.md#a-conferir)). Texto com string, nome entre crases ou comentário sem fim também é recusado. O motivo aparece depois de "Somente leitura:".
- **Erros** do BigQuery viram mensagens da interface com o `reason` como código e o texto original recolhido: acesso negado (com a dica de papel), não encontrado, consulta inválida, limite de bytes, cota, taxa, resultado grande demais, serviço indisponível. Sem rede, "Sem resposta de bigquery.googleapis.com", lembrando da VPN e do proxy.

### Resultado

- A grade de sempre, sem edição. O rodapé mostra linhas, tempo, bytes estimados, processados e faturados e se veio do cache. Números do BigQuery (`INT64`, `NUMERIC`, `BIGNUMERIC`, `FLOAT64`) ficam à direita. Inteiros, `NUMERIC` e `BIGNUMERIC` chegam como texto (sem perder precisão); `TIMESTAMP` em UTC com microssegundos; `DATE`, `DATETIME`, `TIME`, `INTERVAL`, `RANGE`, `GEOGRAPHY` (WKT) e `JSON` como texto; `STRUCT` e `ARRAY` como JSON, que o painel lateral formata; `BYTES` em hexadecimal, cortado em 256 bytes.
- **"Buscar até 50.000" lê o mesmo job:** o Cais guarda o job do último resultado e lê mais páginas dele, sem dry run, sem pergunta e sem nova cobrança. Se o resultado não existir mais (o BigQuery o guarda por 24 horas, ou o texto ou o dataset mudaram depois), o Cais avisa "O resultado dessa consulta não está mais disponível" e não roda a consulta de novo, porque um job novo cobraria outra vez sem estimativa e sem pergunta.
- **Cancelar** usa `jobs.cancel`; fechar a aba cancela o job em andamento. Um job que o servidor já criou e a pessoa cancelou antes da resposta também é cancelado.

### Trilha e idioma

- As linhas do BigQuery levam o id do job, os bytes estimados e os faturados (uma releitura do mesmo job aponta o job, sem bytes: já foi cobrado) e, no detalhe, a confirmação de um comando acima do limite do ambiente (a estimativa e o limite, no idioma de quando a linha foi escrita).
- Os textos são os dos catálogos, nos dois idiomas, com o termo do motor ("dataset") como chave. O que vai para agentes continua em português (veja [agentes.md](agentes.md#bigquery)).

## Modos da sessão

Uma aba é uma sessão, que é uma conexão. O modo e a transação são da aba.

- **Três posições, não dois interruptores:** Somente leitura, Transação e Auto-commit. Assim não existe a combinação sem sentido "somente leitura + transação".
- **Modo inicial:** produção abre em Somente leitura; os demais, em Auto-commit.
- **Trocar de modo com transação aberta é recusado**: faça commit ou rollback antes.
- **Auto-commit em produção pede confirmação.**
- **O modo sobrevive à reconexão.** Uma aba em Auto-commit de um ambiente que passa a ser produção volta para Somente leitura, com aviso.
- **Controle de transação digitado é recusado em todos os modos** (`BEGIN`, `START TRANSACTION`, `SET autocommit`, `SET … TRANSACTION`), com a orientação de usar o modo da aba. `COMMIT AND CHAIN` e `ROLLBACK AND CHAIN` abrem outra transação e só valem em Transação. `COMMIT RELEASE` e `ROLLBACK RELEASE` encerram a conexão e são recusados.
- **"Rodar todos"** (Cmd+Shift+Enter) roda em sequência e para no primeiro erro. As confirmações são pedidas antes de rodar qualquer um, e Cancelar vale também entre um comando e outro.
- **Cursor em linha em branco não roda nada**, e um comentário logo acima de um comando pertence a ele.

### Somente leitura

Duas camadas: uma lista do que é permitido no app, que recusa o resto antes de sair, e a sessão em `READ ONLY` no servidor, reafirmada antes de cada comando. No BigQuery as camadas são outras (veja [BigQuery](#bigquery-só-leitura)).

- **Permitido:** `SELECT` (também por `WITH`, `TABLE` e `VALUES`), `SHOW`, `DESCRIBE`/`DESC`, `HELP`, `USE`, `EXPLAIN` de uma leitura (`EXPLAIN ANALYZE` só de leitura, porque ele executa o comando), `SET @variável = …` e `SET NAMES`/`SET CHARACTER SET` com utf8mb4, sozinhos.
- **Recusado mesmo sendo leitura:** `INTO OUTFILE`, `INTO DUMPFILE` e leituras com lock (`FOR UPDATE`, `FOR SHARE`, `LOCK IN SHARE MODE`).
- **`EXPLAIN` de escrita** é recusado com a orientação de usar o modo Transação: o servidor recusa `EXPLAIN UPDATE` numa sessão somente leitura, e o `EXPLAIN` não altera nada.
- **Comentário executável** (`/*! … */`, `/*!NNNNN … */`, `/*M! … */`) é recusado: o servidor pode pular ou rodar o conteúdo conforme a versão, então o que o app classificou não seria o que roda. Por isso um dump do mysqldump roda em Auto-commit ou Transação.
- **Funções que mudam o estado do servidor** fora de qualquer transação (failover e espera de replicação, group replication, keyring, firewall, audit log, version tokens, locking service, dicionários de mascaramento, `innodb_set_open_files_limit`, `innodb_redo_log_*`, `mysqlx_*`) são recusadas, assim como função com nome fora do ASCII (o servidor acha funções ignorando acentos).
- **Na dúvida, recusa.** Recusar a mais é aceitável; deixar passar não. O classificador usa a mesma tokenização do servidor (detalhes em [seguranca.md](seguranca.md)).
- **Sessão em utf8mb4 e `sql_mode` sem `NO_BACKSLASH_ESCAPES` e `ANSI_QUOTES`**, reafirmados antes de cada comando, junto com o `autocommit`. Uma transação aberta por qualquer caminho numa sessão somente leitura é desfeita na hora. Sair do Somente leitura devolve o `sql_mode` de antes.

### Transação

- A sessão roda com `autocommit=0`. A barra mostra "Transação aberta · N comandos · tempo" desde o primeiro comando, inclusive um `SELECT`, porque até uma leitura segura lock de metadados e pode travar uma migração.
- **O estado da transação vem do servidor** (o indicador de transação aberta do protocolo), não de adivinhar pelo tipo do comando. Isso cobre DDL que falha, tabela temporária, cancelamento e comandos raros com commit implícito.
- **Comando com commit implícito** (DDL, `GRANT`, `LOCK TABLES`, `FLUSH` e afins) com transação aberta pede confirmação. `CALL`, `EXECUTE` e comentário executável contam como possível commit implícito.
- `COMMIT` e `ROLLBACK` digitados no editor funcionam e zeram o contador.
- **A transação não vira auto-commit nem por procedure:** se um comando ligar o `autocommit` (por exemplo dentro de um `CALL`), o Cais volta a sessão para 0 na hora e mostra que o que o comando gravou já foi confirmado.
- **Fechar a aba ou sair do app com transação aberta pergunta** Commit, Rollback ou Cancelar, com Rollback como padrão. Ao sair, o app só fecha depois de resolver todas as abas.
- **Se a conexão cair com transação aberta**, a aba mostra que o servidor desfez a transação até a próxima execução, e a Trilha registra.
- Em Transação e em Auto-commit a aba mantém o próprio `sql_mode`, `SHOW WARNINGS` e `ROW_COUNT()`; o Cais não reafirma nada antes de cada comando, para não apagar diagnósticos nem desfazer um `SET sql_mode` de um dump.

### Auto-commit

- Cada comando confirma sozinho. Em produção, entrar em Auto-commit pede confirmação.
- Se algo trocar o conjunto de caracteres da sessão, o Cais volta para utf8mb4 antes do próximo comando: com outro conjunto, o driver corromperia o texto enviado.

## Abas e conexão

- **Cada aba mostra o estado da conexão:** um ponto na faixa de abas (cinza desconectado, pulsando conectando, verde conectado, vermelho erro, com a mensagem no tooltip) e um selo na barra da aba. Uma função só decide o estado mostrado na faixa, na barra da aba e na barra de status. O ponto de estado ocupa o lugar da cor do ambiente na faixa; produção continua na faixa laranja do topo da aba, para o verde não querer dizer duas coisas.
- **Abrir uma aba conecta na hora** (clique no ambiente, nova aba, script ou tabela), para uma falha de rede aparecer antes de rodar. Falha ao abrir vira erro de conexão com a mensagem. Rodar durante a abertura espera a conexão em andamento.
- **Abas restauradas ao abrir o app ficam desconectadas** até a pessoa conectar ou rodar: as abas persistem entre aberturas (texto, ambiente, banco e script ligado), mas reconectar sozinho a vários ambientes, inclusive produção, não é o que a pessoa pediu ao abrir o app.
- **Desconectar e Reconectar mantêm o texto, o modo e o banco.** Com transação aberta ou comando rodando, Desconectar fica desabilitado, e o processo principal também recusa: desconectar seria um rollback silencioso.
- **Inatividade:** depois de 30 minutos sem atividade na aba (conectar, rodar, commit, rollback, trocar modo ou banco), a aba desconecta e mostra "Desconectado por inatividade". Nunca com transação aberta nem com comando rodando. O próximo Rodar reconecta. O motivo: liberar conexões em instâncias pequenas sem derrubar quem está trabalhando; 30 minutos cobrem uma reunião ou um café. O valor é fixo, e o relógio fica no processo principal.
- **Editar o ambiente enquanto a aba conecta** descarta essa conexão, que usou os dados antigos: a aba fica desconectada com o aviso "O ambiente mudou enquanto a aba conectava", e o próximo Conectar ou Rodar usa os dados novos (com a volta para Somente leitura se ele virou produção). O Cais não reconecta sozinho, porque a pessoa pode estar mudando o ambiente justamente porque a conexão era a errada. Fechar a aba enquanto ela conecta fecha a conexão que chega depois.
- **Um clique no ambiente foca uma aba dele** (a ativa, senão a usada por último nesta abertura do app, senão a última na faixa); sem aba dele, abre uma. **Duplo clique abre outra aba**, só se já havia aba daquele ambiente antes do gesto. **Nova aba** e Cmd+T abrem sempre uma nova, com um seletor por "projeto · ambiente".
- **Duplo clique numa tabela** abre uma aba com `` SELECT * FROM `banco`.`tabela` LIMIT 100; `` e roda.
- O menu do ambiente na árvore tem Nova aba, Editar, Duplicar e Atualizar schema.

## Editor

- CodeMirror 6 com o dialeto MySQL. O realce e as palavras-chave vêm do `lang-sql`; os nomes do schema (bancos, tabelas, colunas e apelidos, a partir do schema do ambiente, com o banco atual como padrão) vêm de uma fonte própria do Cais, que lê o comando sob o cursor (o que o `;` ou o `DELIMITER` em vigor separa) e não o texto todo.
- **Autocomplete por contexto:**
  - **Coluna sem qualificador** das tabelas do `FROM` e do `JOIN` do comando (`SELECT * FROM clientes WHERE na|`), inclusive quando o `FROM` vem depois do cursor (`SELECT na| FROM clientes`), e do alvo de `UPDATE`, `DELETE` e `INSERT INTO` (`UPDATE t SET |`, `INSERT INTO t (|)`). Nunca de todas as tabelas do banco: sem tabela no comando, não há coluna para oferecer.
  - **A mesma coluna em duas tabelas** do comando vira uma opção por tabela, com a tabela no detalhe (`c · int`), e entra qualificada (`c.id`, pelo apelido, ou pelo nome da tabela quando não há apelido).
  - **Depois do ponto:** o apelido (também em `UPDATE t x SET x.`), o nome de uma tabela do comando, um banco (`banco.` lista as tabelas) ou `banco.tabela.`. Os nomes casam sem diferenciar maiúsculas só quando há um candidato só (`lower_case_table_names` muda de servidor para servidor): com `Cards` e `cards` no mesmo banco, só o nome exato vale.
  - **Subquery:** a subquery enxerga as tabelas dela e, com menos peso, as da consulta em volta (uma subquery correlata usa as colunas de fora). Tabela derivada (`FROM (SELECT …) d`) e corpo de CTE não enxergam a consulta em volta, e cada braço de um `UNION` é à parte. As colunas de uma tabela derivada e de uma CTE não completam, porque não há schema para ler (veja o [roadmap](roadmap.md)).
  - **Ordem:** depois de `FROM`, `JOIN`, `UPDATE` e `INTO` vêm as tabelas do banco atual e depois os bancos; depois de `SELECT`, `WHERE`, `ON`, `BY`, `SET`, `AND` e de um operador vêm as colunas, depois os apelidos e as tabelas do comando, e por último as tabelas e os bancos; onde só cabe uma palavra-chave, as palavras-chave vêm primeiro. As palavras-chave se misturam pelo que foi digitado.
  - Um nome com caractere que não é de palavra, ou que é palavra reservada, entra entre crases (`` `order` ``). O schema é o do cache do ambiente: **Atualizar schema** lê de novo.
- **Erro de sintaxe ao digitar:** depois de 0,6 s sem digitar, o comando com erro ganha um sublinhado ondulado fino onde a gramática parou, e o tooltip diz "Possível erro de sintaxe:" seguido da mensagem do parser (em inglês, como a gramática a escreve). Só o primeiro erro de cada comando, porque os seguintes são o parser se recuperando. A cada pausa são verificados o comando sob o cursor e os que estão na tela (no máximo 40 comandos e 60.000 caracteres por vez), nunca o documento inteiro: num script colado com milhares de comandos, só o que a pessoa vê é lido, e o texto já lido não volta ao worker. O comando que a pessoa ainda digita não é marcado enquanto o cursor está no fim dele e o que falta é o fim (`SELECT * FROM t WHERE|`); mover o cursor para outro lugar marca. Nada vai ao servidor: a verificação usa a gramática MySQL do DTStack (`dt-sql-parser`, ANTLR4, MIT), que roda num worker do renderer, carregado no primeiro comando. O servidor continua decidindo: o sublinhado é um aviso e não impede de rodar.
  - **O que é verificado:** consultas e alterações de linha (`SELECT`, `WITH`, `INSERT`, `REPLACE`, `UPDATE`, `DELETE`, `TABLE`, `VALUES`, uma consulta entre parênteses) e um comando cuja primeira palavra não é verbo do MySQL (`SELEC`). DDL, `SET`, `SHOW`, administração e rotinas ficam para o servidor, porque a gramática de terceiros cobre menos que o MySQL 8.4.
  - **O que não é verificado, para nunca marcar SQL válido:** comando com comentário executável (`/*! … */`), com `MATCH … AGAINST`, `JSON_TABLE` ou `FOR UPDATE NOWAIT`, com literal temporal (`DATE '2020-01-01'`), escape ODBC (`{fn NOW()}`), a função `INTERVAL(…)`, `(TABLE t)` ou `(VALUES …)` entre parênteses (a gramática lê errado), com um nome que a gramática toma por palavra-chave (`type`, `off`, `old`, `resource`… fora de uma chamada como `CAST(`), e com mais de 200.000 caracteres. Um comando que o worker não lê em 10 s reinicia o worker e fica sem marca até sair da memória. Os testes guardam essa lista contra o vocabulário da própria gramática e contra um corpus de SQL válido conferido num MySQL 8.4.
  - Não há opção para ligar ou desligar o autocomplete nem o sublinhado: não custam bytes, não enviam texto a lugar nenhum e não impedem nada (veja "Poucas opções" nos [Princípios](#princípios)).
- Cmd+Enter roda o comando sob o cursor (ou a seleção), que fica levemente destacado; Cmd+Shift+Enter roda todos.
- **Atalhos por sistema:** os atalhos deste documento estão escritos como no macOS (Cmd). No Linux e no Windows, Ctrl faz o papel de Cmd (Ctrl+Enter, Ctrl+Shift+Enter, Ctrl+., Ctrl+T, Ctrl+W, Ctrl+S, Ctrl+Shift+S, Ctrl+O), e a interface mostra o atalho do sistema em que está rodando. O Cancelar é Ctrl+.; no GNOME com IBus o emoji usa Super+. e Super+;, então não colide.
- O separador de comandos entende strings, crases, comentários (`-- `, `#`, `/* */`) e linhas `DELIMITER`, que são do cliente e não vão ao servidor.

## Resultados

- **Uma aba de resultado por comando executado**; a última execução substitui a anterior.
- **Até 1.000 linhas por comando**, com o aviso de truncado e o botão "Buscar até 50.000". Um `LIMIT` explícito prevalece, mas a coleta para em 50.000 linhas. Mil linhas cobrem a maior parte das consultas sem pesar na memória nem na rede.
- **"Buscar até 50.000" só existe para leitura simples**, porque roda o comando de novo; um `CALL` não é repetido. O limite de linhas também não corta um `CALL` no meio: as linhas a mais são lidas e descartadas, para a procedure não parar entre um `SELECT` e as escritas.
- **Cancelar** (Cmd+.) usa `KILL QUERY` por uma conexão de controle, com credencial nova (um token IAM da abertura pode ter vencido).
- **Grade virtualizada:** cabeçalho com nome e tipo, números à direita, NULL em cinza itálico, texto longo cortado e painel lateral com o valor completo da célula (JSON formatado). Binário aparece em hexadecimal, cortado em 256 bytes.
- **Copiar:** Cmd+C copia a seleção em TSV com cabeçalho; o menu Copiar tem CSV e JSON.
- Comando sem linhas mostra "N linhas afetadas · tempo". Erro mostra a mensagem tratada e o detalhe original recolhido. Erros de rede dizem "Sem resposta de host:porta" e lembram da VPN, o caso mais comum.
- As linhas afetadas de um `UPDATE` contam as linhas encontradas pelo `WHERE`, não só as que mudaram (o driver liga `FOUND_ROWS`).

## Edição na grade

- **Quando dá para editar:** resultado de leitura sem erro, cujas colunas vêm de **uma tabela base** (não view, não expressão, sem duas origens com o mesmo nome) com **todas as colunas da chave primária** presentes. Os valores da chave não podem ter NULL, FLOAT/DOUBLE, binário cortado nem repetição, e a chave não pode ter TIMESTAMP: o texto lido depende do fuso da sessão e, depois de reconectar, o mesmo texto pode ser outra linha. Colunas geradas, binário cortado, geometria e vetor não são editáveis. Fora disso, o duplo clique diz o motivo, por exemplo qual coluna da chave falta.
- **Duplo clique, Enter ou F2** abre a célula; Enter confirma e Esc cancela. Sair do editor sem digitar nada não muda a célula: NULL continua NULL. O menu da célula (botão direito) tem **Definir como NULL** e **Desfazer edição**. Texto vazio é texto vazio; NULL só pelo menu. Binário e BIT se digitam em hexadecimal.
- A barra "N alterações em M linhas" tem **Gerar UPDATE**, **Aplicar** e **Descartar**.
- **Gerar UPDATE** põe no fim do editor um `UPDATE` por linha, com o `WHERE` pela chave inteira e sem `LIMIT`, e seleciona o trecho. Não roda nada. Banco e tabela vêm como o servidor informou no resultado (em servidor que diferencia maiúsculas, `Users` e `users` são tabelas diferentes). Texto com `\`, caractere de controle, invisível ou de direção vai como `_utf8mb4 X'…'`, para o UPDATE não depender de `NO_BACKSLASH_ESCAPES` nem esconder nada de quem revisa. O tipo do literal vem do schema (ENUM, SET e BIT exatos). Se o último comando do editor não termina com o delimitador, o Cais o termina antes; se há um `DELIMITER` diferente de `;` em vigor, põe `DELIMITER ;` antes dos UPDATEs.
- **Aplicar** roda os UPDATEs pelo caminho normal da aba, então o modo manda:

  | Modo | O que acontece |
  |---|---|
  | Somente leitura | Aplicar fica desabilitado; Gerar UPDATE continua disponível |
  | Transação | A transação abre (ou continua) e a barra de Commit e Rollback assume; o aviso de sucesso lembra do Commit |
  | Auto-commit em produção | Pede confirmação listando os comandos |
  | Auto-commit fora de produção | Roda direto, como um UPDATE digitado |

- **Depois de aplicar**, a consulta roda de novo na mesma sessão para mostrar o que o servidor gravou (trigger, arredondamento, `ON UPDATE`), e um UPDATE que não encontrou exatamente 1 linha é avisado. Se um UPDATE falha no meio, as linhas que não rodaram mantêm as edições; em Auto-commit, o aviso diz que o que rodou antes do erro já está gravado. Se a consulta lida de novo vem de outra tabela (o banco da sessão mudou), o resultado anterior fica, com as edições que não rodaram, e o aviso diz por quê.
- **Antes de Gerar UPDATE e de Aplicar, o Cais lê de novo o schema do ambiente.** Se a chave primária mudou desde a leitura (uma migração com o Cais aberto) ou o tipo de uma coluna da chave mudou, a edição é recusada e a grade passa a mostrar o motivo.
- **Rodar de novo, trocar de resultado, "Buscar até 50.000" ou fechar a aba com edições pendentes pergunta** antes de descartá-las. Cmd+Enter e Cmd+W com um valor digitado e ainda não confirmado contam esse valor como edição pendente.
- O processo principal reclassifica o SQL como qualquer outro: a restrição da grade é de uso, não a fronteira de segurança. O processo principal só aceita a marca de origem da grade quando todos os comandos são `UPDATE`. A Trilha grava o `UPDATE` com "Edição na grade", nunca o valor antigo da célula.

## Scripts salvos

- **Um script pertence ao projeto e aparece dentro de cada ambiente dele** (`loja › dev › Scripts` e `loja › pro › Scripts` mostram a mesma lista), do uso mais recente para o mais antigo. Assim a mesma investigação roda em dev e em produção sem copiar e colar. O script guarda o texto, o banco e onde rodou por último.
- **Salvar:** o botão Salvar na barra da aba ou Cmd+S. Numa aba solta pede o nome, salva no projeto do ambiente e liga a aba ao script; numa aba ligada atualiza o script (texto e banco atual), e o botão fica destacado quando há alteração. **Cmd+Shift+S** salva como outro script.
- **A aba ligada mostra o nome do script** e um `•` quando o texto difere do salvo. Salvar a partir de um ambiente atualiza o script do projeto, e as abas de outros ambientes com o mesmo script passam a mostrar `•`.
- **Fechar uma aba com alteração** pergunta Salvar, Descartar ou Cancelar, depois da pergunta de transação, se houver. **Sair do app não pergunta**: o texto das abas persiste e o `•` volta ao reabrir.
- **Clique no script** abre uma aba naquele ambiente, já no banco do script, ou foca a aba que já existe. O menu do script tem Abrir, Abrir em outro ambiente, Renomear, Duplicar e Excluir; o menu do grupo Scripts tem Novo script.
- **Cmd+O** abre o seletor de scripts ("projeto · nome"). Abre no ambiente da aba ativa se for do mesmo projeto; senão, no ambiente da última execução; senão, no primeiro ambiente que não é de produção; senão, no primeiro.
- **Nomes de script** são únicos por projeto sem diferenciar maiúsculas (comparando em NFC), com até 120 caracteres. Caracteres invisíveis, de direção de texto e de controle são removidos (ou viram espaço), não recusados. Duplicar gera "Nome (cópia)", "Nome (cópia 2)".
- **Scripts criados por agente** levam a etiqueta "agente" até a pessoa salvar ou renomear; a cópia de um script de agente continua marcada.
- Se o script de uma aba ligada não existe mais ao abrir o app, a aba vira solta e mantém o texto.

## Idioma

- **A interface segue o idioma do sistema, em pt-BR ou inglês.** O primeiro idioma preferido do sistema que começa com `pt` dá pt-BR, com `en` dá inglês; nenhum dos dois dá inglês. Não há opção no app: no macOS, **Ajustes › Geral › Idioma e Região › Aplicativos** troca o idioma só do Cais (o pacote declara as duas localizações). No Linux a lista vem do ambiente da sessão (`LANGUAGE` e `LANG`) e não há escolha por app; para abrir o Cais em outro idioma, inicie-o com `LANGUAGE` ou `LANG` diferente.
- O idioma vale para a interface inteira: menu do app, diálogos, notificações do sistema, erros e recusas mostrados à pessoa e formatos de número e data. A interface fica num idioma só, o do sistema, sem menus do Electron em outro.
- **O que vai para agentes é sempre em português** (saída do `cais llm`, `guide`, mensagens das respostas): os códigos são o contrato, e um texto estável não quebra quem já lê a saída.
- **Não se traduzem:** mensagem crua do servidor, texto do agente (motivo, cliente, nome de script), nomes cadastrados, palavras-chave SQL e marcadores como `⟨U+202E⟩`.
- Linhas da Trilha ficam no idioma em que foram gravadas: a cadeia HMAC não permite reescrevê-las.
- O texto da interface não usa exclamação, e os termos do ofício ficam como se fala (commit, rollback, schema, query).

## Trilha

- **Tudo o que roda no Cais fica na Trilha**, pessoa e agentes, num lugar só:
  - **a pessoa:** cada comando rodado numa aba (modo, banco, verbo, linhas, linhas afetadas, tempo e código do erro), a recusa do Somente leitura, o cancelamento, Commit e Rollback (pelos botões e ao fechar a aba), troca de modo (Auto-commit em produção aparece como confirmado), conexão que caiu com transação aberta e o `USE` do seletor de banco;
  - **agentes:** cada pedido (SQL, motivo, cliente, banco, quem decidiu, se o commit foi automático e as contagens por comando), as recusas da política, `schema` e scripts;
  - **configuração:** nível de acesso de agentes e marcação de produção de cada ambiente, ambiente criado ou apagado, acesso de agentes ligado ou desligado, liberações de 15 minutos (criada, revogada, vencida) e o que a proteção do cadastro detectou.
- **BigQuery:** as linhas da pessoa levam o id do job, os bytes estimados (dry run) e os faturados quando houve, e, no detalhe, a confirmação de um comando acima do limite do ambiente (a estimativa e o limite, no idioma de quando a linha foi escrita).
- **Nunca entram dados do resultado**, nem a mensagem de erro do servidor, que pode citar valores ("Duplicate entry 'x'"): só o código e o número do erro.
- **Senha digitada no SQL vira `***`** nas linhas da pessoa: a partir do primeiro `IDENTIFIED` ou `PASSWORD`, tudo entre a primeira e a última aspa. A máscara é grossa de propósito, para nenhuma regra de escape, comentário ou segundo literal deixar escapar um pedaço. As linhas de agente não são mascaradas: um agente não roda esses comandos, e mascarar deixaria o agente esconder texto da Trilha.
- **Um arquivo por dia (UTC)** em `trail/`, na pasta de dados, com permissão 0600, por **90 dias**. Uma linha tem no máximo 128 KB (o SQL guardado vai até 100.000 caracteres, com o tamanho original anotado), e as linhas de agente de um dia param em 64 MB, para um agente não deixar o arquivo do dia grande demais para ler.
- **Comando da pessoa que não é leitura simples, Commit e Rollback ganham uma linha antes de sair** (com o mesmo id da linha final), para um travamento no meio deixar rastro. Uma falha da Trilha nunca derruba a execução da pessoa, e a tela mostra desde quando ela não grava.
- **Sem Trilha, nada de agente roda sozinho.** Cada pedido de agente grava uma linha antes de rodar e outra no fim. Se a linha não pode ser gravada (ou o dia passou do teto de agentes), o que rodaria sozinho vira pedido de aprovação, e mesmo uma aprovação não roda: o pedido continua pendente, com aviso.
- **Cada linha é encadeada**: leva um HMAC da linha com o código da anterior do mesmo dia, com a chave da proteção do cadastro. Uma linha alterada, inserida, apagada no meio ou sem código, ou um dia que não dá para ler, aparece como "não confere". Apagar o arquivo de um dia inteiro ou cortar o fim de um arquivo não aparece (veja [seguranca.md](seguranca.md)). Sem o cofre do sistema não há chave: a Trilha grava sem encadeamento e a tela avisa que não há verificação.
- **A tela Trilha** (barra lateral) é só leitura e filtra por período (últimas 24 horas, 7, 30 ou 90 dias), por quem (você e agentes, só você, só agentes, só o Cais), por ambiente e por texto no SQL, no motivo ou no cliente. Cada dia do período é conferido. A Trilha não reabre uma query em aba: ela registra o que rodou, não é um histórico de edição.

## Proteção do cadastro

Um processo que escreve na pasta de dados poderia apontar o host de um ambiente para outro servidor (o Cais mandaria a credencial para lá; com `caching_sha2_password`, o servidor recebe a senha) ou tirar a marca de produção de um ambiente. A proteção do cadastro torna essas edições visíveis.

- **O que é assinado:** cada ambiente, com o nome do projeto, a credencial que ele usa e a senha cifrada dela, e o interruptor do acesso de agentes. A assinatura usa uma chave guardada em `seal.json`, cifrada pelo cofre do sistema.
- **Ambiente que não confere ao abrir o app** (editado, acrescentado, apontado para outro host, com a credencial trocada ou o projeto renomeado fora do Cais) abre **bloqueado**: nada conecta nele, nem a pessoa nem agentes. Ele também abre marcado como produção e com o acesso de agentes "Tudo com aprovação", com aviso e linha na Trilha. O cadastro mostra o motivo; salvar o ambiente depois de conferir host, porta, credencial, produção e acesso de agentes o libera. Um ambiente bloqueado nunca é reassinado sozinho.
- **Sem `seal.json`** (arquivo apagado ou chave que o cofre não abre), todos os ambientes cadastrados ficam bloqueados e marcados como produção do mesmo jeito: apagar o arquivo não torna nada confiável. Os que esperam conferência ficam numa lista assinada, então reiniciar antes de conferir todos não vira alarme falso; a cada abertura, um ambiente pendente volta a ser produção com "Tudo com aprovação".
- **"Testar conexão" com a credencial de um ambiente bloqueado é recusado**, porque o host do rascunho pode ser o editado.
- **Um acesso de agentes ligado sem assinatura abre desligado.**
- **Sem o cofre do sistema**, nada é assinado: todos os ambientes ficam em "Tudo com aprovação" enquanto isso durar (só em memória, sem gravar no arquivo), o campo fica travado no cadastro, e as edições feitas sem o cofre pedem conferência quando ele voltar.
- Se o Cais cair entre gravar `catalog.json` e `seal.json`, o ambiente abre bloqueado e basta salvá-lo de novo. É o lado seguro.

## O que o Cais não faz

| O quê | Por quê |
|---|---|
| Web app hospedado | O navegador não fala o protocolo do MySQL e não acessa o `gcloud` local. |
| Outros bancos (PostgreSQL etc.) | O contrato de driver e de dialeto é agnóstico; um driver novo entra quando houver uso. |
| Escrever no BigQuery (DML, DDL, scripts, transação, edição na grade, escrita de agente) | Exige uma sessão do BigQuery por aba, a classificação de script inteiro e o custo da escrita no mesmo limite de bytes. A ordem e o que cada item exige estão em [roadmap.md](roadmap.md#bigquery-depois-da-versão-só-leitura). |
| Histórico para reabrir queries, scripts como arquivos `.sql` numa pasta, pastas dentro de Scripts, exportar resultado para arquivo | Os scripts salvos ficam no cadastro do app, e a Trilha registra o que rodou. Copiar em TSV, CSV ou JSON cobre a saída de dados. |
| Servidor MCP | O CLI cobre os agentes com shell. Um adaptador MCP seria uma camada fina sobre o mesmo protocolo local. |
| DDL e comandos com commit implícito por agentes | Não dá para desfazer. Agente só lê ou faz DML dentro de transação. |
| Túnel SSH, Cloud SQL Connector, sincronizar entre máquinas | O login IAM direto, com TLS, cobre o Cloud SQL sem proxy. |
| TLS em credencial de usuário e senha, verificação do certificado do servidor | A conexão com usuário e senha vai sem TLS, pensada para servidores alcançados por rede privada ou VPN; o IAM exige TLS, mas o Cloud SQL usa uma CA própria, que o Cais não confere (veja [seguranca.md](seguranca.md#limites-conhecidos)). |
| Assinatura de desenvolvedor e notarização do app | O pacote recebe assinatura ad-hoc local (veja o README). |
| Opções de idioma, tempo de inatividade, limites de linhas | Seguem o sistema ou são fixos (veja [Princípios](#princípios)). |
