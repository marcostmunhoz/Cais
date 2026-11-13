# Acesso de agentes

Agentes de IA com shell (Claude Code e outros) consultam e, com a aprovação da pessoa, corrigem dados pelo comando `cais llm`. O modelo é simples: **o agente pede, a pessoa decide no Cais**. O Cais guarda as credenciais e não entrega senha, token, host nem id de credencial ao comando. O que o próprio SQL do agente devolve (`CURRENT_USER()`, `@@hostname`, `SHOW PROCESSLIST`, valores de `enum` no schema) é dado consultado, como qualquer outro, e não é escondido.

O modelo de segurança por trás disso, com os limites conhecidos, está em [seguranca.md](seguranca.md).

## Ligar e instalar

1. No Cais, abra **Agentes** (rodapé da barra lateral) e ligue **Acesso de agentes**. O acesso começa desligado e só a pessoa liga, no app; desligado, o socket nem existe. A barra de status mostra "Agentes ligado".
2. Menu **Cais › Instalar comando cais no terminal** (no Linux e no Windows, menu **Arquivo**). O Cais cria um link `cais` para o `cais.mjs` do app em `/usr/local/bin` se der para escrever lá, senão em `~/.local/bin`, e avisa se a pasta não está no PATH. No deb do Linux o comando não vem no pacote: este menu é o jeito de instalá-lo, e na prática cria o link em `~/.local/bin` (o `/usr/local/bin` costuma ser do root). Nunca sobrescreve um arquivo ou link que não seja do próprio Cais. No Windows o item fica desabilitado: use `node <caminho>/cais.mjs`. O comando roda no Node do sistema, 20 ou mais novo.
3. Em desenvolvimento, sem instalar: `npm run cli -- llm envs` (recompila o CLI e roda; precisa do Cais aberto com `npm run dev` e o acesso ligado).
4. Dê ao agente a skill [skills/cais/SKILL.md](../skills/cais/SKILL.md). No Claude Code, a permissão sugerida é `Bash(cais llm:*)`.

**Desligar o acesso** fecha o socket na hora: os pedidos pendentes expiram, as transações abertas dos agentes sofrem rollback, as leituras em andamento são interrompidas, nenhuma conexão nova abre e as liberações de 15 minutos somem. Sair do app faz o mesmo.

## Como o CLI acha o Cais

O CLI fala com o Cais aberto por um socket local, uma linha JSON por mensagem. O Cais escreve `agent-endpoint.json` na pasta de dados quando o acesso está ligado, e o CLI o lê:

| Sistema | Pasta de dados |
|---|---|
| macOS | `~/Library/Application Support/Cais` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/Cais` |
| Windows | `%APPDATA%\Cais` |

`CAIS_SOCKET` aponta o CLI para outro socket. O app só aceita essa variável quando não está empacotado (é o gancho dos testes).

## Comandos

```
cais llm guide
cais llm envs
cais llm schema <env> [--database db] [--table t]
cais llm query <env> (--sql "<sql>" | --file <arquivo> | -) [--write] [--reason "<motivo>"] [--database db]
                     [--max-rows N] [--wait] [--timeout 600]
cais llm status <request_id> [--wait] [--timeout 600]
cais llm requests [--limit 20]
cais llm scripts [--project <projeto>]
cais llm script <script_id>
cais llm script-save --project <projeto> --name "<nome>" (--sql "<sql>" | --file <arquivo> | -) [--database db]
```

Todos aceitam `--client "<nome>"` (ou a variável `CAIS_CLIENT`; padrão "agente"), que aparece no modal como "informado pelo cliente" e vai para a Trilha.

| Comando | O que faz |
|---|---|
| `guide` | O fluxo, as regras e os códigos de saída, em texto. Não precisa do Cais aberto. |
| `envs` | Lista os ambientes: `id`, `slug` (`projeto/ambiente`), `project`, `name`, `production`, `engine`, `agent_access` e `default_database`. Nada de host, usuário ou credencial. |
| `schema` | Bancos e tabelas do ambiente (só metadados). Sem `--database`, só os nomes das tabelas; com `--database` ou `--table`, as colunas (`name`, `type`, `nullable`, `key`). Roda direto em qualquer ambiente, até em produção, e entra na Trilha. Cache de 60 s por ambiente. |
| `query` | Roda SQL. Sem `--write` é leitura; com `--write`, escrita em transação. |
| `status` | O estado de um pedido. Com `--wait`, espera o estado final. |
| `requests` | Os pedidos recentes, `--limit` de 1 a 100 (padrão 20; até 100 ficam na memória do Cais): `request_id`, `status`, `environment`, `production`, `mode`, `created_at`, a primeira linha do SQL e `decided_by`/`auto_commit`. |
| `scripts`, `script` | Lista os scripts salvos (de um projeto, com `--project`) e lê um, com o SQL. |
| `script-save` | Cria um script no projeto, marcado como "agente" até a pessoa salvá-lo. Só cria: nome repetido é recusado (`duplicate_name`), e agente não edita nem apaga scripts. |

Opções de `query`:

| Opção | O que faz |
|---|---|
| `<env>` | O id ou o slug `projeto/ambiente`. O slug compara em NFC, com minúsculas só em ASCII. |
| `--sql`, `--file`, `-` | O SQL, por exatamente uma das três (`-` lê a entrada padrão). Até 100 KB. |
| `--write` | Pede escrita. Sem ela, um SQL que escreve é recusado (`writes_in_read`). |
| `--reason` | O motivo, em uma frase. Obrigatório em toda escrita e em todo pedido que precisa de aprovação. Vai para o modal e para a Trilha. |
| `--database` | Roda `USE` antes. |
| `--max-rows` | Linhas por comando, de 1 a 1000 (padrão 200). Fora disso é erro de uso, não é cortado em silêncio. |
| `--wait` | Espera o estado final (`awaiting_commit` é intermediário). Sem ela, um pedido que precisa de aprovação volta na hora com `{ "request_id": "...", "status": "pending_approval" }`. |
| `--timeout` | Segundos de espera com `--wait`, de 1 a 3600 (padrão 600). Esgotado, sai com código 5 e o pedido segue valendo. |

## Saída

Toda saída, menos a do `guide` (texto), é JSON na saída padrão, uma linha, inclusive os erros: `{ "error": "...", "code": "..." }`. Cortar a saída com `head` não é erro: o comando sai em silêncio e o código de saída é o do pedido. Os textos são sempre em português; os códigos são o contrato.

Resposta de `query` e `status`:

| Campo | Quando vem | Significa |
|---|---|---|
| `request_id`, `status`, `environment`, `production`, `mode`, `database` | Sempre (`database` se houver) | O pedido |
| `expires_at` | `pending_approval` | Quando o pedido expira sem resposta |
| `rollback_at` | `awaiting_commit` | Quando acontece o rollback automático |
| `decided_by` | Pedido decidido | `person` (a pessoa aprovou ou recusou no modal) ou `policy` (o nível do ambiente ou a liberação de 15 minutos deixou rodar sem a pessoa ver aquele pedido). Pedido expirado não traz. |
| `auto_commit` | Escrita `committed` | `true` se o Cais fez o commit sozinho, `false` se a pessoa deu o Commit |
| `approval_reason` | Pedido que o nível liberaria, mas espera a pessoa | Por que espera (alerta, view, trigger, Trilha fora do ar...) |
| `commit_reason` | Escrita automática que parou antes do commit | Por que espera o Commit da pessoa (linhas demais, aviso do servidor...) |
| `rejection_reason` | `rejected` ou `expired` | O motivo digitado pela pessoa, ou o motivo do Cais (por exemplo, "O ambiente mudou.") |
| `rollback_reason` | `rolled_back` | `timeout`, `user`, `shutdown`, `access_off` ou `unexpected_commit` |
| `rollback_incomplete` | Rollback que não desfez tudo | O servidor avisou que tabelas não transacionais ficaram com o que foi gravado |
| `error` | `failed` | `message`, `code` e, numa escrita, `statement_index` (o comando que falhou) |
| `timed_out` | `--wait` esgotado | O pedido segue valendo |
| `results` | `succeeded`, `committed` e leitura `failed` | Um item por comando: `index`, `sql`, `verb`, `kind`, `duration_ms`, `columns` (`name` e `type`), `rows`, `row_count`, `truncated`, `affected_rows`, `insert_id`, `warnings`, `error` |
| `result_withheld` | A pessoa desmarcou "O agente pode ver o resultado" | `results` traz só contagens (`row_count`, `affected_rows`), sem colunas nem valores, e erros do servidor só com o código |

O resultado de uma escrita só chega depois do Commit. Escrita que falha devolve só o erro e o índice do comando; em rollback, recusa ou expiração não chega resultado nenhum. Erros de conexão chegam genéricos: sem host, IP, usuário do banco nem texto do `gcloud`.

## Ciclo de um pedido

```
pending_approval ──▶ rejected | expired
        │
        ▼
     running ──▶ leitura: succeeded | failed
        │
        └──▶ escrita: awaiting_commit ──▶ committed | rolled_back
                      (ou failed, ou succeeded se não ficou transação aberta)
```

- Um pedido pendente expira em **10 minutos**. Com mais de **20** pendentes, o próximo é recusado (`queue_full`).
- Uma escrita roda todos os comandos numa transação, na conexão própria do agente (nunca nas abas da pessoa), e para no primeiro erro, com rollback. Sem erro e com transação aberta, vira `awaiting_commit`: a pessoa vê, por comando, as linhas afetadas e escolhe **Commit** ou **Rollback**. O Rollback é o padrão e é **automático em 2 minutos**, para não segurar lock.
- `commit_unknown` quer dizer que a conexão caiu depois do envio do Commit: confira no banco antes de repetir.
- Editar ou apagar um ambiente (host, porta, credencial, banco padrão, produção, nome ou projeto) ou a credencial que ele usa revoga as liberações dele, expira os pedidos pendentes ("O ambiente mudou.") e fecha as conexões dos agentes nele.

## Níveis por ambiente

Cada ambiente tem o campo **Acesso de agentes** no cadastro. O painel Agentes mostra o nível de cada um em "Por ambiente", e `cais llm envs` devolve o código em `agent_access`.

| Nível (`agent_access`) | Leitura | Escrita |
|---|---|---|
| **Tudo com aprovação** (`approve-all`) | Pede aprovação | Uma aprovação por pedido, depois Commit ou Rollback |
| **Leitura liberada, escrita com aprovação** (`free-reads`) | Roda na hora | Uma aprovação por pedido, depois Commit ou Rollback |
| **Leitura e escrita liberadas** (`free-reads-writes`) | Roda na hora | Roda em transação e o Cais faz o commit sozinho, dentro dos limites abaixo |

- **Fora de produção**, o padrão é *Leitura liberada, escrita com aprovação*.
- **Em produção, escrita de agente sempre pede aprovação.** O campo só oferece os dois primeiros níveis e começa em *Tudo com aprovação*; marcar "Produção" volta o campo para ele. Liberar leitura em produção é escolha explícita da pessoa: as leituras de agente já rodam em sessão somente leitura, reclassificadas no processo principal, e ficam na Trilha. O processo principal grava *Tudo com aprovação* para produção quando chega *Leitura e escrita liberadas*, e a política trata produção sem nível ou com escrita liberada como *Tudo com aprovação*, diga o arquivo o que disser.
- **Leitura de schema** roda direto em todos os níveis.
- **A liberação de 15 minutos**: no modal de uma leitura que pediu aprovação, a caixa "Aprovar leituras em <ambiente> por 15 min" libera as próximas leituras daquele ambiente. Só existe com "O agente pode ver o resultado" marcado (com o resultado retido, 15 minutos de leituras sem revisão reconstruiriam o dado pela contagem de linhas). Não aprova o que já está na fila, vale só para leitura, fica em memória (reiniciar o app zera), pode ser revogada no painel e entra na Trilha (criada, revogada, vencida).

### Commit automático em "Leitura e escrita liberadas"

O nível serve para correções pontuais em tabelas simples. O Cais só faz o commit sozinho do que consegue contar e desfazer.

**Antes de rodar, a escrita vai para a aprovação da pessoa** (com o motivo no modal e em `approval_reason`) quando:

- há qualquer alerta: `UPDATE`/`DELETE` sem `WHERE`, `WHERE` sempre verdadeiro (`WHERE 1`, `TRUE`, `x = x`, `OR 1=1`), tabela não transacional alcançada direto, por view ou por trigger;
- o pedido tem algo além de `INSERT`, `REPLACE`, `UPDATE` e `DELETE` (um `SELECT f()` ou `SET @x = f()` pode gravar);
- o comando chama função do banco ou usa view;
- a tabela tem trigger, ou é referenciada por chave estrangeira em cascata (o servidor não conta essas linhas nas afetadas);
- o usuário do banco não enxerga os triggers (sem o privilégio `TRIGGER`, inclusive quando um `partial_revokes` o tira de um banco);
- é um `UPDATE`, `DELETE`, `REPLACE` ou `ON DUPLICATE KEY UPDATE` e o Cais não enxerga todas as chaves estrangeiras que podem cascatear (para isso o usuário do banco precisa do privilégio `PROCESS`, que dá acesso à lista do InnoDB, ou de privilégio global sem revogação parcial). `INSERT` simples nunca cascateia e continua liberado;
- parte dos metadados não pôde ser lida;
- já há uma escrita de agente aberta no ambiente (uma por vez);
- a Trilha não pode ser gravada.

Os metadados dessa decisão são lidos na hora, sem o cache de 60 s.

**Depois de rodar, a escrita espera o Commit da pessoa** (relógio de 2 minutos, motivo em `commit_reason`) quando passou de **1.000 linhas afetadas** no pedido, de **5.000 em 15 minutos** somando os commits automáticos do ambiente, quando o servidor deu aviso (valor cortado ou convertido) ou quando o nível ou a marcação de produção do ambiente mudaram durante o pedido. A conta dos 15 minutos fica em memória. As linhas afetadas contam as linhas encontradas pelo `WHERE`, o que conta a mais: o lado seguro.

Na prática, depende do usuário do banco que o Cais usa no ambiente: sem `TRIGGER`, nenhuma escrita roda sozinha; com `TRIGGER` mas sem `PROCESS` (ou privilégio global), só `INSERT` simples roda sozinho; com os dois, `INSERT`, `UPDATE` e `DELETE` em tabelas simples rodam sozinhos. O `PROCESS` também deixa ver os comandos das outras conexões (`SHOW PROCESSLIST`), então pese antes de conceder.

## O que é recusado

O processo principal reclassifica cada comando com o dialeto; nada do que o cliente diz sobre o SQL é confiado. Recusas e erros de uso saem com código 2.

| Pedido | `code` |
|---|---|
| Opção desconhecida, valor fora do intervalo, `--sql` vazio ou só com espaços, mais de uma fonte de SQL | `usage` |
| Arquivo de `--file` que não abre | `file_unreadable` |
| SQL sem nenhum comando (por exemplo, só comentários) | `empty_sql` |
| Leitura (`query` sem `--write`) com algo que não é permitido em somente leitura | `writes_in_read` |
| DDL, comando com commit implícito, controle de transação (`BEGIN`, `COMMIT`, `ROLLBACK`, `SET autocommit`...) | `ddl_or_transaction` |
| Em escrita, algo além de `INSERT`, `REPLACE`, `UPDATE`, `DELETE` e leituras seguras (`CALL`, `LOAD`, `SELECT … FOR UPDATE`, `INTO OUTFILE`, `KILL`, `DO`...) | `command_not_allowed` |
| Comentário executável (`/*! … */`, `/*M! … */`) | `executable_comment` |
| `GET_LOCK`, `RELEASE_LOCK`, `RELEASE_ALL_LOCKS`, `SLEEP`, `BENCHMARK`, `LOAD_FILE`, funções que mudam o estado do servidor, hints `SET_VAR` e `MAX_EXECUTION_TIME` | `function_not_allowed` |
| Escrita em `mysql`, `performance_schema`, `sys` ou `information_schema`; leitura do esquema `mysql` ou `SHOW CREATE USER` | `system_schema` |
| SQL com caractere invisível, de direção de texto, espaço que não seja o espaço comum, quebra de linha que não seja `\n` (CR sozinho, U+2028, VT, FF) ou de controle | `hidden_text` |
| Texto que o servidor e a revisão leriam diferente: caractere não ASCII fora de strings, de nomes entre crases e de comentários; nome de variável ou de função fora do ASCII; comentário com outro `/*` dentro; `--` sem espaço logo depois; variável entre aspas (`@'x'`) | `ambiguous_text` |
| `SET NAMES`/`SET CHARACTER SET` que não seja utf8mb4 | `writes_in_read` ou `command_not_allowed` |
| Falta `--reason` | `reason_required` |
| Mais de 20 pendentes | `queue_full` |
| SQL acima de 100 KB | `sql_too_large` |
| Nome de script repetido no projeto (sem diferenciar maiúsculas) | `duplicate_name` |
| CLI e app em versões de protocolo diferentes | `protocol_mismatch` |

Emoji com junção (ZWJ) ou seletor de variação também cai em `hidden_text`: use `CHAR()` ou `X'…'` para gravar esses valores.

Um script criado por agente segue as mesmas regras de um pedido com `--write` e não pode ter mais de duas linhas em branco seguidas (`invalid_script`).

## O que a pessoa vê

- **Modal de aprovação**, um pedido por vez, com "mais N na fila": "Agente pede para ler" ou "Agente pede para escrever", o selo de produção, ambiente e banco, o cliente informado e o motivo, e cada comando separado (número e tipo), com os alertas no topo. Linhas em branco em sequência aparecem como "⋯ N linhas em branco" e caracteres invisíveis como `⟨U+202E⟩`, sempre na ordem lógica. Se a lista não cabe, Aprovar só habilita depois de rolar até o fim. Se o SQL cita uma tabela não transacional (por exemplo MyISAM), o modal avisa que o Rollback não a desfaz.
- **"O agente pode ver o resultado"** vem marcado; desmarcado, a resposta traz `result_withheld: true` e só contagens.
- **Nada decide por tecla solta:** Recusar e Rollback têm o foco, Aprovar e Commit ficam desabilitados por 600 ms depois que o modal aparece, Enter não aprova e Esc deixa o pedido pendente (ele volta por "Revisar" no painel). Os modais esperam qualquer outro diálogo aberto fechar.
- **Modal do Commit:** cada comando inteiro, com as linhas afetadas, o contador do rollback automático, Rollback e Commit.
- **Notificação do sistema** e, com a janela sem foco, o aviso de atenção (no macOS o ícone pulando no Dock; no Linux e no Windows a janela pisca, `flashFrame`, até ganhar o foco), no máximo uma vez a cada 30 segundos, dizendo quantos pedidos esperam. Também avisa quando uma escrita automática ficou esperando o Commit.
- O painel Agentes e a Trilha mostram o commit automático como "commit feito (automático)".

## Limites

| Limite | Valor |
|---|---|
| Tempo de cada comando | 30 s no servidor (`max_execution_time`) e corte em 35 s pelo Cais (`KILL QUERY`), que cobre o que o `max_execution_time` não cobre (DML, `SET @x = (SELECT …)`, `SHOW … WHERE`) |
| Pedido de leitura | 60 s no total |
| Escrita aprovada | 60 s no total até a segunda decisão |
| Espera por lock numa escrita | 10 s (`innodb_lock_wait_timeout`) |
| Conexões de leitura por ambiente | Até 3, fechadas depois de 5 minutos ociosas, zeradas entre pedidos (`COM_RESET_CONNECTION`) |
| Linhas por comando | 1 a 1000 (padrão 200) |
| SQL | 100 KB |
| Pedidos pendentes | 20, cada um expira em 10 minutos |
| Decisão do Commit | Rollback automático em 2 minutos |
| Liberação de leituras | 15 minutos |
| Commit automático | 1.000 linhas afetadas por pedido e 5.000 em 15 minutos por ambiente |
| Pedidos lembrados para `status` | Os 100 mais recentes, em memória |

Cada sessão de agente fala só utf8mb4, com `sql_mode` sem `NO_BACKSLASH_ESCAPES` e `ANSI_QUOTES`, e reafirma isso (junto com o modo) antes de cada comando. Uma consulta presa não trava as próximas do mesmo ambiente.

## Códigos de saída

| Código | Significa | O que o agente faz |
|---|---|---|
| 0 | Sucesso: `succeeded`, `committed`, ou pedido pendente sem `--wait` | Segue. Se `pending_approval`, espera com `status <id> --wait`. |
| 1 | `failed`: erro do SQL, ou o Cais não conseguiu conectar no ambiente ou obter a credencial (`connection_failed`, `credential_unavailable`), ou erro interno (`internal_error`) | Lê `error.message` e `error.code`. Numa escrita, já houve rollback. |
| 2 | Uso, validação ou recusa da política (`code` diz qual) | Corrige o pedido. Não insiste no mesmo SQL. |
| 3 | `rejected`, `expired` ou `rolled_back` | Não repete sem mudar algo; conta à pessoa o que aconteceu. |
| 4 | Cais fechado ou acesso de agentes desligado: `cais_unavailable` (sem socket, ou o Cais não respondeu) ou `agent_access_off` (o acesso foi desligado durante o pedido) | Pede para a pessoa abrir o Cais e ligar o acesso. |
| 5 | Tempo de espera esgotado | O pedido segue valendo: `cais llm status <id> --wait`. |

Outros códigos de erro que o agente pode ver: `env_not_found` e `env_ambiguous` (use `cais llm envs` e o slug exato ou o id), `not_found`, `project_not_found`, `invalid_state`, `invalid_database`, `trail_unavailable` (a Trilha não pode ser gravada; nada de agente roda enquanto isso), `non_transactional_write` (a escrita gravou fora da transação e o pedido parou), `commit_unknown`, `invalid_params` (o servidor recusou os parâmetros) e `invalid_script`. Dentro de `error.code` de um pedido `failed` também aparecem `agent_timeout` (o Cais cortou um comando em 35 s ou o pedido passou do tempo total) e `commit_failed` (o Commit falhou e o servidor desfez a transação).

## O que o agente não deve fazer

A skill diz isso ao agente, e o Cais recusa ou percebe:

- ler a pasta de dados do Cais, o `agent-endpoint.json` ou falar com o socket direto;
- aprovar, recusar, dar Commit ou Rollback pela interface, ou simular cliques;
- ligar o acesso de agentes ou mudar o nível de um ambiente;
- editar `catalog.json`, `settings.json`, `seal.json` ou a Trilha (a proteção do cadastro percebe na próxima abertura e fecha o acesso daquele ambiente);
- contornar o Cais com o cliente `mysql`, `mycli`, drivers ou credenciais achadas em outro lugar;
- quebrar uma escrita grande em pedaços para fugir do limite do commit automático.

Um agente sem sandbox, rodando como o mesmo usuário, consegue fazer várias dessas coisas mesmo assim: a aprovação protege contra o agente que usa o comando, não contra um agente que ignora o comando. As recomendações (sandbox, regras de permissão, usuário de banco sem privilégios de administração) estão em [seguranca.md](seguranca.md#limites-conhecidos).
