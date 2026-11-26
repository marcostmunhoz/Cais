# Roadmap

What is outside the current version, what each item requires, and what is still left to verify. Nothing here has a date. An item only enters when there is a use for it, as the "Few options" principle says in [behavior.md](behavior.md#principles).

## BigQuery after the read-only version

| Item | What it requires |
|---|---|
| **Auto-commit for the user** (DML and DDL) | Confirmation on production as in MySQL, and the DML cost under the same byte limit. DDL with a temporary object (`CREATE TEMP TABLE`, `CREATE TEMP FUNCTION`) depends on one BigQuery session per tab. |
| **Transaction mode** | One BigQuery session per tab (`createSession` and `session_id`). `BEGIN TRANSACTION` runs in one query and `COMMIT` in another. `UPDATE` and `DELETE` hold a lock on the whole table until the transaction ends, and a concurrent transaction on the same table is cancelled, not queued. A statement that fails leaves the transaction open until `ROLLBACK`. The state comes from the job's `transactionInfo` (the equivalent of `DO 0` is a `SELECT 1` in the session). The session expires after 24 hours without use or 7 days after it was created. Permanent DDL does not run inside a transaction. With the second mode, the "Read-only" badge in the BigQuery tab's bar gives way to the mode selector, which follows the engine's capabilities. |
| **Agent writes** | Transaction mode, plus approval and Commit as in MySQL, with `MERGE` among the write verbs and the same row ceilings (`numDmlAffectedRows`). There are no triggers or cascading foreign keys, so auto-commit is simpler. Rows still in the streaming buffer do not accept `UPDATE` or `DELETE`. |
| **Scripts and procedures** (`DECLARE`, `SET`, `BEGIN … END`, `IF`, `LOOP`, `CALL`) | One session per tab and classification of the whole script, since the server's type is `SCRIPT` and the children only appear after it runs. |
| **Query parameters** (`@name`) | A way to supply the values without splicing them into the SQL text. |
| **Grid editing** (UPDATE and row delete) | BigQuery does not guarantee a primary key: it would only work for a table with a declared `PRIMARY KEY … NOT ENFORCED`, with a warning that the server does not check uniqueness, and with Auto-commit or Transaction. |
| **Several projects in the tree** | Keeping data in one project and billing jobs to another is common. It requires a list of data projects per environment, each read separately. |
| **Free table preview** | Double-clicking a table could use `tabledata.list`, which is not billed, instead of `SELECT … LIMIT 100`. It stays outside the SQL path, so it needs its own entry in the Trail. |
| **Partition and cluster** | Show them in the tree and warn in the editor when the query does not filter by the partition. |
| **Location field** | Only if a case appears where the region inferred from the query and the default dataset is not enough. A query that mixes regions is refused by the server. |
| **`EXTERNAL_QUERY`** | Allow it in Read-only only if the external database runs in a read-only transaction (see "To verify"). |
| **Triple-quoted strings for agents** | Editor and modal highlighting that reads `'''…'''` and `"""…"""` as the server does. |
| **Large results in Arrow** | `queryResultsFormat: ARROW`, to fetch more than 50,000 rows without the overhead. |
| **Byte window across agent requests** | The 10 GiB threshold applies per request: several requests of up to 10 GiB, without approval, add up to more than that. What is missing is a per-environment window (agent bytes in the last 15 minutes), modeled on `AUTO_COMMIT_WINDOW_ROWS`. It changes the `approval_reason` contract and needs a product decision. |
| **Several approval reasons** | `approval_reason` is a single reason: when a function and bytes both need approval, the function's reason comes through (the bytes show per statement in the modal). Showing all of them needs a list in the model, in the Trail and in the modal. |
| **Progress with a count while reading columns** | The dataset row already shows "Reading…". A count would need a new channel from the main process to the renderer, for a few seconds of waiting. |

## Editor

| Item | What it requires |
|---|---|
| **Columns of derived tables and CTEs in autocomplete** | The scope already separates the subquery, the derived table and the CTE body, but only schema tables have columns. For `WITH w AS (SELECT a, b FROM t) SELECT | FROM w` to offer `a` and `b`, the scope would have to read the `SELECT` list (names and aliases, `*` expanded from the schema). |
| **Keyword the grammar expects** | `dt-sql-parser` knows which keywords fit the position (`getSuggestionAtCaretPosition`), but it needs one parse per keystroke and stumbles on an incomplete statement. Today the order of keyword, table and column comes from the word before the cursor. |
| **Syntax check for DDL, `SET`, `SHOW` and routines** | The third-party grammar misreads part of what MySQL 8.4 accepts. Each verb enters the verified list when its valid corpus (`tests/support/mysql-corpus.ts`, checked on the server with `PREPARE`) passes without any error marks. |
| **BigQuery syntax error** | There is no built-in GoogleSQL grammar; the syntax error comes from the server. |

## Technical

| Item | Why |
|---|---|
| **Async `safeStorage`** | The synchronous API (`isEncryptionAvailable`, `encryptString`, `decryptString`) is removed in Electron 46: the `Vault` must become async before Electron is updated. When `decryptStringAsync` asks for re-encryption (`shouldReEncrypt`), the encrypted password changes, and the signature of the environments that use the credential covers that text: re-encrypting and re-signing must go in the same write, or the environments open blocked. On Linux, check how the async API reports the provider without a keyring, which the documentation does not describe. |
| **npm 12** | npm 12 stops running install scripts that are not in `allowScripts`. Each new dependency with a script has to be reviewed (`npm install-scripts ls`). |

## macOS distribution

| Item | What it requires |
|---|---|
| **Developer ID and notarization** | An Apple Developer account, the Developer ID certificate and an app-specific password stored as repository secrets, and a `notarytool` step in `release.yml`. Until then, the dmg carries only the ad-hoc signature and the first launch requires allowing the app by hand (README). |
| **macOS x64 (Intel)** | The macOS builds are arm64 only. It comes in if someone uses an Intel Mac, and it doubles the cost of macOS minutes in the release. |

## Linux outside the current choice

| Item | Why it is out |
|---|---|
| **AppImage** | The app's path changes on every launch, so the `cais` command would have to be copied to a fixed place on every version, instead of linked. There is no install step to put the AppArmor profile that Chromium's sandbox needs on Ubuntu 24.04 in place. |
| **rpm** | Fedora and openSUSE. It comes in if someone uses it. |
| **arm64** | Doubles the builds and what has to be tested. It comes in with a Linux arm64 machine in use. |

## To verify

Open checks that need a resource the tests do not have. None of them is covered by `npm run check`.

| What | What is checked, and what changes |
|---|---|
| **Routine inside a view** | Whether the dry run lists in `referencedRoutines` a function called only in a view's definition. The live suite checks one level, with `CAIS_BQ_LIVE_ROUTINE` and `CAIS_BQ_LIVE_VIEW` (AGENTS.md); a view over that view is checked by hand: create the view and run the dry run through `jobs.insert`. If it is not listed, a remote function behind a view reaches an agent without approval: see [security.md](security.md#bigquery-read-only). |
| **`maximumBytesBilled` with a slot reservation** | In a project with a reservation, whether the server accepts, ignores or refuses the field. If it refuses, an empty limit on the environment turns it off; if it ignores it, the ceiling only applies under on-demand pricing and the text should say so. |
| **`EXTERNAL_QUERY` in a read-only transaction** | With a disposable connection to a Cloud SQL instance, whether a write inside the external query is blocked. Until this is checked, it stays refused for everyone. |
| **`print-access-token` with `--impersonate-service-account`** | With a service account and the `roles/iam.serviceAccountTokenCreator` role, whether the impersonated token works for BigQuery (`SELECT SESSION_USER()` returns the service account) and whether stdout carries only the token. |
| **`net.fetch` behind the system proxy** | In the app, with a proxy configured in the system (GNOME: Settings › Network › Proxy), **Test connection** on a BigQuery environment passes; with the proxy down, "No response from bigquery.googleapis.com" appears. A proxy with its own certificate needs that certificate in the system certificate store. |
| **Deb install on Linux** | `sudo apt install ./dist/cais_<version>_amd64.deb` and check: the right icon, grouped in the GNOME dock; the Cais name in the notification; the Cais entry in the keyring and the `gcloud` accounts in the registry; **File › Install cais Command in Terminal** (creates `~/.local/bin/cais` pointing to `/opt/Cais/resources/cli/cais.mjs`); `cais llm guide` on the system Node and `cais llm envs` with agent access on; installing a newer version over it (keeps the link) and uninstalling (leaves the link broken, which the next install replaces). Also press `Ctrl+.` (Cancel) once with the editor focused: on GNOME, IBus uses `Super+.` for emoji, so it should be free. |
| **Ubuntu 24.04 and the AppArmor profile** | On 24.04, Chromium's sandbox depends on the AppArmor profile that the deb installs (`/etc/apparmor.d/cais-app`); it was only checked on Ubuntu 26.04, where it works with the user-namespace restriction on. |
| **`npm run check` and `npm run dist` on the Mac** | `npm run check` green on macOS, and `npm run dist` producing the dmg and `Cais.app` with an ad-hoc signature, which opens straight from the `dist/` folder. |
