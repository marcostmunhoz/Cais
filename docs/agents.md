# Agent access

AI agents with a shell (Claude Code and others) query data and, with the user's approval, fix it through the `cais llm` command. The model is simple: **the agent asks, the user decides in Cais**. Cais keeps the credentials and never hands the command a password, token, host or credential id. What the agent's own SQL returns (`CURRENT_USER()`, `@@hostname`, `SHOW PROCESSLIST`, `enum` values in the schema) is queried data like any other and is not hidden.

The security model behind this, with its known limits, is in [security.md](security.md).

## Turn on and install

1. In Cais, open **Agents** (at the bottom of the sidebar) and turn on **Agent access**. Access is off by default and only the user turns it on, in the app; while it is off, the socket does not even exist. The status bar shows "Agents on".
2. Menu **Cais › Install cais Command in Terminal** (on Linux and Windows, the **File** menu). Cais creates a `cais` link to the app's `cais.mjs` in `/usr/local/bin` if it can write there, otherwise in `~/.local/bin`, and warns when the folder is not in the PATH. In the Linux deb the command does not ship in the package: this menu is the way to install it, and in practice it creates the link in `~/.local/bin` (`/usr/local/bin` is usually root's). It never overwrites a file or link that is not Cais's own. On Windows the item is disabled: use `node <path>/cais.mjs`. The command runs on the system's Node, version 20 or newer.
3. In development, without installing: `npm run cli -- llm envs` (rebuilds the CLI and runs it; it needs Cais open with `npm run dev` and access on).
4. Give the agent the skill [skills/cais/SKILL.md](../skills/cais/SKILL.md). In Claude Code, the suggested permission is `Bash(cais llm:*)`.

**Turning access off** closes the socket immediately: pending requests expire, open agent transactions are rolled back, reads in progress are interrupted, no new connection opens and the 15-minute grants go away. Quitting the app does the same.

## How the CLI finds Cais

The CLI talks to the running Cais over a local socket, one JSON line per message. Cais writes `agent-endpoint.json` in the data folder when access is on, and the CLI reads it:

| System | Data folder |
|---|---|
| macOS | `~/Library/Application Support/Cais` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/Cais` |
| Windows | `%APPDATA%\Cais` |

`CAIS_SOCKET` points the CLI at another socket. The app only accepts this variable when it is not packaged (it is the tests' hook).

## Commands

```
cais llm guide
cais llm envs
cais llm schema <env> [--database db] [--table t]
cais llm query <env> (--sql "<sql>" | --file <file> | -) [--write] [--reason "<reason>"] [--database db]
                     [--max-rows N] [--wait] [--timeout 600]
cais llm status <request_id> [--wait] [--timeout 600]
cais llm requests [--limit 20]
cais llm scripts [--project <project>]
cais llm script <script_id>
cais llm script-save --project <project> --name "<name>" (--sql "<sql>" | --file <file> | -) [--database db]
```

All of them accept `--client "<name>"` (or the `CAIS_CLIENT` variable; default "agente", shown as "agent" in the English UI), which shows up in the modal as "as stated by the client" and goes to the Trail.

| Command | What it does |
|---|---|
| `guide` | The flow, the rules and the exit codes, as text. Does not need Cais open. |
| `envs` | Lists the environments: `id`, `slug` (`project/environment`), `project`, `name`, `production`, `engine`, `agent_access` and `default_database`. No host, user or credential. |
| `schema` | Databases and tables of the environment (metadata only). Without `--database`, only the table names; with `--database` or `--table`, the columns (`name`, `type`, `nullable`, `key`). Runs directly in any environment, production included, and goes to the Trail. 60 s cache per environment. |
| `query` | Runs SQL. Without `--write` it is a read; with `--write`, a write in a transaction. |
| `status` | The state of a request. With `--wait`, waits for the final state. |
| `requests` | The recent requests, `--limit` from 1 to 100 (default 20; up to 100 are kept in Cais's memory): `request_id`, `status`, `environment`, `production`, `mode`, `created_at`, the first line of the SQL and `decided_by`/`auto_commit`. |
| `scripts`, `script` | Lists the saved scripts (of one project, with `--project`) and reads one, with its SQL. |
| `script-save` | Creates a script in the project, marked "agent" until the user saves it. Only creates: a repeated name is refused (`duplicate_name`), and agents do not edit or delete scripts. |

`query` options:

| Option | What it does |
|---|---|
| `<env>` | The id or the `project/environment` slug. The slug compares in NFC, lowercasing ASCII only. |
| `--sql`, `--file`, `-` | The SQL, through exactly one of the three (`-` reads standard input). Up to 100 KB. |
| `--write` | Asks to write. Without it, SQL that writes is refused (`writes_in_read`). On a BigQuery environment, with it, the request is refused (`engine_read_only`). |
| `--reason` | The reason, in one sentence. Required on every write and on every request that needs approval. Goes to the modal and to the Trail. |
| `--database` | Runs `USE` first. On BigQuery it is the request's default dataset. |
| `--max-rows` | Rows per statement, from 1 to 1000 (default 200). Outside that range it is a usage error, not silently cut. |
| `--wait` | Waits for the final state (`awaiting_commit` is intermediate). Without it, a request that needs approval returns right away with `{ "request_id": "...", "status": "pending_approval" }`. |
| `--timeout` | Seconds to wait with `--wait`, from 1 to 3600 (default 600). When it runs out, exits with code 5 and the request stays valid. |

## Output

All output, except the `guide` (text), is JSON on standard output, one line, errors included: `{ "error": "...", "code": "..." }`. Cutting the output with `head` is not an error: the command exits silently and the exit code is the request's. The texts are always in English; the codes are the contract.

`query` and `status` response:

| Field | When it appears | Meaning |
|---|---|---|
| `request_id`, `status`, `environment`, `production`, `mode`, `database` | Always (`database` if present) | The request |
| `expires_at` | `pending_approval` | When the request expires without an answer |
| `rollback_at` | `awaiting_commit` | When the automatic rollback happens |
| `decided_by` | Decided request | `person` (the user approved or rejected in the modal) or `policy` (the environment level or the 15-minute grant let it run without the user seeing that request). An expired request does not carry it. |
| `auto_commit` | `committed` write | `true` if Cais committed by itself, `false` if the user clicked Commit |
| `approval_reason` | Request that waits for the user for a reason beyond the level | Why it waits (warning, view, trigger, Trail down; on BigQuery, a read estimated above 10 GiB or above the environment limit, project function, non-native function, `ML.*`/`AI.*`) |
| `commit_reason` | Automatic write that stopped before the commit | Why it waits for the user's Commit (too many rows, server warning...) |
| `rejection_reason` | `rejected` or `expired` | The reason typed by the user, or Cais's reason (for example, "The environment changed.") |
| `rollback_reason` | `rolled_back` | `timeout`, `user`, `shutdown`, `access_off` or `unexpected_commit` |
| `rollback_incomplete` | Rollback that did not undo everything | The server warned that non-transactional tables kept what was written |
| `error` | `failed` | `message`, `code` and, on a write, `statement_index` (the statement that failed) |
| `timed_out` | `--wait` ran out | The request stays valid |
| `results` | `succeeded`, `committed` and `failed` read | One item per statement: `index`, `sql`, `verb`, `kind`, `duration_ms`, `columns` (`name` and `type`), `rows`, `row_count`, `truncated`, `affected_rows`, `insert_id`, `warnings`, `error`; on BigQuery, also `bytes_estimated`, `bytes_processed` and `bytes_billed` (absent with `result_withheld`) |
| `result_withheld` | The user cleared "The agent can see the result" | `results` carries only counts (`row_count`, `affected_rows`), with no columns or values, and server errors only with the code |

The result of a write only arrives after the Commit. A write that fails returns only the error and the statement index; on rollback, rejection or expiry no result arrives at all. Connection errors are generic: no host, IP, database user or `gcloud` text.

## Request lifecycle

```
pending_approval ──▶ rejected | expired
        │
        ▼
     running ──▶ read: succeeded | failed
        │
        └──▶ write: awaiting_commit ──▶ committed | rolled_back
                    (or failed, or succeeded if no transaction was left open)
```

- A pending request expires in **10 minutes**. With more than **20** pending, the next one is refused (`queue_full`).
- A write runs all its statements in one transaction, on the agent's own connection (never in the user's tabs), and stops at the first error, with rollback. With no error and an open transaction, it becomes `awaiting_commit`: the user sees the affected rows per statement and chooses **Commit** or **Rollback**. Rollback is the default and is **automatic after 2 minutes**, so as not to hold locks.
- `commit_unknown` means the connection dropped after the Commit was sent: check the database before repeating.
- Editing or deleting an environment (host, port, credential, default database, production, name or Cais project; on BigQuery, also the Google Cloud project and the byte limit) or the credential it uses revokes its grants, expires the pending requests ("The environment changed.") and closes the agents' connections to it.

## Levels per environment

Each environment has the **Agent access** field in the registry. The Agents panel shows each one's level under "By environment", and `cais llm envs` returns the code in `agent_access`.

| Level (`agent_access`) | Read | Write |
|---|---|---|
| **Everything needs approval** (`approve-all`) | Asks for approval | One approval per request, then Commit or Rollback |
| **Reads allowed, writes need approval** (`free-reads`) | Runs right away | One approval per request, then Commit or Rollback |
| **Reads and writes allowed** (`free-reads-writes`) | Runs right away | Runs in a transaction and Cais commits by itself, within the limits below |

- **Outside production**, the default is *Reads allowed, writes need approval*.
- **On production, an agent write always asks for approval.** The field only offers the first two levels and starts at *Everything needs approval*; checking "Production" sets the field back to it. Allowing reads on production is an explicit choice by the user: agent reads already run in a read-only session, reclassified in the main process, and go to the Trail. The main process stores *Everything needs approval* for production when *Reads and writes allowed* arrives, and the policy treats production with no level or with writes allowed as *Everything needs approval*, whatever the file says.
- **Schema reads** run directly at every level.
- **The 15-minute grant**: in the modal of a read that asked for approval, the checkbox "Approve reads on <environment> for 15 min" allows the next reads of that environment. It only exists with "The agent can see the result" checked (with the result withheld, 15 minutes of unreviewed reads would reconstruct the data from the row count). It does not approve what is already in the queue, applies only to reads, lives in memory (restarting the app clears it), can be revoked in the panel and goes to the Trail (created, revoked, expired).

### Auto-commit on "Reads and writes allowed"

The level is meant for one-off fixes in simple tables. Cais only commits by itself what it can count and undo.

**Before running, the write goes to the user for approval** (with the reason in the modal and in `approval_reason`) when:

- there is any warning: `UPDATE`/`DELETE` without `WHERE`, an always-true `WHERE` (`WHERE 1`, `TRUE`, `x = x`, `OR 1=1`), a non-transactional table reached directly, through a view or through a trigger;
- the request has anything besides `INSERT`, `REPLACE`, `UPDATE` and `DELETE` (a `SELECT f()` or `SET @x = f()` can write);
- the statement calls a database function or uses a view;
- the table has a trigger, or is referenced by a cascading foreign key (the server does not count those rows among the affected ones);
- the database user cannot see the triggers (without the `TRIGGER` privilege, including when a `partial_revokes` removes it from one database);
- it is an `UPDATE`, `DELETE`, `REPLACE` or `ON DUPLICATE KEY UPDATE` and Cais cannot see all the foreign keys that could cascade (for that the database user needs the `PROCESS` privilege, which gives access to the InnoDB list, or a global privilege without partial revoke). A plain `INSERT` never cascades and stays allowed;
- part of the metadata could not be read;
- an agent write is already open in the environment (one at a time);
- the Trail cannot be written.

The metadata for this decision is read on the spot, without the 60 s cache.

**After running, the write waits for the user's Commit** (2-minute clock, reason in `commit_reason`) when it went past **1,000 affected rows** in the request, past **5,000 in 15 minutes** summing the environment's automatic commits, when the server gave a warning (value truncated or converted) or when the environment's level or production mark changed during the request. The 15-minute count lives in memory. Affected rows count the rows matched by the `WHERE`, which can overcount: the safe side.

In practice, it depends on the database user Cais uses in the environment: without `TRIGGER`, no write runs by itself; with `TRIGGER` but without `PROCESS` (or a global privilege), only a plain `INSERT` runs by itself; with both, `INSERT`, `UPDATE` and `DELETE` on simple tables run by themselves. `PROCESS` also lets that database user see the statements of other connections (`SHOW PROCESSLIST`), so weigh it before granting it.

## What is refused

The main process reclassifies each statement with the dialect; nothing the client says about the SQL is trusted. Refusals and usage errors exit with code 2.

| Request | `code` |
|---|---|
| Unknown option, value out of range, empty or whitespace-only `--sql`, more than one SQL source | `usage` |
| A `--file` that cannot be opened | `file_unreadable` |
| SQL with no statement (for example, only comments) | `empty_sql` |
| Read (`query` without `--write`) with something not allowed in read-only (on BigQuery, also a statement that the server's dry run does not read as `SELECT`) | `writes_in_read` |
| `--write` on an environment of a read-only engine (BigQuery) | `engine_read_only` |
| DDL, statement with implicit commit, transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`, `SET autocommit`...) | `ddl_or_transaction` |
| In a write, anything besides `INSERT`, `REPLACE`, `UPDATE`, `DELETE` and safe reads (`CALL`, `LOAD`, `SELECT … FOR UPDATE`, `INTO OUTFILE`, `KILL`, `DO`...) | `command_not_allowed` |
| Executable comment (`/*! … */`, `/*M! … */`); on BigQuery, the `#legacySQL` or `#standardSQL` directive when it reaches the policy | `executable_comment` |
| `GET_LOCK`, `RELEASE_LOCK`, `RELEASE_ALL_LOCKS`, `SLEEP`, `BENCHMARK`, `LOAD_FILE`, functions that change server state, `SET_VAR` and `MAX_EXECUTION_TIME` hints; on BigQuery, `EXTERNAL_QUERY` and `OBJ.*` | `function_not_allowed` |
| Write to `mysql`, `performance_schema`, `sys` or `information_schema`; read of the `mysql` schema or `SHOW CREATE USER`; on BigQuery, write to `INFORMATION_SCHEMA` and read of `INFORMATION_SCHEMA.JOBS*` and `SESSIONS*` | `system_schema` |
| SQL with an invisible character, a text-direction character, a space other than the plain space, a line break other than `\n` (lone CR, U+2028, VT, FF) or a control character | `hidden_text` |
| Text that the server and the review would read differently: a non-ASCII character outside strings, backtick names and comments; a non-ASCII variable or function name; a comment with another `/*` inside; `--` without a space right after; a quoted variable (`@'x'`); on BigQuery, also a triple-quoted string, a raw string with a backslash (write `'\\d+'` instead of `r'\d+'`), a bytes string, an `x` letter stuck to a string, a backtick name with a backslash, `--` without a space after, a quoted parameter and the `#legacySQL` or `#standardSQL` directive | `ambiguous_text` |
| `SET NAMES`/`SET CHARACTER SET` other than utf8mb4 | `writes_in_read` or `command_not_allowed` |
| Missing `--reason` | `reason_required` |
| More than 20 pending | `queue_full` |
| SQL above 100 KB | `sql_too_large` |
| Repeated script name in the project (case-insensitive) | `duplicate_name` |
| CLI and app on different protocol versions | `protocol_mismatch` |

An emoji with a joiner (ZWJ) or a variation selector also falls under `hidden_text`: use `CHAR()` or `X'…'` to write those values.

A script created by an agent follows the same rules as a request with `--write` and cannot have more than two blank lines in a row (`invalid_script`). In a project with MySQL and BigQuery environments, the script has to pass the text rules of every engine in the project and be accepted by at least one of them.

## What the user sees

- **Approval modal**, one request at a time, with "N more in the queue": "Agent asks to read" or "Agent asks to write", the Production badge, environment and database, the client name as stated and the reason, and each statement separately (number and kind), with the warnings at the top. Consecutive blank lines show as "⋯ N blank lines" and invisible characters as `⟨U+202E⟩`, always in logical order. If the list does not fit, Approve only enables after scrolling to the end. If the SQL names a non-transactional table (for example MyISAM), the modal warns that Rollback does not undo it.
- **"The agent can see the result"** comes checked; cleared, the response carries `result_withheld: true` and only counts.
- **Nothing is decided by a stray key:** Reject and Rollback have the focus, Approve and Commit stay disabled for 600 ms after the modal appears, Enter does not approve and Esc leaves the request pending (it comes back through "Review" in the panel). The modals wait for any other open dialog to close.
- **Commit modal:** each full statement, with the affected rows, the automatic rollback countdown, Rollback and Commit.
- **System notification** and, with the window unfocused, the attention alert (on macOS the icon bouncing in the Dock; on Linux and Windows the window flashes, `flashFrame`, until it gets focus), at most once every 30 seconds, saying how many requests are waiting. It also warns when an automatic write is left waiting for the Commit.
- The Agents panel and the Trail mark the automatic commit as "(automatic)" next to Committed.

## BigQuery

An environment with `engine: "bigquery"` is read-only in this version. `cais llm envs` shows `default_database` as the default dataset and never the Google Cloud project. `schema` lists datasets and tables; with `--database`, the columns with their full type. `--database` in `query` is the request's default dataset.

- **`--write`:** refused with `engine_read_only` (exit 2), on any BigQuery environment.
- **Dry run before deciding:** each statement goes through a dry run on the server (`jobs.insert` with `dryRun`), which gives the statement type, the estimated bytes and the routines used. A statement that the server reads as anything other than `SELECT` is refused (`writes_in_read`), even if the app's classifier let it through. A dry run that fails (table that does not exist, permission, timeout) decides nothing: the request goes on and the error comes at execution. If the execution's dry run finds a routine that nobody approved, the statement does not run (`routine_not_approved`; ask again).
- **Large read:** with more than **10 GiB** estimated (fixed, summing the request's statements) the request waits for the user's approval, even at *Reads allowed*, under the 15-minute grant and in an environment with no limit. The same applies above the environment limit, when that limit is below 10 GiB. `approval_reason` carries the estimate, the modal shows each statement's estimate, and the request needs `--reason`. The 15-minute grant still applies to small reads.
- **Job cap:** the agent's job runs with `maximumBytesBilled` of 10 GiB, or of the environment limit when it is smaller; a request the user approved because of the bytes raises the cap to the approved estimate rounded up to GiB. A dry run that failed gives no estimate, and the job stays at the smaller cap. Never without a cap. When running, Cais repeats the dry run: if the estimate went past the cap, the statement does not run and the request fails with `bytes_over_approved`, with no charge.
- **Also wait for the user (`approval_reason`):** any routine the server's dry run points out (a function defined in the project; the routine called inside a view should appear, but this has not yet been checked against the real server, see the limit in [security.md](security.md#bigquery-read-only); it can be remote and run code outside BigQuery; the reason cites `dataset.routine`, without the project), a call to a project-defined function that the classifier sees, an unqualified function that is not native to GoogleSQL (a name not reviewed, maybe a new built-in that calls outside BigQuery) and the generative AI and model ones (`ML.*`, `AI.*`), which cost beyond the bytes read.
- **Refused:** `INFORMATION_SCHEMA.JOBS*` and `SESSIONS*`, which show the SQL of other people in the project (`system_schema`); `EXTERNAL_QUERY` and `OBJ.*` (`function_not_allowed`: `OBJ.GET_ACCESS_URL` hands over a signed URL, which works as a credential); a chained call such as `(x).f()` or `(x).(ds.f)()` (`ambiguous_text`: the review cannot see which function runs); `#legacySQL` and `#standardSQL` (`ambiguous_text`, or `executable_comment` when it reaches the policy); triple-quoted strings and a comment with `/*` inside (`ambiguous_text`); hidden characters (`hidden_text`). The rest of what is not a query falls under the usual refusals (`writes_in_read`, `ddl_or_transaction`). An agent that reads a BigQuery environment gets, in the output, the fields `bytes_estimated`, `bytes_processed` and `bytes_billed` per statement (see [Output](#output)). The refusal reasons are in fixed English, as with MySQL.
- **Redaction:** errors and texts that go to the agent come out without the project id (`<project>`) and without account or service account emails (`<account>`). The server's text, which may cite row values, only arrives with "The agent can see the result".
- **Output:** on BigQuery, each item of `results` also carries `bytes_estimated`, `bytes_processed` and `bytes_billed`. With the result withheld, only counts. The MySQL output does not have these fields.
- **Limits:** `jobTimeoutMs` of 30 s and a cut at 35 s by `jobs.cancel`, 60 s per request, `--max-rows` as in MySQL. The job carries the label `cais: agent`.
- **Trail:** the agent's lines carry the job id and the estimated and billed bytes, per statement; on the request's line, the summed bytes and the job id only when there was a job.

## Limits

| Limit | Value |
|---|---|
| Time per statement | 30 s on the server (`max_execution_time`; on BigQuery, `jobTimeoutMs`) and a cut at 35 s by Cais (`KILL QUERY`; on BigQuery, `jobs.cancel`), which covers what `max_execution_time` does not (DML, `SET @x = (SELECT …)`, `SHOW … WHERE`) |
| Read request | 60 s total |
| Approved write | 60 s total until the second decision |
| Lock wait on a write | 10 s (`innodb_lock_wait_timeout`) |
| Read connections per environment | Up to 3, closed after 5 idle minutes, reset between requests (`COM_RESET_CONNECTION`) |
| Rows per statement | 1 to 1000 (default 200) |
| SQL | 100 KB |
| Large read on BigQuery | Estimated above 10 GiB (`AGENT_BYTES_APPROVAL`, fixed) or the environment limit, whichever is smaller: waits for the user. The job carries `maximumBytesBilled` of 10 GiB, of the environment limit (if smaller) or of the approved value |
| Pending requests | 20, each expires in 10 minutes |
| Commit decision | Automatic rollback in 2 minutes |
| Read grant | 15 minutes |
| Auto-commit | 1,000 affected rows per request and 5,000 in 15 minutes per environment |
| Requests remembered for `status` | The 100 most recent, in memory |

Each agent session speaks only utf8mb4, with `sql_mode` without `NO_BACKSLASH_ESCAPES` and `ANSI_QUOTES`, and restates this (along with the mode) before each statement. A stuck query does not block the next ones in the same environment.

## Exit codes

| Code | Meaning | What the agent does |
|---|---|---|
| 0 | Success: `succeeded`, `committed`, or a pending request without `--wait` | Moves on. If `pending_approval`, waits with `status <id> --wait`. |
| 1 | `failed`: SQL error, or Cais could not connect to the environment or get the credential (`connection_failed`, `credential_unavailable`), or an internal error (`internal_error`) | Reads `error.message` and `error.code`. On a write, a rollback already happened. |
| 2 | Usage, validation or policy refusal (`code` says which) | Fixes the request. Does not insist on the same SQL. |
| 3 | `rejected`, `expired` or `rolled_back` | Does not repeat without changing something; tells the user what happened. |
| 4 | Cais closed or agent access off: `cais_unavailable` (no socket, or Cais did not respond) or `agent_access_off` (access was turned off during the request) | Asks the user to open Cais and turn access on. |
| 5 | Wait time ran out | The request stays valid: `cais llm status <id> --wait`. |

Other error codes the agent can see: `env_not_found` and `env_ambiguous` (use `cais llm envs` and the exact slug or the id), `not_found`, `project_not_found`, `invalid_state`, `invalid_database`, `engine_read_only` (`--write` on an environment of a read-only engine, BigQuery; exit 2), `trail_unavailable` (the Trail cannot be written; no agent request runs meanwhile), `non_transactional_write` (the write wrote outside the transaction and the request stopped), `commit_unknown`, `invalid_params` (the server refused the parameters) and `invalid_script`. The `error.code` of a `failed` request can also be `bytes_over_approved` (BigQuery: a read's estimate went past the approved cap before running; nothing was charged, ask again), `agent_timeout` (Cais cut a statement at 35 s or the request went past the total time) and `commit_failed` (the Commit failed and the server rolled the transaction back).

## What the agent must not do

The skill tells the agent this, and Cais refuses or notices:

- read Cais's data folder or `agent-endpoint.json`, or talk to the socket directly;
- approve, reject, Commit or Rollback through the interface, or simulate clicks;
- turn on agent access or change an environment's level;
- edit `catalog.json`, `settings.json`, `seal.json` or the Trail (the registry protection notices on the next open and blocks that environment);
- go around Cais with the `mysql` client, `mycli`, drivers or credentials found elsewhere;
- split a large write into pieces to get around the auto-commit limit.

An agent without a sandbox, running as the same user, can do several of these anyway: approval protects against the agent that uses the command, not against an agent that ignores the command. The recommendations (sandbox, permission rules, a database user without administration privileges) are in [security.md](security.md#known-limits).
