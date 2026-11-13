# Roadmap

O que ficou fora do [plano de Linux e BigQuery](planos/linux-e-bigquery.md), com o motivo e o que cada item exige. Nada aqui tem data. Um item só entra quando houver uso, como diz o princípio "Poucas opções" em [comportamento.md](comportamento.md#princípios).

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
| **Campo de localização** | Só se o spike mostrar que a localização inferida pela consulta não basta. |
| **`EXTERNAL_QUERY`** | Liberar no Somente leitura se o spike confirmar que o banco externo roda em transação só de leitura. |
| **Strings de três aspas para agentes** | Realce do editor e do modal que leia `'''…'''` e `"""…"""` como o servidor. |
| **Resultados grandes em Arrow** | `queryResultsFormat: ARROW`, para buscar mais que 50.000 linhas sem pesar. |

## Técnico

| Item | Por quê |
|---|---|
| **`safeStorage` assíncrono** | A API síncrona (`isEncryptionAvailable`, `encryptString`, `decryptString`) sai no Electron 46: o `Vault` precisa virar assíncrono antes de atualizar o Electron. Quando `decryptStringAsync` pedir para cifrar de novo (`shouldReEncrypt`), a senha cifrada muda, e a assinatura dos ambientes que usam a credencial cobre esse texto: cifrar de novo e assinar de novo têm de ir na mesma gravação, ou os ambientes abrem bloqueados. No Linux, conferir como a API assíncrona aponta o provedor sem chaveiro, que a documentação não descreve. |
| **npm 12** | O npm 12 deixa de rodar scripts de instalação que não estão no `allowScripts`. Cada dependência nova com script precisa ser revisada (`npm install-scripts ls`). |

## Linux fora da escolha atual

| Item | Por que ficou fora |
|---|---|
| **AppImage** | O caminho do app muda a cada abertura, então o comando `cais` teria de ser copiado para um lugar fixo a cada versão, em vez de linkado. Não há instalação para pôr o perfil do AppArmor de que o sandbox do Chromium precisa no Ubuntu 24.04. |
| **rpm** | Fedora e openSUSE. Entra se alguém usar. |
| **arm64** | Dobra o build e o que testar. Entra com uma máquina Linux arm64 em uso. |
