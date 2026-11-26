export const GUIDE = `Cais: agent access to databases, with the person's approval in the app.

You do not execute, you ask. Cais keeps the credentials and never hands out a password, token or host.
What your own SQL returns (CURRENT_USER(), @@hostname, SHOW PROCESSLIST) is queried data and is not hidden.
The person decides in Cais (approve, reject, and then commit or roll back a write).

Flow
  1. cais llm envs                      lists projects and environments (slug "project/environment", production, default
                                        database and agent_access: what runs without the person in that environment)
  2. cais llm schema <env> [--database db] [--table t]
                                        tables and columns (metadata only; runs straight away in any environment)
  3. cais llm query <env> --sql "SELECT ..."
                                        runs at once where agent_access allows reads (free-reads, free-reads-writes)
  4. What the environment does not allow waits for the person's approval (in production, a write always waits):
       cais llm query loja/pro --sql "SELECT ..." --reason "reason" --wait
       cais llm query loja/hml --write --sql "UPDATE ..." --reason "reason" --wait
     --reason is required when the request needs approval and on every write (it goes in the Trail). Without
     --wait the command returns at once with { "request_id": "...", "status": "pending_approval" }; then use:
       cais llm status <request_id> --wait
  5. A write runs in a transaction. With approval, the person sees the affected rows and decides Commit or Rollback
     (automatic rollback after 2 minutes). In free-reads-writes the write runs without approval and Cais commits by
     itself ("auto_commit": true), except when there is an alert before it runs (no WHERE, a WHERE that is always
     true, a non-transactional table, a view, a database function, a trigger or cascading foreign key on the table,
     a statement other than INSERT, REPLACE, UPDATE and DELETE, an UPDATE or DELETE when Cais cannot see all the
     foreign keys, another write of yours already open in the environment: it goes to approval, with
     "approval_reason") or when, after it runs, it goes past 1000 affected rows in the request or 5000 in
     15 minutes in the environment, or the server warns about something (it waits for the person's Commit, with
     "commit_reason").
     Use --wait on every write.
     The response says who decided: "decided_by": "person" (the person approved or rejected that request) or "policy"
     (the environment's level, or the 15-minute read grant, let it run without the person seeing the request). An
     expired request has no "decided_by". A write with "committed" always carries "auto_commit": true (automatic
     commit) or false (the person clicked Commit). Tell the person whether the write went through them.

Commands
  cais llm query <env> (--sql "<sql>" | --file <file> | -) [--write] [--reason "<reason>"]
                       [--database db] [--max-rows N] [--wait] [--timeout 600] [--client "Claude Code"]
  cais llm status <request_id> [--wait] [--timeout 600]
  cais llm requests [--limit 20]
  cais llm scripts [--project <project>]
  cais llm script <script_id>
  cais llm script-save --project <project> --name "<name>" (--sql "<sql>" | --file <file> | -) [--database db]

Rules
  - <env> takes the id or the slug "project/environment".
  - Reads: --max-rows goes from 1 to 1000 (default 200).
  - There is no DDL (CREATE, ALTER, DROP...) and no transaction control (BEGIN, COMMIT, SET autocommit...).
  - Also refused: MySQL and MariaDB executable comments (the ones that open with slash, asterisk and exclamation
    mark), a comment with another /* inside, SET_VAR/MAX_EXECUTION_TIME hints,
    GET_LOCK, RELEASE_LOCK, SLEEP, BENCHMARK, LOAD_FILE, SET NAMES other than utf8mb4, writes to the system
    schemas (mysql, performance_schema, sys, information_schema), reads of the mysql schema, and SQL with
    invisible characters, text-direction characters, spaces other than the plain space or line breaks other than
    \\n. Outside strings and backtick-quoted names, use ASCII only.
  - The person may approve without letting you see the result: the response carries "result_withheld": true and only counts.
  - Scripts: you can list, read and create. You cannot edit or delete.
  - Everything you ask for goes in the Cais Trail, with the SQL, the reason and the counts.
  - Limits: each statement has 30 s on the server and is cut at 35 s; a read request, 60 s in total; an approved
    write, 60 s until the second decision; a write waits at most 10 s for a lock; schema has a 60 s cache.
  - A write that writes outside the transaction (non-transactional table) stops the request: code non_transactional_write.
  - A write that fails returns only the error and the statement index (statement_index); the results come after the Commit.
  - If the SQL names a non-transactional table (MyISAM), Rollback does not undo it; the response carries "rollback_incomplete": true when that happened.
  - All output is JSON on standard output, errors included: { "error": "...", "code": "..." }.
  - Closing the output early (| head) is not an error: the command exits silently with the same code.
  - Personal data in production: ask only for the columns you need.

BigQuery (environment with "engine": "bigquery"; "default_database" is the default dataset; the Google Cloud project does not show)
  - Read-only in this version. --write returns code engine_read_only (exit 2), in any BigQuery environment.
  - GoogleSQL: names in backticks and \`dataset.table\` (\`project.dataset.table\` if it is in another project). --database is the
    request's default dataset. schema lists datasets and tables; with --database, the columns with the full type (STRUCT<...>, ARRAY<...>).
  - Each statement goes through an estimate (dry run) before anything is decided. BigQuery bills for what it reads, and LIMIT does not reduce that:
    prefer filtering by partition, selecting only the columns you need and avoiding SELECT *.
  - A read estimated above 10 GiB (or above the environment's limit, if lower) waits for the person's approval, even in
    free-reads and with the 15-minute grant, and needs --reason. The sum of the request's estimates counts, not just
    the largest. The response carries "approval_reason" with the estimate. The job runs with a ceiling of 10 GiB (or the
    environment's limit, if lower), or the approved estimate rounded up to GiB. If the estimate grows later and goes past the ceiling, the
    statement does not run: code bytes_over_approved (ask again).
  - These also wait for approval (with "approval_reason"): a function defined in the project (it may be remote and run code outside
    BigQuery), an unqualified function that is not built in, and generative AI and model functions (ML.*, AI.*), which cost outside the
    bytes read.
  - Refused: everything that is not a query (INSERT, UPDATE, DELETE, MERGE, DDL, CREATE TEMP, scripts such as DECLARE, BEGIN ... END,
    IF and LOOP, CALL, EXECUTE IMMEDIATE, EXPORT DATA, LOAD DATA) with writes_in_read or ddl_or_transaction; a statement the server
    reads as something other than SELECT (writes_in_read); EXTERNAL_QUERY and OBJ.* (function_not_allowed); a chained call, such as (x).f() (ambiguous_text); INFORMATION_SCHEMA.JOBS*, JOBS_BY_*
    and SESSIONS* (system_schema: they show the SQL of other people in the project); #legacySQL and #standardSQL (ambiguous_text or
    executable_comment); triple-quoted strings and a comment with /* inside (ambiguous_text). Plain and raw strings without a
    backslash pass.
  - Each result carries "bytes_estimated", "bytes_processed" and "bytes_billed". With "result_withheld", only counts.
  - Errors come out without the project id (<project>) and without account e-mails (<account>). The job has 30 s on the server and is cut at 35 s
    (jobs.cancel); MySQL output does not change.

Exit codes (the code holds even when the output is cut by | head)
  0  success (succeeded, committed, or a pending request without --wait)
  1  failed (includes not being able to connect to the environment)
  2  usage, validation or policy refusal
  3  rejected, expired or rolled_back
  4  Cais closed or agent access off: ask the person to open Cais and turn on agent access
  5  wait timed out (the request stays valid; wait again with "cais llm status <id> --wait")
`;
