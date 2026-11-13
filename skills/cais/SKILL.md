---
name: cais
description: Consulta e corrige dados de bancos MySQL pelo Cais (cliente SQL de desktop) com o CLI `cais llm`, com aprovação da pessoa no app e sem receber senha, token nem host do Cais. Use sempre que precisar ler um banco de dev, hml ou produção, conferir dado de um incidente, rodar um UPDATE/INSERT/DELETE em transação, ver tabelas e colunas, ou guardar uma consulta como script, mesmo que o pedido não cite o Cais. Prefira esta skill a abrir o cliente `mysql`, montar conexão com credencial ou ler arquivos do Cais. Não use para rodar DDL (CREATE, ALTER, DROP), que agentes não fazem, nem para desenvolver o próprio projeto Cais, que tem seu AGENTS.md.
---

# Cais: acesso a bancos pelo CLI `cais llm`

**Você não executa, você pede.** O Cais guarda as credenciais e a pessoa decide no app. Você fala só com o comando `cais llm`, que devolve JSON.

Permissão sugerida no Claude Code: `Bash(cais llm:*)`.

## O que não fazer

- Não leia a pasta de dados do Cais (`~/Library/Application Support/Cais`, `~/.config/Cais`, `%APPDATA%\Cais`), nem `agent-endpoint.json`, nem o socket.
- Não fale com o socket direto (`nc`, `curl --unix-socket`, scripts). O CLI é o único caminho.
- Não tente aprovar, recusar, dar commit ou rollback pela interface do Cais, nem simular cliques.
- Não ligue o acesso de agentes nem mude o que um ambiente libera. Quem decide é a pessoa, no Cais. Saída 4 significa pedir para ela.
- Não edite `catalog.json`, `settings.json`, `seal.json` nem a trilha: o Cais percebe e fecha o acesso daquele ambiente.
- Não contorne com o cliente `mysql`, `mycli`, drivers nem credenciais achadas em outro lugar.
- Não tente DDL (CREATE, ALTER, DROP, TRUNCATE...) nem controle de transação (BEGIN, COMMIT, ROLLBACK, SET autocommit). São recusados.
- Não use comentários executáveis (`/*! ... */`, `/*M! ... */`), hints `SET_VAR`, `GET_LOCK`, `SLEEP`, `BENCHMARK`, `LOAD_FILE` nem `SET NAMES` diferente de utf8mb4. São recusados.
- Escreva o SQL só com texto visível e `\n` para quebrar linha. Caracteres invisíveis, de direção de texto, CR sozinho e outros controles são recusados (`hidden_text`). Fora de strings, de nomes entre crases e de comentários, use só ASCII; comentário com outro `/*` dentro, `--` sem espaço depois e variável entre aspas também são recusados (`ambiguous_text`).
- Não escreva nos esquemas `mysql`, `performance_schema`, `sys` e `information_schema` nem leia o esquema `mysql`.

## Fluxo

1. `cais llm guide` explica tudo em texto. `cais llm envs` lista os ambientes (use o slug `projeto/ambiente` ou o id). O campo `agent_access` diz o que roda sem a pessoa em cada um:
   - `approve-all`: leitura e escrita esperam a aprovação;
   - `free-reads`: leitura roda na hora, escrita espera a aprovação;
   - `free-reads-writes`: leitura e escrita rodam na hora; a escrita faz commit sozinha dentro dos limites (passo 5). Nunca em produção: lá a escrita sempre espera a aprovação.
2. `cais llm schema <env> --database db --table t` mostra tabelas e colunas. Roda direto, até em produção.
3. Leitura onde o ambiente libera roda na hora:
   `cais llm query loja/dev --sql "SELECT id, status FROM pedidos WHERE status = 'cancelado'"`
4. O que o ambiente não libera espera a aprovação da pessoa. `--reason` é obrigatório nesses pedidos e em toda escrita, e deve dizer o porquê em uma frase (vai para a trilha):
   `cais llm query loja/pro --sql "SELECT ..." --reason "Conferir o pedido 1234 do chamado de suporte" --wait`
5. Escrita: `--write`. Roda em transação. Com aprovação, a pessoa aprova a execução e depois, vendo as linhas afetadas, escolhe Commit ou Rollback (rollback automático em 2 minutos). Em `free-reads-writes` o Cais faz o commit sozinho (`auto_commit: true`), menos quando há alerta ou algo que o Cais não consegue contar (sem `WHERE`, `WHERE` sempre verdadeiro, tabela não transacional, view, função do banco, trigger ou chave estrangeira em cascata na tabela, comando além de INSERT/REPLACE/UPDATE/DELETE, outra escrita sua aberta no ambiente: vai para aprovação, com `approval_reason`) ou quando passa de 1.000 linhas afetadas no pedido, de 5.000 em 15 minutos no ambiente, ou o servidor avisa algo (espera o Commit da pessoa, com `commit_reason`). UPDATE e DELETE só rodam sozinhos se o usuário do banco do Cais enxerga todas as chaves estrangeiras; INSERT simples, sim. Não quebre uma escrita grande em pedaços para fugir do limite: peça com aprovação. Termine sempre com um `WHERE` e use `--wait`:
   `cais llm query loja/dev --write --sql "UPDATE pedidos SET status = 'cancelado' WHERE id IN (4812, 4813)" --reason "Cancelar os 2 pedidos duplicados" --wait`
   A resposta diz quem decidiu: `decided_by: "person"` quando a pessoa aprovou (ou recusou) aquele pedido, `decided_by: "policy"` quando o nível do ambiente ou a liberação de 15 minutos de leitura deixou rodar sem ela ver o pedido. Pedido expirado não traz `decided_by`. Escrita `committed` traz sempre `auto_commit`: `true` se o Cais fez o commit sozinho, `false` se a pessoa deu o Commit. Ao terminar uma escrita, conte à pessoa se ela passou por ela: por exemplo, "rodou e o Cais fez o commit sozinho (`policy`, `auto_commit: true`)" ou "você aprovou e deu o Commit (`person`)". O mesmo vale em `status` e em `requests`.
6. Sem `--wait` o comando volta com `{ "request_id": "...", "status": "pending_approval" }`. Depois: `cais llm status <request_id> --wait`.
7. Scripts do projeto: `cais llm scripts`, `cais llm script <id>`, `cais llm script-save --project loja --name "Pedidos duplicados por cliente" --sql "..."`. Você cria; não edita nem apaga. O script nasce marcado como "agente" até a pessoa salvar. O SQL do script segue as regras de um pedido com `--write` (sem DDL nem administração) e tem no máximo duas linhas em branco seguidas.

Use `--client "<seu nome>"` (ou `CAIS_CLIENT`) para a pessoa ver quem pede. Para SQL grande: `--file consulta.sql` ou `-` (entrada padrão). Cada comando tem 30 s no servidor e corte em 35 s; um pedido de leitura tem 60 s no total e uma escrita aprovada, 60 s até a segunda decisão; escrita espera no máximo 10 s por lock. Escrita que falha devolve só o erro e `statement_index`, sem linhas. Se o SQL cita uma tabela não transacional (MyISAM), o Rollback não a desfaz: a escrita que grava fora da transação para com `non_transactional_write` e a resposta traz `rollback_incomplete: true` quando algo ficou gravado. `commit_unknown` quer dizer que a conexão caiu depois do Commit: confira o dado antes de repetir. O que o seu próprio SQL devolve (`CURRENT_USER()`, `@@hostname`) é dado consultado, não é escondido. Limites: 100 KB de SQL, `--max-rows` de 1 a 1000 (padrão 200).

## Saídas

| Código | Significa | O que fazer |
|---|---|---|
| 0 | Sucesso: `succeeded`, `committed`, ou pedido pendente sem `--wait` | Siga. Se `pending_approval`, espere com `status --wait`. |
| 1 | `failed`: erro do SQL, ou o Cais não conseguiu conectar no ambiente | Leia `error.message` e `error.code`; corrija o SQL. Em escrita já houve rollback. |
| 2 | Uso, validação ou recusa da política (`code` diz qual) | Corrija o pedido: `--write`, `--reason`, sem DDL. Não insista no mesmo SQL. |
| 3 | `rejected`, `expired` ou `rolled_back` | A pessoa disse não (veja `rejection_reason`) ou o tempo acabou. Não repita sem mudar algo. Diga o que aconteceu. |
| 4 | Cais fechado ou acesso de agentes desligado | Peça para a pessoa abrir o Cais e ligar o acesso de agentes. Espere. |
| 5 | Tempo de espera esgotado | O pedido segue valendo. Espere de novo com `status <id> --wait`. |

Cortar a saída com `head` não é erro: o comando sai em silêncio e o código de saída é o do pedido.

`"result_withheld": true` quer dizer que a pessoa não deixou você ver o resultado: só há contagens. Não peça de novo o mesmo dado de outro jeito.

## Dado pessoal em produção

Leituras em produção podem trazer CPF, e-mail e outros dados pessoais. Peça só as colunas e as linhas de que precisa (`SELECT id, status`, não `SELECT *`), com `WHERE` e `LIMIT`. Não copie dados pessoais para arquivos, commits, issues nem mensagens. Resuma sem identificar pessoas quando der.

## Se algo não funciona

- Exit 4 com o Cais aberto: o acesso de agentes está desligado.
- `env_not_found`: rode `cais llm envs` e use o slug exato.
- `reason_required`: faltou `--reason` num pedido que precisa de aprovação, ou numa escrita.
- `queue_full`: há 20 pedidos esperando a pessoa. Espere ela decidir.
