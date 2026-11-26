# Security

The Cais security model: what it protects, how, and what it leaves out. The visible behavior of each rule is in [behavior.md](behavior.md) and the CLI contract is in [agents.md](agents.md).

## Threats considered

- **User error:** writing to production by accident, leaving a transaction open, running something other than what was read.
- **An AI agent using `cais llm`** that tries, cleverly, to: run something on production without approval, write without the approval click or without the Commit, escape Read-only, run an administration statement (`KILL`, `SET GLOBAL`/`PERSIST`, `GRANT`...), mislead the user in the modal, see a withheld result, hold a lock or take the server down, or leave state behind from one request to the next.
- **A process that edits the Cais data folder** to gain write access without review (removing the production mark, turning on agent access) or to redirect the credential to another host.

An unsandboxed process running as the same system user is not contained by the app; what can and cannot be done in that case is in [Known limits](#known-limits).

## Secrets

- **Passwords are encrypted by the system vault** (Electron `safeStorage`, Keychain on macOS, Secret Service on Linux) in `secrets.json`. Without the vault, Cais refuses to save the password: it never writes a password in plain text. On Linux, without a keyring (GNOME Keyring, KWallet) Chromium would use a key fixed in the code, which is not a vault; so Cais also refuses when the chosen backend is `basic_text` or `unknown`.
- **The password does not go back to the renderer.** It enters through IPC only when saving the credential (empty keeps the current one). IAM tokens stay in memory in the main process for 50 minutes. No password or token in any log.
- **Agents never receive a credential**: no password, no token, no host, no credential id. `cais llm envs` returns only id, slug, project, name, production, engine, level and default database. Connection errors reach the agent in generic form (no host, IP, database user or `gcloud` text), and the error of each statement goes through the same redaction.
- The files in the data folder are written atomically (temporary file and `rename`) with permission 0600; the Trail folder is 0700.

## Main process and renderer

- **The renderer runs isolated:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no remote resources (no CDN, no web fonts). The interface talks to the main process only through the typed preload bridge (`window.cais`).
- **Restrictive CSP in the build:** `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'`. `style-src 'unsafe-inline'` exists because CodeMirror injects styles.
- **The editor has a Web Worker, with no extra permission:** the MySQL syntax check runs in a module worker from the package itself (`script-src 'self'` covers it; the CSP gains no `worker-src` and no `blob:`). It receives only the text of one statement from the editor and returns the first error; it has no IPC and no `window.cais`, it does not run with Node (the renderer does not have it) and its code makes no network call; the text does not leave the machine. The CSP is a `<meta>` tag of the page and does not apply to the worker (which loads from its own file), so what keeps the worker off the network is its code, not `connect-src`. The columns the editor reads on its own in BigQuery use the scoped `schema:get` channel that the tree already uses (`tables.get`, no byte cost), so they open no new channel.
- **The main process never trusts the renderer:** every IPC channel validates its input with zod, accepts calls only from the main window, and the SQL is reclassified by the dialect before it runs. Decisions about agent requests (approve, reject, grant, Commit, Rollback) count only when they come from the main window and for requests in the right state.
- **Cais refuses to open with remote debugging options** (`--remote-debugging-port`, `--remote-debugging-pipe`, `--remote-debugging-address`, `--remote-allow-origins`, `--inspect`, `--inspect-brk`, `--inspect-port`, `--inspect-publish-uid`), packaged or in development; only the e2e hook (`CAIS_E2E=1`, unpackaged app) accepts them. DevTools exists only outside the package. A debugger attached to the window does everything the user does (approve, Commit, turn on agent access), and an agent with a shell could reopen the app with one.
- **Test hooks** (`CAIS_E2E`, `CAIS_USER_DATA`, `CAIS_SOCKET`, `CAIS_LOCALE`, `CAIS_IDLE_MS`, `CAIS_BIGQUERY_URL`, `CAIS_RELEASES_URL`) apply only to the unpackaged app. The packaged app ignores them.
- **Network:** the renderer does not reach the network (`connect-src 'none'`); everything that leaves the machine leaves from the main process, and only to these destinations:
  - the host of each MySQL environment, on the registered port;
  - `bigquery.googleapis.com`, only in BigQuery environments (`net.fetch`, with the access token in the `Authorization` header);
  - the user's `gcloud`, run as a subprocess (Cais does not talk to Google servers through it; it only reads the output of `auth list`, `sql generate-login-token` and `auth print-access-token`);
  - `api.github.com`, and only when the user clicks Check in the About Cais window: a `GET` to `/repos/marcostmunhoz/Cais/releases/latest`, with no token (not even a `GITHUB_TOKEN` from the environment), no cookie, with `User-Agent: Cais/<version>` and a 5-second limit. GitHub learns the IP and the app version, and nothing else. The response is validated with zod, and only the `tag_name` (`vX.Y.Z`) is read; no address from the response is used.
  - There is no telemetry, no check at startup, no automatic update and no remote resource in the interface.
- **`shell.openExternal` opens only fixed addresses.** The `app:openLink` channel receives a name (`repository`, `releases` or `release`), never an address; the main process builds the address from constants (the repository and the releases list) and, for `release`, from the tag already validated by the last check (`https://github.com/marcostmunhoz/Cais/releases/tag/vX.Y.Z`). The window still does not open others and does not navigate away (`setWindowOpenHandler` and `will-navigate`). A tampered API response does not take the user to another site.
- **Electron fuses** in all packages (macOS and Linux): `runAsNode` off, cookies encrypted, `NODE_OPTIONS` and inspect arguments ignored, asar integrity declared (Electron only checks it on macOS and Windows) and the app loaded only from inside the asar. The CLI runs on the system Node, not through Electron.
- **`app.asar` integrity:** Electron only checks asar integrity on macOS and Windows. On Linux that check does not exist; what protects `app.asar` is that the `/opt/Cais` folder belongs to root, which keeps a user process from replacing it.
- **One instance per user** (`requestSingleInstanceLock`): a second launch focuses the window that already exists.

## Read-only

Read-only has two layers: an in-app allowlist of what is permitted, which refuses the rest before anything leaves, and the session in `READ ONLY` on the server, reasserted before each statement. The classifier is the most delicate part, because what the app classifies has to be what the server runs. The rules below apply to the user in Read-only and to all agent SQL.

- **Same tokenization as the server, and when in doubt it refuses.** Refusing too much is acceptable; letting something through is not.
- **Executable comments are refused** (`/*! … */`, `/*!NNNNN … */`, `/*M! … */`): the server skips or runs the content depending on the version (or the MariaDB syntax), so `/*!99999 SELECT 1 */ KILL 123` would look like a `SELECT`.
- **`*/` closes only an executable comment that is open.** Outside one it is a multiplication followed by `/`: in `SET @a = 2 */* ' */ 1, PERSIST max_connections = 7 /* ' */` the server sees `SET PERSIST`, not a string.
- **The session speaks only utf8mb4.** `SET NAMES`/`SET CHARACTER SET` only with utf8mb4, and the driver pins utf8mb4 when it opens. With another character set (for example latin1), the driver encodes each character in one byte, and letters turn into quotes, line breaks or `#` on the server.
- **`sql_mode` without `NO_BACKSLASH_ESCAPES` and `ANSI_QUOTES`.** The session is pinned that way, and the classifier still reads each statement under both string rules and keeps the stricter one.
- **Only ASCII letters become keywords** (`ſelect` is a name, not `SELECT`). A function with a non-ASCII name is refused, because the server finds functions ignoring accents.
- **Functions that change server state** outside any transaction are refused in every statement: failover and replication wait, group replication, keyring, firewall, audit log, version tokens, locking service, masking dictionaries, `innodb_set_open_files_limit`, `innodb_redo_log_*`, `mysqlx_*`. A function inside `TRIM`/`SUBSTRING`/`EXTRACT … FROM f()` or after `STRAIGHT_JOIN` counts as a call.
- **A qualified name that starts with a digit** (`db.2fa_codes`, `db.2fn()`) is read the way the server reads it: after a name, the `.` starts the next part of the name.
- **`SET` is parsed strictly:** only `@variable = …` and `NAMES`/`CHARACTER SET` alone. The target name is rebuilt between tokens, so a transaction variable written with a backtick, space, comment or accent (`` `autocommit` ``, `@@session . autocommit`, `autocommìt`) is refused in all modes.
- **`INTO OUTFILE`, `INTO DUMPFILE` and locking reads** are refused. `COMMIT AND CHAIN`/`ROLLBACK AND CHAIN` count as opening a transaction. A transaction opened by any path in a read-only session is rolled back immediately.
- `GET_LOCK` and `SLEEP` remain allowed for the user in Read-only (they do not write); for agents they are refused (see below).
- The highlighting in the editor and the modal reads `\'` the way the server reads it.

## The user's transaction

- The transaction state comes from the server (the protocol's open-transaction indicator), not from the statement type.
- `SET autocommit` and `SET … TRANSACTION` are refused in all modes. If a statement turns `autocommit` on by another path (inside a `CALL`), Cais puts the session back to 0 immediately and warns that what was written is already committed.
- `CALL`, `EXECUTE` and executable comments ask for the implicit-commit confirmation in Transaction mode.

## Extra rules for agent SQL

What the user approves in the modal has to be what the server runs. So agent SQL goes through text rules before classification:

- **Refused with an invisible character, a text-direction (bidi) character, a control character, a space that is not the plain space, or a line break that is not `\n`** (lone CR, U+2028, VT, FF). A lone CR would show as a line break in the modal, while the server would continue a `--` comment over the rest of the `WHERE`. An emoji with a joiner (ZWJ) or a variation selector is also refused (the agent uses `CHAR()` or `X'…'`).
- **Only ASCII outside strings, backtick names and comments.** The server reads NBSP and other non-ASCII characters as part of a name (`WHERE<NBSP>id` becomes a table alias and the query returns everything). A variable or function name outside ASCII is refused even between backticks (`@іd` with a Cyrillic letter).
- **A comment with another `/*` inside, `--` with no space right after it, and a quoted variable (`@'x'`) are refused**: in all three cases the review highlighting could read differently from the server.
- **An executable comment is refused anywhere in the text**, including inside strings.
- **Refused functions:** `GET_LOCK`, `RELEASE_LOCK`, `RELEASE_ALL_LOCKS` (the lock outlives the request), `SLEEP`, `BENCHMARK` (they hold the connection), `LOAD_FILE` (server file), the functions that change server state, and the `SET_VAR` and `MAX_EXECUTION_TIME` hints.
- **System schemas:** agents do not write to `mysql`, `performance_schema`, `sys` and `information_schema`, and do not read the `mysql` schema or `SHOW CREATE USER` (accounts and password hashes).
- **Agents do not run DDL, statements with implicit commit or transaction control**, in any mode, because they cannot be undone. For writes, only `INSERT`, `REPLACE`, `UPDATE` and `DELETE`, plus the safe reads.
- **The modal shows the truth:** each statement separated, in logical order (right-to-left letters do not reorder the text), only `\n` breaks a line, invisible characters as `⟨U+XXXX⟩`, consecutive blank lines as a single marker, alerts at the top and Approve enabled only after scrolling to the end. Reason, client and script names arrive without invisible characters.

### Agent sessions

- **Their own connections**, never the user's tabs. The session reasserts utf8mb4, `sql_mode`, `autocommit` and the mode before each statement.
- **The read connection is reset between requests** (`COM_RESET_CONNECTION` and the mode again): user variables, named locks, character set, temporary tables and prepared statements from one request do not reach the next, nor from a request with a withheld result to one with a released result.
- **Time limits** (30 s on the server and a cut at 35 s per statement, 60 s per read request, 60 s per approved write until the second decision, 10 s waiting for a lock) keep an agent from holding a lock or a connection. `KILL QUERY` uses a fresh credential, because the IAM token from when the connection opened may have expired.
- **A write that persists outside the transaction stops the request** (`non_transactional_write`), warning that Rollback does not undo it.
- **Non-transactional table warning:** if the SQL reaches a table that is not InnoDB, the modal warns that Rollback does not undo it. The warning follows views (including views inside views), triggers on the table and on tables under a view, and called functions and procedures (including routines of the same name in all schemas and routines called by a trigger or by another routine). Without metadata, without access to the body of a routine or without the `TRIGGER` privilege, it warns that it could not check. An incomplete Rollback shows up for the user and for the agent (`rollback_incomplete`).
- **Withheld result:** with "The agent can see the result" unchecked, the response carries only counts, and server errors carry only the code (the message may quote values).
- **Auto-commit happens only for what Cais can count and undo** (rules in [agents.md](agents.md#auto-commit-on-reads-and-writes-allowed)): no trigger, no cascade, no view, no function, with fresh metadata and with row ceilings.

### BigQuery (read-only)

BigQuery has no `READ ONLY` session on the server, so the two layers of Read-only are different: the app classifier and the dry run. In this version no path (user or agent) writes.

- **Estimate while typing** (the dry run of the statement the user is writing): the `session:estimate` channel accepts only the main window and validates its input with zod, like the others. What goes out is decided by the main process (`SessionManager.estimate`), not by the renderer: with the switch off (`settings.json`, read in the main process) nothing is asked, the text has to be a single statement, the dialect classifier reclassifies it, and what the app refuses (DML, DDL, script, `CALL`) is refused there, without sending; a statement that the server reads as a type other than `SELECT` also becomes a refusal. Only the text of that statement goes to Google, by the same path and with the same token as "Run" (`jobs.insert` with `dryRun`); the response carries bytes, type and the error message, never rows. It creates no job, bills nothing and does not enter the Trail (it is not a statement); "Run" repeats the dry run and the limit question, so the estimate shown authorizes nothing. The destination is the same as ever (`bigquery.googleapis.com`); what is new is that the text goes out at each pause, including incomplete drafts, and that is why the switch starts off and belongs to the user. It is outside the agent access seal: a hand-edited `settings.json` can turn it on, which only makes the user's own text go to Google at each pause; it gives no power to an agent, which has no channel for this function (the socket does not know it).
- **Two layers:** the GoogleSQL classifier refuses what is not a query before it leaves (when in doubt, it refuses), and the dry run (`jobs.insert` with `dryRun`) returns the `statementType` the server read: only `SELECT` goes on. Without `statementType`, it refuses. `SessionManager` uses the dry run to refuse before sending and for the cost question; the driver repeats the dry run inside `execute`, so the second layer also holds for anyone who calls it without going through `SessionManager`. A dry run that fails (a table that does not exist, no permission) decides nothing: the error shows up on execution. The same dry run lists the routines the statement uses (`statistics.query.referencedRoutines`; only `jobs.insert` returns this field; a routine called from inside a view is a known limit, see below): for agents, any routine makes the request wait for the user, at any level, and the reason cites `dataset.routine`, never the project. This catches a remote function that slips past the classifier. If the broker's dry run failed (timeout, 429/5xx), nobody saw any routine: the agent request carries `refuseRoutines` and the driver, in the dry run it repeats inside `execute`, refuses with `routine_not_approved` any routine that appears, without billing anything.
- **Agents do not write:** `--write` in a BigQuery environment is refused with `engine_read_only` in the broker, and `AgentSessions.runWrite` refuses again; no write mode reaches the driver.
- **SQL text:** what the user approves in the modal has to be what the server runs. In GoogleSQL this takes its own rules, in `agentCodeProblem` and in the classifier (see below).
- **What the server does** (checked against the real server; the live suite keeps the `statementType` per class, the `jobReference` without `jobId` and the error format): the dry run gives a `statementType` to every statement class (`SELECT` for query, `WITH`, pipe and table; the proper name for DML and DDL; `SCRIPT` for `DECLARE`, `BEGIN … END`, `IF`, multiple statements and `EXECUTE IMMEDIATE`, and also for `CALL`, which does not come back as `CALL`); `CREATE TEMP TABLE` outside a script is a 400 already at the dry run. The dry run response carries a `jobReference` without `jobId`, because no job is created. The location comes in `jobReference.location`, which the driver repeats in `getQueryResults`, `jobs.get` and `jobs.cancel` (without it they return 404 outside US and EU), and the `defaultDataset` resolves the region of a query without a table. `jobs.cancel` stops the job within a few seconds, with no charge on a query that reads no table (what was already read before the cancellation may be billed). Errors arrive as `{ error: { code, message, status, errors: [{ reason }] } }` and none asks for `X-Goog-User-Project`.
- **Cost:** the environment byte limit and the fixed 10 GiB for agents (the smaller of the two, when the environment has a limit) become the job's `maximumBytesBilled`, so BigQuery refuses, without billing, what goes over the ceiling. Details in [behavior.md](behavior.md#bigquery-read-only) and [agents.md](agents.md#bigquery).
- **Token:** the access token comes from `gcloud auth print-access-token` and is a 1-hour OAuth token. Cais keeps it only in memory, for 50 minutes, it goes only in the `Authorization` header of calls to `bigquery.googleapis.com` made by the main process, and it never enters a log, an error message, the Trail or a response to agents. On a 401, the driver asks for another once and retries.
- **Network:** only the main process talks to the API (Electron `net.fetch`: system proxy and certificates). The `CAIS_BIGQUERY_URL` hook changes the address only in the unpackaged app (all the app's network destinations are in [Main process and renderer](#main-process-and-renderer)).
- **Redaction for agents:** BigQuery errors and texts reach the agent without the project id and without account or service account emails. The emails are removed before the project id, because the domain of a service account carries the id.

**Agent text rules in GoogleSQL** (added to the general ones):

- These are refused (`ambiguous_text`), because the modal highlighting does not read them the way the server does: triple-quoted strings (`'''…'''`, `"""…"""`), a backtick name with a backslash (the highlighting has no escape there). Also refused: a raw string (`r'…'`) with a backslash, only as a precaution: the server follows a single rule (the backslash does not escape, but it keeps the next quote from closing the string: `r'\''` is `\'`, and `r'\'` does not close) and the highlighting agrees, but the BigQuery documentation does not record the rule, and a change on the server would only be noticed by the live suite, which is outside `npm run check` and keeps the observed rule. Allowing it would only be a convenience, because the same regex can be written without a raw string (`'\\d+'`), and the highlighting has no escape inside backticks, so allowing only the raw string would leave two rules for the backslash. Also refused: a bytes string (`b'…'`), the letter `x` stuck to a string, `--` with no space after it, a comment with another `/*` inside, CR inside a line comment, a parameter name in quotes or backticks, and a non-ASCII character in code, outside strings, backtick names and comments.
- `#legacySQL` and `#standardSQL` are refused (`ambiguous_text`; `executable_comment` when it reaches the policy): the directive changes how the server reads the whole text. The driver always sends `useLegacySql: false`, and the server answers 400 to `#legacySQL` against that field (the directive does not win), so the refusal only saves a round trip and protects the classifier, which reads only GoogleSQL.
- `EXTERNAL_QUERY` is refused (`function_not_allowed`): it runs a query on another database. `OBJ.GET_ACCESS_URL`, `OBJ.MAKE_REF` and `OBJ.FETCH_METADATA` too: the signed Cloud Storage URL (a write one, in `rw` mode) is a credential the agent does not receive.
- A chained call (`(x).f()`, `(x).(ds.f)()`) is `ambiguous_text`: the classifier only sees calls written as `f(x)`, and a remote or AI function would pass without approval.
- `INFORMATION_SCHEMA.JOBS*` and `SESSIONS*` are refused (`system_schema`): they show the SQL of other people in the project. Agents also do not write to `INFORMATION_SCHEMA`.
- These wait for approval, with `approval_reason`: a call to a function defined in the project (it may be a remote function, which runs code outside BigQuery), an unqualified function that is not native, and `ML.*`/`AI.*` (generative AI and models, which cost beyond the bytes). The list of native functions (`src/shared/dialects/bigquery/functions.ts`) is written by hand and errs on the side of asking for approval. The server never resolves an unqualified name to a persistent routine, not even through the default dataset (`SELECT f(1)` gives "Function not found"): a name outside the list is not a project function, it is an unreviewed name, maybe a new built-in that calls outside BigQuery. Project routines are caught by the dry run.
- A read estimated above 10 GiB (the sum of the statements in the request), or above the environment limit when that is smaller, always waits for the user, at any level, including under the 15-min grant and in an environment with no limit.

**Known limits of BigQuery:**

- **Remote function and generative AI inside a `SELECT`.** A qualified call, or an unqualified one that Cais does not recognize as native, goes to approval, but what the user approves is the text: a remote function runs code outside BigQuery and `ML.GENERATE_*` costs beyond the bytes read, and neither is contained by the byte limit.
- **The estimate can be wrong.** The dry run estimates; the real cost can differ (the cache, columnar storage, a table that grows). Cais repeats the dry run before running and the job carries `maximumBytesBilled`, which is what prevents the excess (with on-demand pricing, the server refuses with `bytesBilledLimitExceeded`, without creating the job or billing; the minimum charge is 10 MiB, so a ceiling below that is always refused). An agent that went past the approved ceiling receives `bytes_over_approved` and nothing is billed. The sum holds per request: there is no window across requests, and several requests of up to 10 GiB each, without approval, add up to more than that (a known limit, also in the [roadmap](roadmap.md#bigquery-after-the-read-only-version)).
- **`maximumBytesBilled` under slot reservation.** In a project with a reservation (fixed capacity), the byte ceiling may not apply, and billing is per slot, not per byte. This has not been checked on a real project (see "To verify" in the [roadmap](roadmap.md#to-verify)); if the server refuses the field, an empty limit on the environment turns it off, and the limit becomes only a confirmation.
- **A routine called from inside a view.** Cais relies on the dry run's `referencedRoutines` to ask for approval per routine, and that was checked for the direct call. Whether the server also lists a routine that appears only in the definition of a view has not been checked against the real server. The optional live suite test checks one level of view (`CAIS_BQ_LIVE_ROUTINE` and `CAIS_BQ_LIVE_VIEW`, see AGENTS.md); a view over that view is checked by hand, with a dry run through `jobs.insert`. If it does not hold, a remote function behind a view reaches an agent without approval, and a different defense would be needed (make every agent read that reaches a view wait for the user).
- **`INFORMATION_SCHEMA` is billed.** A user query on `INFORMATION_SCHEMA` costs like any other (with a minimum per query) and goes through the same limit. The Cais tree does not use it: it reads columns through `tables.get`, which does not bill.
- **`LIMIT` does not reduce the bytes read.** `SELECT * … LIMIT 100` reads the whole table (or the partitions the filter does not exclude). That is why double-clicking a table goes through the limit.
- **The server's `statementType`.** The second layer depends on the dry run saying the type. The live suite (`npm run live:bigquery`) checks, against a real project, that everything the classifier lets through the server reads as `SELECT`; it is not part of `npm run check`. Checked against the real server: every class in the corpus has a `statementType`, and nothing the classifier lets through came back as anything other than `SELECT`.
- **1-hour token in memory** (see above): a process running as the same user that can read Cais memory, or run `gcloud auth print-access-token` itself, talks to BigQuery as the user, outside Cais. It is the same limit as `gcloud sql generate-login-token` on MySQL.
- **Account permissions.** Cais reads with the credential's account: use an account (or an impersonated service account) with only `roles/bigquery.jobUser` on the project and `roles/bigquery.dataViewer` on the datasets the work needs. An agent reads everything that account reads.

## Agent channel isolation

- **The socket exists only while agent access is on**, and only the user turns it on, in the app. On Windows, it is a named pipe `\\.\pipe\cais-<user>`. On other systems, it is at `<data folder>/agent.sock`; when that path goes over 100 bytes, on Linux it moves to `$XDG_RUNTIME_DIR/cais.sock` (the user's 0700 folder, if it exists, is absolute and fits in 100 bytes) and, otherwise, to `<tmp>/cais-<uid>.sock`. Sockets have permission 0600: only the owning user.
- Cais deletes an old socket only if nobody answers on it, and on close deletes only the socket and the `agent-endpoint.json` that it created itself.
- **Protocol:** one JSON line per message, up to 1 MB per message and 100 KB of SQL, all validated with zod. The CLI checks the protocol version.
- **The agent does not approve, does not turn access on, does not change levels and does not edit or delete scripts.** The app never opens itself or turns access on at the CLI's request.
- **Without the Trail, no agent request runs on its own:** each request writes a line before it runs, and if it cannot be written the request waits for the user (and even an approval does not run until the Trail is back).

## Signed registry and chained Trail

- **Registry protection:** each environment (with the project name, the credential and the encrypted password it uses) and the agent access switch are signed with HMAC-SHA256, with a key kept in `seal.json` and encrypted by the system vault. An environment that does not check out when the app opens is blocked (nothing connects to it), marked as production and set to "Everything needs approval", until the user reviews and saves it. Without `seal.json`, all of them end up that way: deleting the file does not make anything trusted. "Test connection" with the credential of a blocked environment is refused, because the host of the draft may be the edited one. Agent access that is on without a signature opens off. Details in [behavior.md](behavior.md#registry-protection).
- **Chained Trail:** each line carries an HMAC of the line with the code of the previous one from the same day, with the same key. A line that was changed, inserted, deleted in the middle or has no code shows up as "does not check out", also when the key was recreated. Agent lines for one day stop at 64 MB, so an agent cannot make the day unreadable.

## Known limits

- **A username-and-password credential connects without TLS.** The password does not go in clear in the handshake, but queries and results do: use a private network or VPN. IAM requires TLS, without verifying the certificate (Cloud SQL uses its own CA), so whoever controls the route to the instance can intercept the token, which is valid for 1 hour.
- **An unsandboxed agent, running as the same user, is not contained by the app.** It can read the Cais data folder (`catalog.json` reveals hosts and users; the passwords in `secrets.json` are encrypted by the vault, whose access macOS protects with a prompt, but that is not a barrier against a determined process; on Linux the keyring hands the secret to any process of the same user over D-Bus, with no prompt at all, so the agent's sandbox matters even more), use the `gcloud` of the user's account (`gcloud sql generate-login-token`) with the `mysql` client, edit `catalog.json`, `settings.json`, `scripts.json` and the Trail, restart Cais or click the interface through system automation. Approval protects against the agent that **uses the command**, not against an agent that ignores the command.
- **What registry protection and chaining do not catch:** deleting the file of a whole day of the Trail, cutting the end of a file, editing a script (the effect only counts when the user runs it) and restoring an old copy of `seal.json` together with the registry and the `settings.json` from the same time (this requires having read the Cais data folder beforehand; a counter that resists this would need a place the agent cannot write).
- **A `SQL SECURITY DEFINER` function that already exists in the database** and does administration runs inside a read: the server does not block it. In Cais, use a database user without administration privileges and review the DEFINER routines.
- **A trigger in a schema the database user cannot see**, writing to a non-transactional table that is also invisible, escapes the warning.
- **MyISAM with `autocommit=0`** still shows up as an open transaction on the server, so the write is not blocked at run time: the warning before approval and `rollback_incomplete` afterwards apply.
- **A withheld result** still returns counts and time in a request approved one by one; the execution time is a residual side channel.
- **Any `cais llm` client** of the same user reads the status and result of the others' requests: it is the same trust boundary. Agents read `performance_schema` and `sys`.
- **The broad `WHERE` alert** covers the obvious cases (`WHERE 1`, `TRUE`, `x = x`, `OR 1=1`), not every broad condition; the Commit modal shows the affected rows.
- **"Reads and writes allowed" trusts the alerts and the limits.** An `UPDATE` with a `WHERE` that is narrow on paper but catches more than it should, within 1,000 rows per request and 5,000 in 15 minutes, commits on its own. That is the contract of the level: use it in development and staging environments. The 15-minute count stays in memory (the agent does not restart Cais through the CLI).
- **Automatic UPDATE and DELETE require `PROCESS`** (or a global privilege) on the database user, to see foreign keys coming from databases it does not see. `PROCESS` also lets it see the statements of other connections.

### Recommendations

- For production databases, run the agent in a sandbox and, in Claude Code, allow only `Bash(cais llm:*)` and deny what bypasses Cais:

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

  On Linux, replace the macOS-specific rules (`security`, `osascript`, `open` and the `~/Library/Application Support/Cais` folder) with these, keeping the others:

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

  Command deny rules do not replace the sandbox: a script can call the same binary.
- In Cais, use a database user with only what the work needs, with no access to the `mysql` schema and no administration privileges (`SUPER`, `SYSTEM_VARIABLES_ADMIN`, `CONNECTION_ADMIN`, `REPLICATION_SLAVE_ADMIN`). An agent runs with that user's privileges. On Cloud SQL, an IAM user can have the `cloudsqlsuperuser` role (with `CREATE USER` and `GRANT OPTION`); for agents, prefer a user with fewer privileges.
- Leave "Reads and writes allowed" for environments where a wrong fix is cheap.
