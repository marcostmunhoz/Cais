---
name: cais
description: Queries and fixes data in MySQL databases and queries BigQuery (read-only) through Cais (a desktop SQL client) using the `cais llm` CLI, with the user's approval in the app and without ever receiving a password, token or host from Cais. Use it whenever you need to read a dev, staging or production database, check data for an incident, run an UPDATE/INSERT/DELETE in a transaction, look at tables and columns, or save a query as a script, even if the request does not mention Cais. Prefer this skill over opening the `mysql` client, building a connection with credentials or reading Cais files. Do not use it to run DDL (CREATE, ALTER, DROP), which agents do not do, nor to develop the Cais project itself, which has its own AGENTS.md.
---

# Cais: database access through the `cais llm` CLI

**You do not execute, you request.** Cais holds the credentials and the user decides in the app. You talk only to the `cais llm` command, which returns JSON.

Suggested permission in Claude Code: `Bash(cais llm:*)`.

## What not to do

- Do not read the Cais data folder (`~/Library/Application Support/Cais`, `~/.config/Cais`, `%APPDATA%\Cais`), nor `agent-endpoint.json`, nor the socket.
- Do not talk to the socket directly (`nc`, `curl --unix-socket`, scripts). The CLI is the only path.
- Do not try to approve, reject, commit or roll back through the Cais interface, and do not simulate clicks.
- Do not turn agent access on and do not change what an environment allows. The user decides, in Cais. Exit 4 means asking the user.
- Do not edit `catalog.json`, `settings.json`, `seal.json` or the trail: Cais notices and closes access to that environment.
- Do not work around Cais with the `mysql` client, `mycli`, drivers or credentials found elsewhere.
- Do not attempt DDL (CREATE, ALTER, DROP, TRUNCATE...) or transaction control (BEGIN, COMMIT, ROLLBACK, SET autocommit). They are refused.
- Do not use executable comments (`/*! ... */`, `/*M! ... */`), `SET_VAR` hints, `GET_LOCK`, `SLEEP`, `BENCHMARK`, `LOAD_FILE` or `SET NAMES` with anything other than utf8mb4. They are refused.
- Write the SQL with visible text only and `\n` for line breaks. Invisible characters, text direction characters, a lone CR and other control characters are refused (`hidden_text`). Outside strings, backtick-quoted names and comments, use ASCII only; a comment with another `/*` inside, `--` without a space after it and a quoted variable are also refused (`ambiguous_text`).
- Do not write to the `mysql`, `performance_schema`, `sys` and `information_schema` schemas, and do not read the `mysql` schema.

## Flow

1. `cais llm guide` explains everything in text. `cais llm envs` lists the environments (use the `project/environment` slug or the id). The `agent_access` field says what runs without the user in each one:
   - `approve-all`: reads and writes wait for approval;
   - `free-reads`: reads run immediately, writes wait for approval;
   - `free-reads-writes`: reads and writes run immediately; the write commits by itself within the limits (step 5). Never in production: there, writes always wait for approval.
2. `cais llm schema <env> --database db --table t` shows tables and columns. It runs right away, without approval, even in production.
3. A read runs immediately where the environment allows it:
   `cais llm query loja/dev --sql "SELECT id, status FROM pedidos WHERE status = 'cancelado'"`
4. Anything the environment does not allow waits for the user's approval. `--reason` is required on those requests and on every write, and must say why in one sentence (it goes to the trail):
   `cais llm query loja/pro --sql "SELECT ..." --reason "Check order 1234 from the support ticket" --wait`
5. Writes: `--write`. A write runs in a transaction. With approval, the user approves the execution and then, seeing the affected rows, chooses Commit or Rollback (automatic rollback after 2 minutes). In `free-reads-writes` Cais commits by itself (`auto_commit: true`), except when there is an alert or something Cais cannot count (no `WHERE`, an always-true `WHERE`, a non-transactional table, a view, a database function, a trigger or cascading foreign key on the table, a statement other than INSERT/REPLACE/UPDATE/DELETE, another write of yours open in the environment: it goes to approval, with `approval_reason`) or when it goes over 1,000 affected rows in the request, over 5,000 in 15 minutes in the environment, or the server warns about something (it waits for the user's Commit, with `commit_reason`). UPDATE and DELETE only run by themselves if the database user Cais connects as can see all foreign keys; a simple INSERT runs by itself either way. Do not split a large write into pieces to get around the limit: ask with approval. Always finish with a `WHERE` and use `--wait`:
   `cais llm query loja/dev --write --sql "UPDATE pedidos SET status = 'cancelado' WHERE id IN (4812, 4813)" --reason "Cancel the 2 duplicate orders" --wait`
   The response says who decided: `decided_by: "person"` when the user approved (or rejected) that request, `decided_by: "policy"` when the environment level or the 15-min read grant let it run without the user seeing the request. An expired request has no `decided_by`. A `committed` write always carries `auto_commit`: `true` if Cais committed by itself, `false` if the user pressed Commit. When a write finishes, tell the user whether it went through them: for example, "it ran and Cais committed by itself (`policy`, `auto_commit: true`)" or "you approved and pressed Commit (`person`)". The same applies in `status` and in `requests`.
6. Without `--wait` the command returns `{ "request_id": "...", "status": "pending_approval" }`. Afterwards: `cais llm status <request_id> --wait`.
7. Project scripts: `cais llm scripts`, `cais llm script <id>`, `cais llm script-save --project loja --name "Duplicate orders per customer" --sql "..."`. You create; you do not edit or delete. The script is created tagged "agent" until the user saves it. The script's SQL follows the rules of a request with `--write` (no DDL or administration) and has at most two blank lines in a row.

Use `--client "<your name>"` (or `CAIS_CLIENT`) so the user sees who is asking. For large SQL: `--file query.sql` or `-` (standard input). Each statement has 30 s on the server and a cutoff at 35 s; a read request has 60 s in total and an approved write has 60 s until the second decision; a write waits at most 10 s for a lock. A write that fails returns only the error and `statement_index`, with no rows. If the SQL names a non-transactional table (MyISAM), Rollback does not undo it: a write that would change data outside the transaction stops with `non_transactional_write` and the response carries `rollback_incomplete: true` when something was left written. `commit_unknown` means the connection dropped after the Commit: check the data before repeating. What your own SQL returns (`CURRENT_USER()`, `@@hostname`) is queried data and is not hidden. Limits: 100 KB of SQL, `--max-rows` from 1 to 1000 (default 200).

## BigQuery (read-only)

An environment with `engine: "bigquery"` in `cais llm envs` is read in GoogleSQL, with no writes. The `default_database` is the default dataset; the Google Cloud project never appears, not even in error messages (`<project>`, `<account>`).

- **Writes:** `--write` returns `engine_read_only` (exit 2). There is no DML, DDL, `CREATE TEMP`, script (`DECLARE`, `BEGIN ... END`, `IF`, `LOOP`), `CALL`, `EXECUTE IMMEDIATE`, `EXPORT DATA` or `LOAD DATA`.
- **SQL:** backtick-quoted names and `dataset.table` (`project.dataset.table` only for another project). `--database` is the request's default dataset. `schema <env>` lists datasets and tables; `schema <env> --database ds` returns the columns with the full type.
- **Cost:** BigQuery bills for what it reads, and `LIMIT` does not reduce that. Select only the columns you need, filter on the partition column and avoid `SELECT *` on a large table. Each result carries `bytes_estimated`, `bytes_processed` and `bytes_billed`.
- **Large reads:** above 10 GiB estimated (or the environment limit, if smaller) the request waits for the user's approval, even in `free-reads` and with the 15-min grant, and needs `--reason`. `approval_reason` carries the estimate; use `--wait`. The sum of the request's estimates counts. The job runs with a cap of 10 GiB (or the environment limit, if smaller) or the approved estimate (in GiB, rounded up). If the estimate grows after approval and goes over the cap, the statement does not run: `bytes_over_approved`, and you can request it again.
- **Also wait for the user (`approval_reason`):** any project routine the server reports in the dry run (it may be remote and run code outside BigQuery), an unqualified function that is not built in, and the generative AI and model functions (`ML.*`, `AI.*`), which are billed on top of the bytes read.
- **Refused:** a statement the server reads as anything other than `SELECT` (`writes_in_read`); `EXTERNAL_QUERY` and `OBJ.*` (`function_not_allowed`); chained calls, such as `(x).f()` (`ambiguous_text`); `INFORMATION_SCHEMA.JOBS*`, `JOBS_BY_*` and `SESSIONS*`, which show other people's SQL in the project (`system_schema`); the `#legacySQL` and `#standardSQL` directives (`ambiguous_text` or `executable_comment`); triple-quoted strings (`'''` and `"""`) and a comment with `/*` inside (`ambiguous_text`); the rest of `hidden_text` as in MySQL.
- **Limits:** the job has 30 s on the server and a cutoff at 35 s (`jobs.cancel`, `agent_timeout`); `--max-rows` as usual.

## Exit codes

| Code | Means | What to do |
|---|---|---|
| 0 | Success: `succeeded`, `committed`, or a pending request without `--wait` | Continue. If `pending_approval`, wait with `status --wait`. |
| 1 | `failed`: SQL error, or Cais could not connect to the environment | Read `error.message` and `error.code`; fix the SQL. On a write, Cais has already rolled back. |
| 2 | Usage, validation or policy refusal (`code` says which) | Fix the request: `--write`, `--reason`, no DDL. Do not insist on the same SQL. |
| 3 | `rejected`, `expired` or `rolled_back` | The user said no (see `rejection_reason`) or time ran out. Do not repeat without changing something. Say what happened. |
| 4 | Cais is closed or agent access is off | Ask the user to open Cais and turn on agent access. Wait. |
| 5 | Wait timed out | The request is still valid. Wait again with `status <id> --wait`. |

Cutting the output with `head` is not an error: the command exits silently and the exit code is the request's.

`"result_withheld": true` means the user did not let you see the result: there are only counts. Do not ask for the same data again in another way.

## Personal data in production

Reads in production can return national IDs (CPF), emails and other personal data. Ask only for the columns and rows you need (`SELECT id, status`, not `SELECT *`), with `WHERE` and `LIMIT`. Do not copy personal data to files, commits, issues or messages. Summarize without identifying people when you can.

## If something does not work

- Exit 4 with Cais open: agent access is off.
- `env_not_found`: run `cais llm envs` and use the exact slug.
- `reason_required`: `--reason` is missing on a request that needs approval, or on a write.
- `queue_full`: 20 requests are waiting for the user. Wait for them to decide.
