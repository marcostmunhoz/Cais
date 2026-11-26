# AGENTS.md — Cais

Desktop SQL client (Electron + React + TypeScript), organized by project and environment. MySQL first and BigQuery read-only, with the engine isolated behind driver and dialect contracts; IAM login on Cloud SQL through `gcloud`; AI agent access through the `cais llm` CLI, with approval in the app.

Before changing behavior, read [docs/behavior.md](docs/behavior.md) (what the product does and why) and [docs/security.md](docs/security.md) (the security model). The architecture is in [docs/architecture.md](docs/architecture.md) and the CLI contract in [docs/agents.md](docs/agents.md).

## Code map

| Folder | What it holds |
|---|---|
| `src/main` | Main process: lifecycle, IPC (`ipc.ts`), the user's sessions (`sessions.ts`), drivers (`drivers/mysql`, `drivers/bigquery`), credentials and `gcloud` (`auth/`), files and vault (`store/`), Trail (`trail.ts`), local log (`log.ts`), agent access (`agents/`) |
| `src/preload` | The `window.cais` bridge (`CaisApi` contract) |
| `src/renderer` | React interface (`components/`, `lib/`) |
| `src/shared` | Pure TypeScript used by both sides: model, results, IPC contract, dialects (`dialects/mysql`, `dialects/bigquery`), per-engine capabilities (`engines.ts`), i18n (`i18n/`), text rules, grid editing |
| `src/cli` | The `cais llm` command (no dependencies, bundled by `scripts/build-cli.mjs`; `skill.ts` embeds `skills/cais/SKILL.md` with a Vite `?raw` import for `cais llm skill`) |
| `tests` | `unit`, `integration` (MySQL in a container; BigQuery against a fake server, no Docker), `e2e` (Playwright with Electron), `live` (real BigQuery, optional), `support` |
| `scripts` | CLI bundling and the app's ad-hoc signing (`afterSign`) |
| `skills/cais` | Skill for agents to use the CLI |
| `docs` | Documentation for the product, security, architecture and the CLI |

## Invariants

- **Secrets never leave the main process** in plain text and never go to a log. The only log is `main.log` (`src/main/log.ts`), allowlist-only: it takes a typed `LogEvent` from a closed union, never a message string, and never holds SQL, results, database or `gcloud` text, hosts, names, ids, emails, tokens, user file paths or agent content. A new event is a new union member with closed fields, a line in `docs/security.md#the-local-log` and a unit test; there is no option to turn it off (reason in `docs/behavior.md`). The password enters through IPC only when saving and never returns to the renderer. Agents never receive a password, token, host or credential id, nor the Google Cloud project or account emails (BigQuery).
- **The main process never trusts the renderer:** every IPC channel validates its input with zod, only accepts the main window, and the SQL is reclassified by the dialect before it runs.
- **The interface does not know the engine:** dialect, statement classification, statement scope for autocomplete (`Dialect.analyze`) and introspection come from `src/shared/dialects` and `src/main/drivers`; what an engine does or does not do (columns per dataset, local syntax check) comes from `src/shared/engines.ts`.
- **The app never changes `gcloud`:** only three commands, all read-only: `gcloud auth list`, `gcloud sql generate-login-token` and `gcloud auth print-access-token` (BigQuery token, with its own 50-minute cache).
- **Every agent request is reclassified in main** (`src/main/agents/policy.ts`). An agent does not approve, does not turn access on, does not change an environment's level and does not edit or delete scripts. The socket exists only with agent access on (`settings.json`, off by default). On Production, an agent's write always needs approval. No agent action runs without the Trail.
- **Read-only in two layers:** the app's list and, on the server, `READ ONLY` (MySQL) or the dry run that only lets `SELECT` through (BigQuery, repeated inside `BigquerySession.execute`). In the classifier, when in doubt, it refuses.
- **BigQuery cost:** an agent read estimated above 10 GiB (`AGENT_BYTES_APPROVAL`, fixed, summing the request) or above the environment's limit, if lower, waits for the user at any level, and every agent job carries `maximumBytesBilled`. The dry run goes through `jobs.insert`, and an agent read that uses any routine (`referencedRoutines`; inside a view, not yet checked against the real server: `docs/security.md`) waits for the user at any level.
- **Estimate while typing (BigQuery):** main decides what goes out (`SessionManager.estimate`): only with the switch on in `settings.json` (`estimateAsYouType`, off by default, outside the agent access seal), one statement at a time, reclassified by the dialect, and it never executes or enters the Trail. Main checks the switch, the number of statements and the classifier on every request; the renderer only chooses when to ask; the channel does not exist on the agent socket.
- **Linux:** the vault is only accepted with a real keyring (Secret Service; `basic_text` and `unknown` are refused in `SafeStorageVault`). The shortcut texts shown in the interface come from `src/shared/shortcuts.ts` (symbols on macOS, Ctrl+… elsewhere), never hardcoded in the component; key handling lives in `App.tsx` (`useGlobalShortcuts`) and must match those texts (the exception is the grid's Delete key, which marks rows for deletion: handling lives in `Results.tsx`, through `isDeleteRowsKey` from the same `shortcuts.ts`). The agent socket falls back to `$XDG_RUNTIME_DIR` when the default path exceeds 100 bytes. The deb installs the `cais-app` executable in `/opt/Cais`.
- **Few options:** no configuration option without its reason recorded in `docs/behavior.md`.
- **Language:** the repository is in English: docs, README, `AGENTS.md`, `skills/cais/SKILL.md`, and release notes are in English, and everything sent to agents (CLI output, `guide`, broker answers and refusals) is in English regardless of the system language. Only the in-app UI follows the system language, pt-BR or English. Every text the user sees comes from the catalogs in `src/shared/i18n/areas` (both languages, same key), never written directly in the component. No exclamation marks; trade terms as developers say them (commit, rollback, schema, query); the pt-BR catalog keeps the same style rule.
- **Network:** only the main process leaves the machine (databases, `bigquery.googleapis.com`, the `gcloud` subprocess and, only when the user clicks Check in the About Cais window, `api.github.com`; full list in `docs/security.md`). The local log is a file write and involves no network. What opens in the browser is fixed and built in main (`app:openLink` receives a name, never an address). No check runs on its own.
- **Cais runs one instance per user** (`requestSingleInstanceLock`) and refuses to start with remote debugging options (`--inspect*`, `--remote-debugging-*`), except under the e2e hook. DevTools only exists outside the packaged app.

## Conventions

- TypeScript `strict`; code, identifiers and comments in English. The documentation in `docs/` and the README are in English too.
- Dependencies with exact versions (no `^`), `package-lock.json` committed.
- The lockfile changes with the npm version: use npm 11.x on both machines. Dependency install scripts must be in the `package.json` `allowScripts` (`npm install-scripts ls` must show nothing pending).
- `src/shared` is pure TypeScript: no Node, no DOM.
- `vitest` stays on 4.x (5.x requires Node 22). `typescript` is on 7.x: no `baseUrl`, aliases use `paths` with `./`.
- The CSP keeps `style-src 'unsafe-inline'` because CodeMirror injects styles. The MySQL syntax check runs in a module Web Worker (`src/renderer/lib/syntax/worker.ts`); `script-src 'self'` is enough, no `worker-src`.
- `dt-sql-parser` (grammar for the error underline, a development dependency bundled in the worker) ships ES modules without extensions: Vitest reads it through `server.deps.inline` in both configs. The list of what the grammar misreads (`src/renderer/lib/syntax/mysql.ts`) has a test against its vocabulary (`tests/unit/syntax-mysql.test.ts`): when the package version changes, the test shows what changed.

## Commands

All run from the project root, with Node 20.19 or newer and npm.

| Command | What it does |
|---|---|
| `npm install` | Installs the dependencies (exact versions). |
| `npm run dev` | Opens the app in development (electron-vite, with hot reload). |
| `npm run typecheck` | Strict `tsc` on both projects (`tsconfig.node.json` and `tsconfig.web.json`). |
| `npm run unit` | Vitest without Docker: dialect, sessions (fake driver and clock), `gcloud` (fake spawn), stores, signature, Trail, agent policy and broker, socket server (real socket in a temporary folder), CLI, i18n, grid editing. |
| `npm run integration` | Vitest against a `mysql:8.4` in its own `cais-test-*` container, random port, removed at the end (includes agent access end to end). Needs Docker. |
| `npm run build` | `electron-vite build` (output in `out/`) and `scripts/build-cli.mjs`, which bundles the CLI into `out/cli/cais.mjs` (a single file, Node modules only, executable). |
| `npm run e2e` | Playwright `_electron`: opens real windows (on Linux headless by itself, see Tests) with a temporary `userData` and socket, starts its own `cais-test-*` container, runs the real CLI as a child process and rewrites the screenshots in `tests/e2e/screenshots/`. Needs `npm run build` first and Docker. |
| `npm run e2e -- tests/e2e/docs-images.spec.ts` | Regenerates the English screenshots of `docs/images/` (a dedicated spec with `CAIS_LOCALE=en`, 1280x800, written to `tests/e2e/screenshots/<name>-en.png`); copy each one over `docs/images/<name>.png` (same name without `-en`). Needs `npm run build` first and Docker; headless on Linux like `npm run e2e`. |
| `npm run check` | `typecheck && unit && integration && build && e2e`. It must be green to commit. On Linux its e2e step runs headless by itself (no `xvfb-run` needed). |
| `npm run live:bigquery` | Optional live suite against a sandbox BigQuery project, outside `npm run check`. Needs `CAIS_BQ_LIVE_PROJECT` and `CAIS_BQ_LIVE_TOKEN` (the token is the one from `gcloud auth print-access-token`, which you run yourself); optional: `CAIS_BQ_LIVE_DATASET`, `CAIS_BQ_LIVE_ROUTINE` (persistent scalar function of one INT64, `dataset.routine`) and `CAIS_BQ_LIVE_VIEW` (`dataset.view` that calls that routine). Skips everything without the first two, only reads: dry runs and queries without a table (0 bytes), metadata and one cancellation; the SELECT on the public table only runs with a 1-byte cap and is refused without charge. Never runs `gcloud`; the header of `tests/live/bigquery.test.ts` has step-by-step instructions. Checks what the server says for each statement class (the dry run's `statementType`) against the classifier. |
| `npm run cli -- llm envs` | Rebuilds the CLI and runs `cais llm …`. Needs Cais open (`npm run dev`) with agent access on. |
| `npm run dist` | `build` + electron-builder, which produces the targets for the system it runs on. macOS: `dist/Cais-<version>-arm64.dmg` and `dist/mac-arm64/Cais.app`. Linux: `dist/cais_<version>_amd64.deb` (x64, `cais-app` executable, CLI at `/opt/Cais/resources/cli/cais.mjs`). On both, with hardened Electron fuses (`electronFuses`) and `umask 022`; on macOS, also local ad-hoc signing (`scripts/adhoc-sign.cjs`, `afterSign` hook). The skill ships in `resources/skill/SKILL.md` next to it (`Cais.app/Contents/Resources/skill/SKILL.md`, `/opt/Cais/resources/skill/SKILL.md` in the deb), a copy of the single source `skills/cais/SKILL.md`, which `cais llm skill` also embeds at build time. The CLI ships in `Cais.app/Contents/Resources/cli/cais.mjs` (`extraResources`: the system Node does not read inside the asar) and runs on the system Node, not through Electron (the `runAsNode` fuse stays off). |

## Versions and releases

- `main` is protected: no direct pushes, the `check` status is required and the branch must be up to date. The version bump goes in through a PR, in one of two ways: as the last commit of a feature PR (`npm version x.y.z --no-git-tag-version`, commit `chore(release): x.y.z`), or with `npm run release -- x.y.z`, which opens a `release/x.y.z` PR, waits for its `check`, merges it (merge commit) and continues. Either way the script (`scripts/release.mjs`, `--dry-run` prints the steps) then waits for the `check` on the merge commit on main, creates the `vx.y.z` tag on that tested commit and pushes only the tag. Run it from a clean, up-to-date `main` with `gh` authenticated. The `release.yml` workflow checks that the tag matches the `package.json` version, runs `npm run check`, builds the deb (Linux) and the dmg (macOS arm64, ad-hoc signing) and publishes the GitHub Release with both files and `SHA256SUMS.txt`.
- Tags and releases are made only by the user, never by an agent, unless the user asks.
- CI (`ci.yml`) runs `npm run check` on Linux on every push to any branch, and the result shows on the pull request. A first `gate` job skips a push whose tree already passed in an earlier successful run (so a merge commit of an up-to-date branch is not tested twice); `workflow_dispatch` and the tag call from `release.yml` always run the full check. It fails open: a failed gate runs the `check`, and a cancelled run never becomes green (a skipped job counts as success for a required check). macOS only runs on release, because its minutes cost 10 times more.
- Actions are pinned by full SHA, with the version in a comment. Only `actions/*`, and the only secret is `github.token`.

## Tests

- **Test hooks** only apply with `!app.isPackaged`; the packaged app ignores them:
  - `CAIS_E2E=1`: fake vault (no Keychain), the `userData` from `CAIS_USER_DATA` (and the logs folder, `CAIS_USER_DATA/logs`), and accepts the debugging options (Playwright uses them);
  - `CAIS_SOCKET`: agent socket path (the CLI also reads it);
  - `CAIS_LOCALE` = `pt-BR` | `en`: e2e pins `pt-BR` by default and uses `en` in the language test (`i18n.spec.ts`) and in the docs screenshots (`docs-images.spec.ts`);
  - `CAIS_IDLE_MS`: integer of 100 ms or more, shortens the inactivity time before disconnecting;
  - `CAIS_BIGQUERY_URL`: replaces the BigQuery API address with the fake server's;
  - `CAIS_RELEASES_URL`: replaces the GitHub releases API address (version check in the About Cais window) with a fake server's; with `CAIS_E2E=1` and without it, the check answers "Could not check." without going out to the network;
  - with `CAIS_E2E=1`, the BigQuery token is a fixed fake value (`cais-test-access-token`) and the `gcloud` account list is a fixed fake account (`ana@exemplo.com`): e2e never runs `gcloud`.
- **Headless e2e on Linux:** `npm run e2e` (`scripts/e2e.mjs`) runs Playwright under `xvfb-run -a` by itself when `xvfb-run` is on the PATH (otherwise it prints how to install it, package `xvfb`), and the specs launch Electron through `electronOptions` in `tests/e2e/helpers.ts`: `--ozone-platform=x11` and no `WAYLAND_DISPLAY` (xvfb-run only sets `DISPLAY`, and on a Wayland session Electron would still open windows on the real desktop). It never opens windows on the desktop. CI keeps its explicit `xvfb-run -a npm run check`; the wrapper skips itself when `CI` or `CAIS_XVFB` is set. macOS runs as before.
- **Database:** tests use only their own `cais-test-*` container, on a random port. Never port 3306 (so it does not collide with a local MySQL), never another container, never a real database. If a test hangs and leaves a container behind: `docker ps -a --filter name=cais-test-` and `docker rm -f` them.
- **`gcloud`:** never run the real `gcloud` in tests. They use a fake `gcloud` (injectable `spawn`).
- **BigQuery:** tests never talk to Google. The driver takes an injectable `fetch` and address, and `tests/support/bigquery-fake.ts` is a local HTTP server (random port) with the subset of the API that Cais uses, with the dry run type, the bytes, the errors and the slowness configurable per test. The `CAIS_BIGQUERY_URL` hook and the fake token and account in e2e are in the list above. The live suite, `npm run live:bigquery` (`tests/live/`, outside `npm run check`), needs `CAIS_BQ_LIVE_PROJECT` and `CAIS_BQ_LIVE_TOKEN`, skips everything without them and never runs `gcloud`.
- **`cais` command and skill:** never install them on the machine during tests. `installCli` and `installSkill` take the folders as parameters and tests use a temporary folder (never the real `~/.claude`). The menu items open native dialogs and are not clicked in e2e: tests only check that they exist, with the right label, in both locales.
- **Agent access:** any change in `src/main/agents/` or `src/cli/` needs `tests/unit/agent-*.test.ts` and `tests/integration/agents*.test.ts` (attacks, secrets, limits) green, and the CLI output stable byte for byte (the MySQL output cannot change because of BigQuery: `tests/unit/agent-bigquery.test.ts` checks the keys and their order). A change to the BigQuery agent rules (`src/shared/dialects/bigquery`, `policy.ts`, `broker.ts`, `redact.ts`) also needs `tests/unit/agent-bigquery.test.ts` and `tests/integration/agents-bigquery.test.ts` green.
- New classifier rules come with a unit test and, when they depend on the server, with an integration test that checks the server state afterwards.

## Commits

Only with the full suite green (`npm run check`). No AI attribution lines in commits or pull requests.
