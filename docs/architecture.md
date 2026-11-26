# Architecture

How Cais is built: processes, modules, contracts, files and packaging. The product rules are in [behavior.md](behavior.md) and the security model is in [security.md](security.md).

## Overview

```
┌───────────────────────── Cais (Electron) ─────────────────────────┐
│                                                                    │
│  renderer (React, sandbox)  ──window.cais──▶  preload              │
│                                                │ ipcRenderer       │
│                                                ▼                   │
│  main: ipc (zod) ─▶ SessionManager ─▶ Driver ─┬▶ mysql2 ─▶ MySQL   │
│                                               └▶ REST ─▶ BigQuery  │
│        CatalogStore · ScriptStore · Settings · Seal · Vault        │
│        Trail · GcloudTokenProvider                                 │
│        AgentServer ─▶ AgentBroker ─▶ AgentSessions ─▶ Driver       │
│             ▲                                                      │
└─────────────┼──────────────────────────────────────────────────────┘
              │ local socket 0600 (one JSON line per message)
        cais llm … (CLI on the system Node)
```

- **main** (`src/main`): the main process. It holds secrets, opens connections, decides policies, and writes files and the Trail. It is the only place that talks to the database, to the BigQuery API and to `gcloud`.
- **preload** (`src/preload`): exposes `window.cais` (the `CaisApi` contract from `src/shared/ipc.ts`) through `contextBridge`. It passes on the IPC error code and reads the language chosen by the main process.
- **renderer** (`src/renderer`): the React interface, isolated and without access to Node.
- **shared** (`src/shared`): pure TypeScript, with no Node and no DOM, used by both sides: model, results, IPC contract, dialects, i18n, text rules, grid editing.
- **cli** (`src/cli`): the `cais llm` command, bundled into a single file that runs on the system Node.

**Why Electron:** the app needs to speak the MySQL protocol, call the local `gcloud` and use a mature driver (`mysql2`), which a web app cannot do; the cost is a bigger app. **Why CodeMirror 6:** SQL highlighting and keywords come ready-made, and the editor is lighter than Monaco.

## Engine-agnostic contracts

The interface does not know the engine: everything that depends on the database comes from two contracts, registered by `engine`.

- **Dialect** (`src/shared/dialects/types.ts`, MySQL in `src/shared/dialects/mysql`): `splitStatements` (statements with positions in the original text, respecting strings, backticks, comments and `DELIMITER`), `classify` (type, verb, allowed in read-only, implicit commit, transaction control, functions called, executable comment...), `warnings` (modal alerts), `identifiers`, keywords, `quoteIdent`, literals, `buildUpdate` and `buildUpdateLocated` (the same UPDATE, with the position of each `SET` literal, so the editor can select them in Generate cell UPDATE), `buildDelete` (a DELETE by the whole key, without LIMIT, in Delete row) and `buildInsert` (a multi-row INSERT, in Generate INSERT) for grid editing, and the text rules that only apply to agent SQL. It runs on both sides: the renderer uses it to find the statement under the cursor and to highlight; the main process **reclassifies** before executing.
- **Capabilities** (`src/shared/engines.ts`, pure TypeScript): `capabilitiesOf(engine)` returns `{ modes, gridEdit, lazyColumns, dryRun, syntaxCheck }`, because the renderer also needs to know what the engine accepts and cannot see the driver. MySQL accepts the three modes and grid editing; BigQuery only Read-only, with no editing, with columns read per dataset (`lazyColumns`), with a dry run (`dryRun`, which turns on the bytes confirmation and the broker's dry run) and without local syntax checking (`syntaxCheck`, which MySQL has: it turns on the editor's error underline). `initialModeFor` picks the mode of a new tab (Read-only on production; elsewhere, Auto-commit if the engine accepts it, otherwise the first accepted mode). The `SessionManager` refuses, in `open()` and in `setMode()`, a mode the engine does not accept (`mode-not-supported`); the `SessionBar` lists only the accepted modes in the selector and, when the engine accepts just one (`fixedModeOf(caps)`), shows a fixed badge in place of the selector, without naming the engine; `gridEditability` and `insertability` (the columns and key of a Generate INSERT, in `src/shared/grid.ts`) refuse with the reason `grid.reason.engineNoEdit` when `gridEdit` is false. Tests inject an engine with restricted capabilities through `SessionDeps.capabilitiesOf`.
- **Connection target** (`connectionTargetKey` and `sameTarget`, in `src/shared/engines.ts`): what identifies where the environment connects (in MySQL, `host`, `port` and `credentialId`; in BigQuery, `gcpProject`, `maxBytesBilled` and `credentialId`). `changedForAgents` and the broker's check use only this function, so a new engine adds its fields in one place.
- **Agent rules** (`Dialect.agentRules`): `systemSchemas`, `secretSchemas`, `deniedFunctions`, `writeVerbs`, `isValidDatabaseName(name)` and the refusal messages tied to schemas (`messages.systemSchemaWrite` and `messages.systemSchemaRead`, in fixed English, for agents only). `decide()` receives the rules in `DecideInput.rules` and the broker uses `isValidDatabaseName` for `--database`; the MySQL values and texts live in the MySQL dialect (`src/shared/dialects/mysql`). `Dialect.tablePreviewSql(database, table)` is what a double click on a table runs (in MySQL, `SELECT * FROM … LIMIT 100;`).
- **Driver** (`src/main/drivers/types.ts`, MySQL in `src/main/drivers/mysql`): `open`, `introspect(params, scope?)` (its own short connection; without a scope, databases and tables, and with `{ database }`, also the columns of that database; MySQL ignores the scope and returns everything) and `test`, and the `DbSession` with `applyMode`, `execute(sql, { maxRows, stopAtCap?, maxBytesBilled?, refetch?, estimateCeiling? })` (MySQL reads only the first two; `maxBytesBilled` is the job ceiling, `refetch` reads more pages of the same job and `estimateCeiling` makes the driver refuse, without charging, a read whose dry run went over what was approved: `bytes_over_approved`), `useDatabase(name)` (in MySQL, a `USE`; the `SessionManager` and `agents/sessions.ts` switch database only through it, and the Trail records the line with the engine's verb), `transactionProbe?()` (MySQL's `DO 0`, to know whether the transaction is still open after a cancel between statements; without the method the `SessionManager` keeps the state it had), `prepare?(sql, { signal? })` (optional: the dry run, with the type the server read and the estimated bytes, and `errorInStatement` when the server's error points at the statement text and not at the path to it; the `SessionManager` uses it to refuse before sending, for the bytes confirmation and for "Estimate while typing", and the agent broker to decide; `signal` ends the request that a newer one replaced), `cancel` (`KILL QUERY` over a control connection), `commit`, `rollback`, `currentDatabase`, `reset`, `applyLimits` and `onFatalError`. `StatementResult.stats?` carries `bytesProcessed`, `bytesBilled`, `bytesEstimated`, `cacheHit`, `jobId` and `reread` (a re-read of the same job, which does not count bytes again); MySQL does not fill it. The MySQL driver uses `mysql2` with `multipleStatements: false`, `charset: 'utf8mb4'`, dates as text, big integers as text and binary as `{ kind: 'binary', hex, length }`.

A new engine is a registered dialect and driver; the interface and the policies do not change.

### GoogleSQL dialect

`src/shared/dialects/bigquery`: `lexer.ts` (names with and without backticks, project name with a hyphen in a path, strings `'…'`, `"…"`, triple-quoted and with an `r`, `b`, `rb` prefix, comments `#`, `--` and `/* */`, parameters `@x` and `?`, system variables `@@x`), `splitter.ts` (`;` outside strings and comments; `BEGIN … END`, `IF … END IF`, `LOOP`, `WHILE`, `REPEAT`, `FOR` and `CASE` stay whole, so a script becomes a single statement and is refused as a script, not in pieces), `classifier.ts` (only a query passes in Read-only: `SELECT`, `WITH`, pipe syntax starting with `FROM`, a parenthesized query; everything else gets its type from the start of the statement), `keywords.ts` and `functions.ts` (the list of built-in functions without a qualifier, for the agent rules). The `Classification` has BigQuery-only fields: `remoteCalls` (qualified calls outside the built-in prefixes, plus `ML.*` and `AI.*`), `externalQuery`, `jobsMetadata` (`INFORMATION_SCHEMA.JOBS*` and `SESSIONS*`) and `legacyDirective` (`#legacySQL`, `#standardSQL`). `Dialect.agentRules` also has `isUnknownFunction` and `messages.jobsMetadata`; `codemirrorDialect` is `'GoogleSQL'`, `databaseTerm` is `dataset` (the catalogs' key) and `valueKind` returns `unsupported`. `quoteIdent` uses backticks, with the backtick and the backslash escaped.

### BigQuery driver

`src/main/drivers/bigquery`: REST at `https://bigquery.googleapis.com/bigquery/v2`, without an SDK.

- **`client.ts`:** `BigqueryClient`, with injectable `fetch` and address (in the app, `net.fetch`: system proxy and certificates; in tests, the fake server). Responses validated with zod (64-bit integers arrive as text), `Authorization: Bearer` with the token from `refresh()` and one retry with a new token on a 401. A network failure becomes "No response from bigquery.googleapis.com".
- **`session.ts`:** `BigquerySession`, with no state on the server. The current dataset is kept in memory. A statement goes through: dry run (`jobs.insert` with `configuration.dryRun`, `useLegacySql: false`, `defaultDataset`; only this path brings `referencedRoutines`, which `prepare` returns as `routines`, `dataset.routine` without the project), refusal if the type is not `SELECT`, `jobs.query` with `maximumBytesBilled`, `jobTimeoutMs` (on agent requests), `requestId`, the label `cais: person|agent` and `useInt64Timestamp`, and pages of `jobs.getQueryResults` up to the row cap (final statistics from `jobs.get`, because `getQueryResults` does not carry the billed bytes). The job of the last result is kept for "Fetch up to 50,000" (`refetch`); without it, the result comes back as `RESULT_EXPIRED`. `cancel` uses `jobs.cancel` (with the job's location), and `close` cancels the job in progress.
- **`introspect.ts`:** `datasets.list`, `tables.list` and, with `{ database }`, `tables.get` for each table (limited concurrency) to get the columns.
- **`values.ts`:** value conversion and the type text (`STRUCT<…>`, `ARRAY<…>`, `NUMERIC(p, s)`). **`errors.ts`:** BigQuery's `reason` values and the HTTP codes become messages from the catalogs, with the role hint.
- **`index.ts`:** the driver (`open`, `introspect`, `test`) and the registry's `configureDrivers`, which sets up the transport at startup.
- **Credential:** `resolveCredential` receives the engine; BigQuery requires `gcloud-iam` and asks `GcloudTokenProvider.getAccessToken(account, sa)` for the token, with its own 50-minute cache. BigQuery's `ConnectParams` carries the project, the token, `refresh()`, the byte limit and the origin (`person` or `agent`).

### Cost and agents

The `SessionManager` calls `prepare` per statement, compares the estimate with the environment's limit and returns `needsConfirmation` with `reason: 'bytes'`; the confirmed request comes back with `confirmedBytes` per statement text, which becomes the job's `maximumBytesBilled`. `AgentExecutor.prepare` does one dry run per statement on the agent's read connection (only when the engine has `dryRun`: MySQL opens and sends nothing extra), and the broker uses the dry run's routines (approval at any level, reason `remoteFunction` with the first `dataset.routine`) and the estimate for the fixed 10 GiB (`AGENT_BYTES_APPROVAL`), for the job ceiling (the threshold, or the estimate rounded up to the GiB when the user approved because of the bytes) and for approval per function call. Trail lines carry `jobId`, `bytesEstimated` and `bytesBilled` per statement; on the request's line, the summed bytes and the `jobId` only when there was a job.

**Estimate while typing.** The `session:estimate` channel (`tabId`, the text of one statement) calls `SessionManager.estimate`, which acts only with `SessionDeps.estimateEnabled()` on (it comes from `settings.json`), with the tab connected, with `capabilitiesOf(engine).dryRun` and with exactly one statement; it reclassifies through the dialect, calls `prepare(text, { signal })` and answers `EstimateResponse` (`ok` with bytes, `error` with `inStatement`, `refused`, `skipped` with the reason). Any new request from the same tab aborts the previous one, even one that is skipped or refused right away (the `skipped` reason is `off`, `not-connected`, `unsupported`, `no-statement` or `cancelled`). It does not touch the tab's state or the inactivity clock and does not write to the Trail. In the renderer, `lib/estimate.ts` decides when to ask, keeps the answers (per environment, dataset and text, 2 minutes) and discards the answer for a text that has already changed; `lib/estimateLint.ts` is a `linter` from `@codemirror/lint` (800 ms pause, also when the cursor moves to another statement and through an effect when the switch turns on or the tab connects) that picks the statement the way "Run" does and returns the server's error as a diagnostic, on the word from `errorSpan` (`src/shared/estimate.ts`). The editor only installs this linter when the engine has `dryRun`. The state (`estimateAsYouType`, per-tab `estimates`) lives in the store and the status bar shows it.

**The model per engine.** `Environment` is a union discriminated by `engine`: MySQL stores `host` and `port`; BigQuery stores `gcpProject` and `maxBytesBilled?` (bytes; absent means no limit), and has no host or port. `ConnectParams` follows the same split, and `connectParamsFor` (`auth/credentials.ts`) builds the parameters of an environment or of a draft, with the origin (`person` or `agent`) that becomes the `cais` label on BigQuery jobs. The engine's capabilities (accepted modes, grid editing) live in `src/shared/engines.ts`: BigQuery only has Read-only. BigQuery test hooks, only in the unpackaged app: `CAIS_BIGQUERY_URL` (the API address) and, with `CAIS_E2E=1`, a fixed fake token in place of `gcloud`. The version check has its own: `CAIS_RELEASES_URL` (the releases API address) and, with `CAIS_E2E=1` and without it, the check fails immediately, without touching the network.

## Editor

The editor (`src/renderer/components/Editor.tsx`) combines `lang-sql` (highlighting and keywords) with three pieces of its own, and none of them knows the engine: what depends on it comes from the dialect and the capabilities.

- **Statement scope** (`src/shared/dialects/scope.ts`, pure TypeScript; `Dialect.analyze(text)`): reads the words, the quoted names and the punctuation of the statement with the engine's lexer (`mysql/scope.ts` uses the classifier's `tokenize`; `bigquery/scope.ts` uses GoogleSQL's `lex` and splits the backticked path) and returns the query blocks, with the tables from `FROM`, `JOIN`, the target of `UPDATE`, `DELETE ... USING` and `INSERT INTO`, and each one's alias. `tablesAt(analysis, position)` says what the position can see (a subquery sees the surrounding query; a derived table and a CTE body do not; each `UNION` branch is separate) and `completionContext` says what is being typed (name, qualifier before the dot, open quote) and what the position expects (`table`, `column` or `any`). It reads tokens and not a grammar tree, on purpose: the statement being typed is almost always incomplete, and a grammar gives up on it. Each engine only supplies the tokens and the rule for decoding a quoted name.
- **Candidates** (`src/shared/completion.ts`, pure): from the schema, the current database, the analysis and the position, it returns the options (column, table, view, database, alias) with detail and weight. The glue with CodeMirror (`src/renderer/lib/completion.ts`) finds the statement under the cursor, chooses the quotes and registers the source as SQL language data; `sql()` no longer receives the `schema`, so `lang-sql` does not offer the same names again. The source imports neither i18n nor the DOM (the detail words arrive as a parameter), and the tests run on an `EditorState`.
- **Columns on demand** (`src/renderer/lib/datasets.ts`): on engines with `lazyColumns`, a pause in typing triggers `loadDatasetColumns` for the datasets that the statement under the cursor mentions, through the scoped `schema:get` channel that the tree already uses. No new channel.
- **Syntax** (`src/renderer/lib/syntax/`): `mysql.ts` passes the statement through the MySQL grammar of `dt-sql-parser` and returns the first error (and decides what not to ask the grammar); `worker.ts` runs that in a module Web Worker (`new Worker(new URL('./worker.ts', import.meta.url))`, which Vite bundles into a separate file of about 3.7 MB, loaded only when the first statement is checked; the `script-src 'self'` CSP allows it, because `worker-src` falls back to it); `client.ts` is the page side (cache of the last 300 statements, a queue of one statement at a time with the timeout counted from when the worker starts on it, discarding what a newer pass made stale, restarting a worker that does not respond, and a worker that fails to start or crashes becomes "no error" and never an error on the page); `lint.ts` builds the `@codemirror/lint` `linter` over the cursor's statement and the ones on screen, among those the dialect splits; `index.ts` says which engines have checking (`syntaxCheck`). `dt-sql-parser` (and the `antlr4ng` and `antlr4-c3` it brings) are development dependencies, bundled into the worker.

## Main process

| Module | Role |
|---|---|
| `index.ts` | App and window lifecycle, menu (About in the app menu on macOS and under Help on Linux), single-instance lock, refusal of debugging options, test hooks, notifications |
| `ipc.ts` | IPC handlers: main window only, input validated with zod, translated errors |
| `sessions.ts` | `SessionManager`: one session per tab, modes, transaction, confirmations, inactivity, the user's Trail lines |
| `scheduler.ts` | Injectable clock, used by the user's and the agents' sessions (tests use a fake clock) |
| `auth/credentials.ts`, `auth/gcloud.ts` | Credential resolution and `GcloudTokenProvider` (with injectable `spawn`; only `auth list`, `sql generate-login-token` and `auth print-access-token`) |
| `drivers/` | Contract (`ConnectParams` per engine, `DbSession`, `Driver`) and the drivers. `drivers/mysql`: connection, session, introspection, values, errors. `drivers/bigquery`: REST client (`client.ts`, injectable `fetch` and address; in the app, `net.fetch`), session with no state on the server (`session.ts`), values, errors, introspection through `datasets.list`, `tables.list` and `tables.get` (see [BigQuery driver](#bigquery-driver)). `registry.ts` hands out the engine's driver, and `configureDrivers` sets up the BigQuery transport at startup |
| `store/` | `CatalogStore`, `ScriptStore`, `SettingsStore`, `TabsStore`, `Seal`, `Vault` and the atomic write |
| `trail.ts` | The Trail: one file per day, chaining, caps, password masking, listing and verification |
| `agents/` | Agent access: `server`, `broker`, `policy`, `sessions`, `access`, `audit`, `redact`, `errors` |
| `updates.ts` | `ReleaseChecker`: the version check in the About window (a `GET` to the GitHub releases API, only on click), with injectable `fetch`, address and clock, zod validation, a 1-hour cache and the fixed pages the app opens in the browser (`linkUrl`) |
| `cli-install.ts` | "Install cais Command in Terminal" (folders received as parameters, so tests never touch the machine) |
| `skill-install.ts` | "Install Agent Skill…" (`installSkill({ source, skillsDir })`: both paths are parameters, so tests never touch `~/.claude`; refuses links and files that are not Cais's own, writes atomically) |
| `i18n.ts` | Resolves the main process language before the menu |

## Files in the data folder

Everything lives in `app.getPath('userData')` (on macOS, `~/Library/Application Support/Cais`; on Linux, `${XDG_CONFIG_HOME:-~/.config}/Cais`), written atomically with permission 0600. An invalid JSON file is kept next to it as `<name>.corrupt-<date>.json` and the app opens empty at that point, with a warning.

| File | Content |
|---|---|
| `catalog.json` | Projects, environments and credentials (without passwords) |
| `secrets.json` | `{ [credentialId]: base64(password encrypted by safeStorage) }` |
| `seal.json` | Signing key (encrypted by the vault), the signatures of the environments and of the agent switch, and the list of environments awaiting verification |
| `settings.json` | `{ version: 1, agentAccess: boolean, estimateAsYouType?: boolean }`, both off by default; only `agentAccess` goes into the seal |
| `scripts.json` | Scripts saved per project |
| `tabs.json` | Open tabs (environment, text, database, linked script) and the active tab |
| `trail/YYYY-MM-DD.jsonl` | The Trail, one file per day (UTC), folder 0700, 90 days |
| `agent-endpoint.json` | `{ socket, pid, protocol }`, only with agent access on |
| `agent.sock` | The agent socket, only with access on (see [security.md](security.md#agent-channel-isolation)) |

## IPC

`src/shared/ipc.ts` defines the `CaisApi` contract and the channel names. Each renderer call goes through the preload and reaches a handler in `src/main/ipc.ts` that checks the sender (main window only), validates the arguments with zod and returns `{ ok, value }` or `{ ok: false, error: { message, code } }`. Groups:

- `catalog`: read, save, rename, duplicate and delete projects, environments and credentials; `gcloud` accounts.
- `connection.test`: test an environment draft.
- `session`: open, connect, disconnect, switch mode, run, cancel, commit, rollback, switch database, close, state and `estimate` (the dry run of the statement being written, only with the switch on).
- `settings`: read the user's preferences and turn "Estimate while typing" on or off (agent access has its own channels in `agents`).
- `schema`: tree of databases, tables and columns, cached per environment.
- `tabs`, `scripts`, `trail`, `agents` (the user's decisions on requests and the switch) and `app`: `app:quitCancelled` (the user gave up quitting with open transactions), `app:about` (app and runtime versions for the About window), `app:checkLatest` (the version check, with no arguments; only when the user clicks) and `app:openLink` (opens one of three fixed pages in the browser, by name: `repository`, `releases` or `release`; the address is built in the main process, see [security.md](security.md#main-process-and-renderer)).
- Events from main to renderer: session changes, agent requests, a request to resolve transactions before quitting and `event:openAbout` (the About menu item asks for the window, which is a renderer dialog: `AboutDialog`, in `components/About.tsx`).

## Language (i18n)

- `src/shared/i18n/areas/<area>/{pt-BR,en}.ts`: one catalog per area (menu, sidebar, sessionBar, grid, registry, agentsUi, trail, mainSessions, mainCatalog, dialect...). `pt-BR` is the reference and `en` is typed by its shape, so `tsc` flags a missing or extra key. A value is text or a function `(params) => string`.
- `core.ts` has numbers, dates and plurals with `Intl`; `locale.ts` has `resolveLocale`, `LOCALES` and `AGENT_LOCALE` (`en`, fixed).
- **Resolution:** the main process calls `app.getPreferredSystemLanguages()` in `whenReady`, before the menu, and passes the result to the renderer through `additionalArguments` (`--cais-locale=`). The preload checks it against the list; the renderer never chooses the main process language.
- **Two audiences:** text that serves both the user and the agent (modal alerts, `approval_reason`, `commit_reason`, statement errors) circulates as a `MessageRef` (`{ key, params }`). The screen renders it in the app language; the response to the agent renders it in `AGENT_LOCALE`. What only the agent reads (CLI output, `guide`, policy refusals) is written directly in English.
- The package declares `en` and `pt-BR` (`CFBundleLocalizations` and the `.lproj` folders from `electronLanguages`), so the per-app language setting on macOS works. On Linux, `getPreferredSystemLanguages()` reads the session environment (`LANGUAGE`, `LANG`).

## Agent access

- **`server.ts`** (`AgentServer`): `net.createServer` on the socket or named pipe, only with access on. One JSON line per message (`{ id, method, params }` → `{ id, ok, result | error }`), up to 1 MB, validated with zod. Writes and deletes `agent-endpoint.json`.
- **`policy.ts`**: `decide()`, a pure function that receives the mode, the production flag, the environment level, the Trail state and the classified statements, and returns run, ask for approval or refuse with a code.
- **`broker.ts`** (`AgentBroker`): request lifecycle, queue, expiry, 15-min grants, second decision, auto-commit and its limits, the responses to the agent (redacted, in `AGENT_LOCALE`) and the Trail lines.
- **`sessions.ts`** (`AgentSessions`): the agents' own connections. Read: up to 3 read-only sessions per environment, reset between requests and closed after 5 idle minutes. Write: a new session in Transaction mode per request, closed at the end. Fresh metadata to decide auto-commit.
- **`access.ts`**: turns access on and off (server, pending requests, open transactions, grants). **`audit.ts`**: the broker's side of the Trail (write a line and know whether it was written). **`redact.ts`**: redaction of connection errors.

## CLI

- `src/cli/cais.ts` is the entry point; `args.ts` parses the arguments, `endpoint.ts` finds the socket (`CAIS_SOCKET` or the `agent-endpoint.json` in the data folder), `client.ts` speaks the protocol, `exit.ts` maps exit codes, `output.ts` writes JSON and handles `EPIPE` (output closed by `| head` is not an error), `guide.ts` has the text of `cais llm guide`, and `skill.ts` embeds `skills/cais/SKILL.md` (Vite `?raw`, at build time) for `cais llm skill`, which needs neither the socket nor the app.
- `scripts/build-cli.mjs` bundles everything into `out/cli/cais.mjs`: a single file, Node modules only (`node:*`), Node 20 target, with a shebang and execute permission.
- The CLI has no dependencies and brings nothing from Electron.

## Packaging

- `npm run build`: `electron-vite build` (output in `out/main`, `out/preload`, `out/renderer`) and the CLI in `out/cli/cais.mjs`. The build's CSP is the restrictive one; the development server's relaxes what hot reload needs.
- `npm run dist`: `build` and `electron-builder --publish never`, which produces the targets of the system it runs on: macOS arm64 (`dmg` and `dir`) or Linux x64 (`deb`). On both, with `electronFuses`: `runAsNode` off, `enableCookieEncryption`, no `NODE_OPTIONS`, no inspect arguments, `enableEmbeddedAsarIntegrityValidation` and `onlyLoadAppFromAsar`. The `dist` script runs with `umask 022` so the package does not inherit group write permission. On macOS, also:
  - `afterSign: scripts/adhoc-sign.cjs`, which signs the `.app` ad hoc (`codesign --sign -`) after the fuses, because Apple Silicon refuses a binary with a broken signature;
  - `extraResources`: the CLI goes in `Cais.app/Contents/Resources/cli/cais.mjs`, outside the asar, because the system Node cannot read inside it; the skill goes in `Cais.app/Contents/Resources/skill/SKILL.md` (copy of `skills/cais/SKILL.md`, which the menu installs; in development the menu reads the repository file);
  - `electronLanguages: en, pt_BR` and `CFBundleLocalizations: en, pt-BR`.
- **Linux (`build.linux`, deb x64):** executable `cais-app` (installed in `/opt/Cais`, with a link in `/usr/bin` created by the `postinst`), `cais-app.desktop` entry (categories `Development;Database;`) and icon `build/icon.png`. electron-builder's default dependencies already include `libsecret-1-0`, which the vault needs. The CLI goes in `/opt/Cais/resources/cli/cais.mjs` and the skill in `/opt/Cais/resources/skill/SKILL.md` (`extraResources`); the `cais` command does not ship in the package and is installed by the app in `~/.local/bin`. The `postinst` sets up `chrome-sandbox` (setuid 4755 only when user namespaces are not available, otherwise 0755) and, with AppArmor on, installs the `cais-app` profile if `apparmor_parser` accepts it. The fuses also apply on Linux (checked with `@electron/fuses read`); only the ad-hoc signature (`afterSign`) is macOS-specific.
- **CI and release** (`.github/workflows`): `ci.yml` runs `npm run check` on Linux (with `xvfb-run`) on every push to any branch, except that a `gate` job skips a push whose tree already passed and the `chore(release)` commit. `release.yml`, triggered by a `vX.Y.Z` tag, checks the tag against `package.json`, reuses `ci.yml`, builds the deb on Linux and the dmg on macOS (`macos-15`, arm64, ad-hoc signature) and publishes the GitHub Release with `SHA256SUMS.txt`. The versioning process is in AGENTS.md.
- Icons: `build/icon.icns` and `build/icon.png` for the package; `resources/icon.png` for the Dock in development and the window icon on Linux and Windows; `resources/logo-mark.png` for the mark at the top of the sidebar and in the empty state.

## Tests

- `tests/unit`: Vitest without Docker. Dialect (splitter, classifier), `SessionManager` with a fake driver and fake clock, `gcloud` with a fake `spawn`, stores, signing, Trail, agent policy and broker, socket server (real socket in a temporary folder), CLI, i18n, grid editing, statement scope and autocomplete (on an `EditorState`, without a DOM) and syntax checking (the real grammar, with a corpus of valid SQL and one of invalid SQL in `tests/support/mysql-corpus.ts`). Vitest reads `dt-sql-parser` through `server.deps.inline`: the package ships ES modules with extensionless imports and without `"type": "module"`, which the bundler reads and Node does not.
- `tests/integration`: Vitest against a `mysql:8.4` in its own `cais-test-*` container, on a random port, removed at the end. It covers the driver, Read-only in the app and on the server, the transaction seen from a second connection, grid editing, agent access end to end (attacks on the classifier, secrets, limits, levels) and the syntax-check corpus (`PREPARE` reads each statement without running it: the server accepts all of the valid corpus and refuses those of the invalid corpus as syntax errors). The `bigquery*.test.ts` and `agents-bigquery.test.ts` files do not use Docker: they talk to the fake BigQuery server.
- `tests/live`: the live BigQuery suite (`npm run live:bigquery`), optional and outside `npm run check`. It needs `CAIS_BQ_LIVE_PROJECT` and `CAIS_BQ_LIVE_TOKEN` (the token comes from the environment: the suite never runs `gcloud`), skips everything without them and only reads: dry runs and queries without a table (0 bytes), metadata and one cancellation; the `SELECT` on the public table only runs with a 1-byte ceiling and is refused without charge. It checks that whatever the classifier lets through, the server reads as `SELECT`; `CAIS_BQ_LIVE_ROUTINE` and `CAIS_BQ_LIVE_VIEW` turn on the routines test in the dry run.
- `tests/e2e`: Playwright with `_electron`, opening the real app with a temporary `userData` and socket and the real CLI as a child process.
- `tests/support`: the test container, the agent broker assembled for tests, fixtures and `bigquery-fake.ts`, the fake BigQuery server: HTTP on `127.0.0.1`, random port, with the subset of the API that Cais uses (`jobs.insert` with a dry run of configurable type, bytes and routines, `jobs.query`, `getQueryResults` with pages, `jobs.cancel`, `jobs.get`, datasets and tables) and hooks for a per-statement error, a slow job, a job that expires and an invalid token. There is no emulator: the community emulator has no sessions and lacks much of `INFORMATION_SCHEMA`, and the dry run is the center of Read-only; the fake covers the contract and the live suite covers the real server.
