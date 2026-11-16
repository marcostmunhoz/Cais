export const GUIDE = `Cais: acesso de agentes aos bancos, com aprovação da pessoa no app.

Você não executa, você pede. O Cais guarda as credenciais e não entrega senha, token nem host.
O que o seu próprio SQL devolve (CURRENT_USER(), @@hostname, SHOW PROCESSLIST) é dado consultado e não é escondido.
A pessoa decide no Cais (aprovar, recusar, e depois confirmar ou desfazer uma escrita).

Fluxo
  1. cais llm envs                      lista projetos e ambientes (slug "projeto/ambiente", produção, banco padrão
                                        e agent_access: o que roda sem a pessoa naquele ambiente)
  2. cais llm schema <env> [--database db] [--table t]
                                        tabelas e colunas (só metadados; roda direto em qualquer ambiente)
  3. cais llm query <env> --sql "SELECT ..."
                                        roda na hora onde agent_access libera leitura (free-reads, free-reads-writes)
  4. O que o ambiente não libera espera a aprovação da pessoa (em produção, escrita sempre espera):
       cais llm query loja/pro --sql "SELECT ..." --reason "motivo" --wait
       cais llm query loja/hml --write --sql "UPDATE ..." --reason "motivo" --wait
     --reason é obrigatório quando precisa de aprovação e em toda escrita (fica na trilha). Sem --wait o
     comando volta na hora com { "request_id": "...", "status": "pending_approval" }; depois use:
       cais llm status <request_id> --wait
  5. Escrita roda em transação. Com aprovação, a pessoa vê as linhas afetadas e decide Commit ou Rollback
     (rollback automático em 2 minutos). Em free-reads-writes a escrita roda sem aprovação e o Cais faz o
     commit sozinho ("auto_commit": true), menos quando há alerta antes (sem WHERE, WHERE sempre verdadeiro,
     tabela não transacional, view, função do banco, trigger ou chave estrangeira em cascata na tabela, outro
     comando além de INSERT, REPLACE, UPDATE e DELETE, UPDATE ou DELETE sem o Cais enxergar todas as chaves
     estrangeiras, outra escrita sua aberta no ambiente: vai para aprovação,
     com "approval_reason") ou quando, depois de rodar, passa de 1000 linhas afetadas no pedido ou de 5000 em
     15 minutos no ambiente, ou o servidor avisa algo (espera o Commit da pessoa, com "commit_reason").
     Use --wait em toda escrita.
     A resposta diz quem decidiu: "decided_by": "person" (a pessoa aprovou ou recusou aquele pedido) ou "policy"
     (o nível do ambiente, ou a liberação de 15 minutos de leitura, deixou rodar sem a pessoa ver o pedido). Pedido
     expirado não traz "decided_by". Escrita com "committed" traz sempre "auto_commit": true (commit automático)
     ou false (a pessoa deu o Commit). Conte à pessoa se a escrita passou por ela.

Comandos
  cais llm query <env> (--sql "<sql>" | --file <arquivo> | -) [--write] [--reason "<motivo>"]
                       [--database db] [--max-rows N] [--wait] [--timeout 600] [--client "Claude Code"]
  cais llm status <request_id> [--wait] [--timeout 600]
  cais llm requests [--limit 20]
  cais llm scripts [--project <projeto>]
  cais llm script <script_id>
  cais llm script-save --project <projeto> --name "<nome>" (--sql "<sql>" | --file <arquivo> | -) [--database db]

Regras
  - <env> aceita o id ou o slug "projeto/ambiente".
  - Leitura: --max-rows vai de 1 a 1000 (padrão 200).
  - Não há DDL (CREATE, ALTER, DROP...) nem controle de transação (BEGIN, COMMIT, SET autocommit...).
  - Também são recusados: comentários executáveis do MySQL e do MariaDB (os que abrem com barra, asterisco e
    ponto de exclamação), comentário com outro /* dentro, hints SET_VAR/MAX_EXECUTION_TIME,
    GET_LOCK, RELEASE_LOCK, SLEEP, BENCHMARK, LOAD_FILE, SET NAMES que não seja utf8mb4, escrita nos esquemas
    do sistema (mysql, performance_schema, sys, information_schema), leitura do esquema mysql e SQL com
    caracteres invisíveis, de direção de texto, espaços que não sejam o espaço comum ou quebras de linha que não
    sejam \\n. Fora de strings e de nomes entre crases, use só ASCII.
  - A pessoa pode aprovar sem deixar você ver o resultado: a resposta traz "result_withheld": true e só contagens.
  - Scripts: você pode listar, ler e criar. Não edita nem apaga.
  - Tudo o que você pede fica na trilha do Cais, com o SQL, o motivo e as contagens.
  - Limites: cada comando tem 30 s no servidor e corte em 35 s; um pedido de leitura, 60 s no total; uma escrita
    aprovada, 60 s até a segunda decisão; escrita espera no máximo 10 s por lock; schema tem cache de 60 s.
  - Escrita que grava fora da transação (tabela não transacional) para o pedido: code non_transactional_write.
  - Escrita que falha devolve só o erro e o índice do comando (statement_index); os resultados vêm depois do Commit.
  - Se o SQL cita uma tabela não transacional (MyISAM), o Rollback não a desfaz; a resposta traz "rollback_incomplete": true quando isso aconteceu.
  - Toda saída é JSON na saída padrão, inclusive erros: { "error": "...", "code": "..." }.
  - Fechar a saída antes do fim (| head) não é erro: o comando sai em silêncio com o mesmo código.
  - Dado pessoal em produção: peça só as colunas que precisa.

BigQuery (ambiente com "engine": "bigquery"; "default_database" é o dataset padrão; o projeto do Google Cloud não aparece)
  - Só leitura nesta versão. --write volta com code engine_read_only (saída 2), em qualquer ambiente BigQuery.
  - GoogleSQL: nomes entre crases e \`dataset.tabela\` (\`projeto.dataset.tabela\` se for de outro projeto). --database é o dataset
    padrão do pedido. schema lista datasets e tabelas; com --database, as colunas com o tipo completo (STRUCT<...>, ARRAY<...>).
  - Cada comando passa por uma estimativa (dry run) antes de decidir. O BigQuery cobra pelo que lê, e LIMIT não reduz isso:
    prefira filtrar por partição, selecionar só as colunas de que precisa e evitar SELECT *.
  - Leitura estimada acima de 10 GiB (ou acima do limite do ambiente, se for menor) espera a aprovação da pessoa, mesmo em
    free-reads e com a liberação de 15 minutos, e precisa de --reason. A soma das estimativas do pedido é que conta, não só
    a maior. A resposta traz "approval_reason" com a estimativa. O job roda com teto de 10 GiB (ou do limite do ambiente, se
    for menor), ou da estimativa aprovada arredondada para cima em GiB. Se a estimativa crescer depois e passar do teto, o
    comando não roda: code bytes_over_approved (peça de novo).
  - Também esperam a aprovação (com "approval_reason"): função definida no projeto (pode ser remota e rodar código fora do
    BigQuery), função sem qualificador que não é nativa e funções de IA generativa e de modelo (ML.*, AI.*), que custam fora
    dos bytes lidos.
  - Recusados: tudo o que não é consulta (INSERT, UPDATE, DELETE, MERGE, DDL, CREATE TEMP, scripts como DECLARE, BEGIN ... END,
    IF e LOOP, CALL, EXECUTE IMMEDIATE, EXPORT DATA, LOAD DATA) com writes_in_read ou ddl_or_transaction; o comando que o servidor
    lê como outra coisa que não SELECT (writes_in_read); EXTERNAL_QUERY e OBJ.* (function_not_allowed); chamada encadeada, como (x).f() (ambiguous_text); INFORMATION_SCHEMA.JOBS*, JOBS_BY_*
    e SESSIONS* (system_schema: mostram o SQL de outras pessoas do projeto); #legacySQL e #standardSQL (ambiguous_text ou
    executable_comment); strings de três aspas e comentário com /* dentro (ambiguous_text). Strings simples e cruas sem barra
    invertida passam.
  - Cada resultado traz "bytes_estimated", "bytes_processed" e "bytes_billed". Com "result_withheld", só contagens.
  - Erros saem sem o id do projeto (<projeto>) e sem e-mails de conta (<conta>). O job tem 30 s no servidor e corte em 35 s
    (jobs.cancel); a saída do MySQL não muda.

Saídas (o código vale mesmo com a saída cortada por | head)
  0  sucesso (succeeded, committed, ou pedido pendente sem --wait)
  1  failed (inclui não conseguir conectar no ambiente)
  2  uso, validação ou recusa da política
  3  rejected, expired ou rolled_back
  4  Cais fechado ou acesso de agentes desligado: peça para a pessoa abrir o Cais e ligar o acesso
  5  tempo de espera esgotado (o pedido segue valendo; espere de novo com "cais llm status <id> --wait")
`;
