import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  Notification,
  safeStorage,
  type MenuItemConstructorOptions,
} from 'electron';
import { CHANNELS } from '@shared/ipc';
import { LOCALE_ARG, m } from '@shared/i18n';
import { getDialect } from '@shared/dialects/registry';
import { AgentAccess } from './agents/access';
import type { AuditEntry } from './agents/audit';
import { AgentBroker } from './agents/broker';
import { AgentServer, socketPathFor } from './agents/server';
import { AgentSessions, realScheduler } from './agents/sessions';
import { resolveCredential, toConnectParams } from './auth/credentials';
import { installCli } from './cli-install';
import { GcloudTokenProvider, type SpawnFn } from './auth/gcloud';
import { CaisError } from './errors';
import { initMainLocale, mainLocale } from './i18n';
import iconPath from '../../resources/icon.png?asset';
import { getDriver } from './drivers/registry';
import { registerIpc } from './ipc';
import { SessionManager } from './sessions';
import type { Environment } from '@shared/model';
import { CatalogStore } from './store/catalog';
import { ScriptStore } from './store/scripts';
import { SettingsStore } from './store/settings';
import { TabsStore } from './store/tabs';
import { FakeVault, SafeStorageVault, type Vault } from './store/vault';
import { Seal } from './store/seal';
import { Trail } from './trail';

// Test hook: only honored by an unpackaged app. The packaged app ignores these variables.
const e2e = !app.isPackaged && process.env.CAIS_E2E === '1';

/** CAIS_IDLE_MS (tests): the idle disconnect after this many ms instead of 30 minutes. Never in the packaged app. */
function testIdleMs(): number | undefined {
  if (app.isPackaged || !process.env.CAIS_IDLE_MS) return undefined;
  const ms = Number(process.env.CAIS_IDLE_MS);
  return Number.isInteger(ms) && ms >= 100 ? ms : undefined;
}

// A debugger attached to the window can do anything the person can (approve, commit, turn agent access on):
// an agent with a shell could restart the app with one. Outside the test hook, Cais refuses to start with any.
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins', 'inspect', 'inspect-brk', 'inspect-port', 'inspect-publish-uid'];
const debugRequested =
  DEBUG_SWITCHES.some((name) => app.commandLine.hasSwitch(name)) ||
  process.argv.some((arg) => /^--(remote-debugging|remote-allow-origins|inspect)/.test(arg));
if (debugRequested && !e2e) {
  initMainLocale();
  process.stderr.write(`${m().native.debugRefused}\n`);
  app.exit(1);
  process.exit(1);
}
if (e2e && process.env.CAIS_USER_DATA) {
  app.setPath('userData', process.env.CAIS_USER_DATA);
}

// One Cais per user (and per user data folder): a second launch focuses the first window and quits.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

let mainWindow: BrowserWindow | null = null;
let allowQuit = false;
let quitRequested = false;

const isMac = process.platform === 'darwin';

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const spawnProcess: SpawnFn = (command, args, options) =>
  spawn(command, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });

/** Path of the bundled CLI: next to the app resources when packaged (system Node cannot read inside the asar). */
function cliPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'cli', 'cais.mjs') : join(app.getAppPath(), 'out', 'cli', 'cais.mjs');
}

function installCliCommand(): void {
  const result = installCli({
    target: cliPath(),
    candidates: ['/usr/local/bin', join(homedir(), '.local', 'bin')],
    pathEnv: process.env.PATH ?? '',
  });
  void dialog.showMessageBox({
    type: result.ok ? 'info' : 'error',
    message: result.ok ? m().native.installDone : m().native.installFailed,
    detail: result.message,
    buttons: [m().native.ok],
  });
}

function buildMenu(): void {
  // Every item carries its own label (role items too), so the whole menu follows the app locale.
  const t = m().menu;
  const template: MenuItemConstructorOptions[] = [];
  const install: MenuItemConstructorOptions = {
    label: t.installCli,
    enabled: process.platform !== 'win32',
    click: installCliCommand,
  };
  if (isMac) {
    template.push({
      label: t.app,
      submenu: [
        { role: 'about', label: t.about },
        { type: 'separator' },
        install,
        { type: 'separator' },
        { role: 'hide', label: t.hide },
        { role: 'hideOthers', label: t.hideOthers },
        { role: 'unhide', label: t.unhide },
        { type: 'separator' },
        { role: 'quit', label: t.quit },
      ],
    });
  } else {
    template.push({ label: t.file, submenu: [install, { type: 'separator' }, { role: 'quit', label: t.quit }] });
  }
  // The Edit menu item by item ({ role: 'editMenu' } would bring Electron's English labels).
  template.push({
    label: t.edit,
    submenu: [
      { role: 'undo', label: t.undo },
      { role: 'redo', label: t.redo },
      { type: 'separator' },
      { role: 'cut', label: t.cut },
      { role: 'copy', label: t.copy },
      { role: 'paste', label: t.paste },
      ...(isMac ? [{ role: 'pasteAndMatchStyle' as const, label: t.pasteAndMatchStyle }] : []),
      { role: 'delete', label: t.delete },
      { type: 'separator' },
      { role: 'selectAll', label: t.selectAll },
    ],
  });
  const view: MenuItemConstructorOptions[] = [{ role: 'togglefullscreen', label: t.toggleFullScreen }];
  if (!app.isPackaged) view.push({ role: 'reload', label: t.reload }, { role: 'toggleDevTools', label: t.toggleDevTools });
  template.push({ label: t.view, submenu: view });
  // Cmd+W and Cmd+T belong to the renderer (tabs), so no "Close Window" item here.
  template.push({ label: t.window, submenu: [{ role: 'minimize', label: t.minimize }, { role: 'zoom', label: t.zoom }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function themedBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#232322' : '#f6f5f2';
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Cais',
    // macOS takes the icon from the bundle (or the Dock in development); Linux and Windows from the window.
    // electron-vite resolves resources/ next to the app, which a packaged build does not ship: check first.
    ...(!isMac && existsSync(iconPath) ? { icon: iconPath } : {}),
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 14 },
          // Vibrancy shows through the translucent sidebar. Under test there is nothing to blend with,
          // so the window gets a plain themed background instead.
          ...(e2e ? {} : { vibrancy: 'sidebar' as const }),
        }
      : {}),
    ...(e2e ? { backgroundColor: themedBackground() } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
      // the renderer gets the locale main resolved; the preload checks it against the known list
      additionalArguments: [`${LOCALE_ARG}${mainLocale()}`],
    },
  });
  win.once('ready-to-show', () => (e2e ? win.showInactive() : win.show()));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  if (e2e) {
    nativeTheme.on('updated', () => win.setBackgroundColor(themedBackground()));
  }
  win.on('close', (event) => {
    if (!allowQuit) {
      event.preventDefault();
      app.quit();
    }
  });
  win.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');
  const vault: Vault = e2e ? new FakeVault() : new SafeStorageVault(safeStorage);
  // the seal signs what decides how much agents may do; the trail is chained with the same key
  const seal = new Seal(userData, vault);
  await seal.load();
  const trail = new Trail(join(userData, 'trail'), {
    now: () => Date.now(),
    scheduler: realScheduler,
    newId: () => `t_${randomBytes(6).toString('hex')}`,
    mac: (text) => seal.mac(text),
  });
  const hadTrail = trail.hasDays();
  trail.start(join(userData, 'agent-audit.jsonl'));
  const store = new CatalogStore(userData, vault, seal);
  await store.load();
  const slugOf = (env: Environment): string => `${store.getProject(env.projectId)?.name ?? '?'}/${env.name}`;
  const recordConfig = (detail: string, env?: Environment, actor: 'person' | 'cais' = 'person'): void => {
    trail.append({
      actor,
      environment: env ? slugOf(env) : '',
      ...(env ? { environmentId: env.id } : {}),
      production: env?.production ?? false,
      mode: 'config',
      event: 'config',
      sql: '',
      state: 'ok',
      detail,
    });
  };
  if (seal.status === 'missing' && hadTrail) {
    recordConfig(m().mainMisc.sealRecreated, undefined, 'cais');
  }
  for (const note of store.integrityNotes) recordConfig(note, undefined, 'cais');
  const tabs = new TabsStore(userData);
  const scripts = new ScriptStore(userData, {
    getProject: (id) => store.getProject(id),
    getEnvironment: (id) => store.getEnvironment(id),
    now: () => Date.now(),
  });
  await scripts.load();
  if (scripts.notice) store.addNotice(scripts.notice);
  store.setScriptCounter((projectId) => scripts.countForProject(projectId));
  const settings = new SettingsStore(userData, seal);
  await settings.load();
  if (settings.notice) store.addNotice(settings.notice);
  if (settings.tampered) recordConfig(settings.notice!, undefined, 'cais');
  const gcloud = new GcloudTokenProvider({
    spawn: spawnProcess,
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
    exists: isExecutable,
    now: () => Date.now(),
  });

  const sessions = new SessionManager({
    getEnvironment: (id) => store.getEnvironment(id),
    resolveConnectParams: async (environment) => {
      store.requireTrusted(environment.id);
      const credential = store.getCredential(environment.credentialId);
      if (!credential) throw new CaisError(m().mainMisc.credentialNotFound);
      const resolved = await resolveCredential(credential, {
        getPassword: (id) => store.getPassword(id),
        getToken: (account, sa) => gcloud.getToken(account, sa),
      });
      return toConnectParams(
        { host: environment.host, port: environment.port, database: environment.defaultDatabase },
        resolved,
      );
    },
    getDriver,
    getDialect,
    emit: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CHANNELS.eventSessionState, state);
    },
    now: () => Date.now(),
    scheduler: realScheduler,
    // fixed at 30 minutes; the test hook only exists outside the packaged app
    ...(testIdleMs() !== undefined ? { idleMs: testIdleMs() } : {}),
    trail: {
      append: ({ environment, database, ...line }) => {
        trail.append({
          actor: 'person',
          environment: slugOf(environment),
          environmentId: environment.id,
          production: environment.production,
          ...(database ? { database } : {}),
          ...line,
        });
      },
    },
  });

  // --- agent access: socket, broker, trail. Nothing listens until the person turns it on. ---
  const resolveParams = async (environment: Environment) => {
    // an environment changed outside the Cais may point at someone else's host: no credential goes there
    store.requireTrusted(environment.id);
    const credential = store.getCredential(environment.credentialId);
    if (!credential) throw new CaisError(m().mainMisc.credentialNotFound);
    const resolved = await resolveCredential(credential, {
      getPassword: (id) => store.getPassword(id),
      getToken: (account, sa) => gcloud.getToken(account, sa),
    });
    return toConnectParams(
      { host: environment.host, port: environment.port, database: environment.defaultDatabase },
      resolved,
    );
  };
  let lastNotified = 0;
  const audit = {
    append: (entry: AuditEntry) => trail.append({ ...entry, actor: entry.actor ?? 'agent' }),
    healthy: () => trail.healthyForAgents(),
  };
  const broker = new AgentBroker({
    now: () => Date.now(),
    scheduler: realScheduler,
    newId: () => `req_${randomBytes(6).toString('hex')}`,
    catalog: { projects: () => store.projects(), environments: () => store.environments() },
    scripts: {
      list: () => scripts.list(),
      get: (id) => scripts.get(id),
      save: (input, by) => scripts.save(input, by),
    },
    executor: new AgentSessions({ getDriver, getDialect, resolveConnectParams: resolveParams }),
    audit,
    getDialect,
    onChange: () => pushAgents(),
    onNewPending: (view) => {
      if (e2e) return; // no system notifications while testing
      // at most one notification (and one Dock bounce) every 30 s; later ones are folded into a count
      const now = Date.now();
      if (now - lastNotified < 30_000) return;
      lastNotified = now;
      const waiting = broker.snapshot().pending.length;
      const texts = m().native.notification;
      const note = new Notification({
        title: texts.title,
        body:
          waiting > 1
            ? texts.pendingMany({ count: waiting })
            : view.status === 'awaiting_commit'
              ? texts.awaitingCommit({ environment: view.environmentLabel })
              : view.status === 'failed'
                ? texts.commitUncertain({ environment: view.environmentLabel })
                : texts.pendingOne({ mode: view.mode === 'write' ? 'write' : 'read', environment: view.environmentLabel }),
      });
      note.on('click', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      });
      note.show();
      app.dock?.bounce('informational');
    },
    onScriptsChanged: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CHANNELS.eventScriptsChanged);
    },
  });
  const server = new AgentServer({
    broker,
    socketPath: socketPathFor({
      userData,
      platform: process.platform,
      uid: process.getuid?.() ?? 0,
      username: userInfo().username,
      tmpdir: tmpdir(),
      // CAIS_SOCKET only counts in an unpackaged app (the test hook); the packaged app ignores it
      ...(!app.isPackaged && process.env.CAIS_SOCKET ? { override: process.env.CAIS_SOCKET } : {}),
    }),
    endpointPath: join(userData, 'agent-endpoint.json'),
    platform: process.platform,
    pid: process.pid,
    appVersion: app.getVersion(),
  });
  const access = new AgentAccess({ settings, broker, server, onChange: () => pushAgents() });
  function pushAgents(): void {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CHANNELS.eventAgents, access.snapshot());
  }
  await access.init();

  const requestQuit = (): boolean => {
    const pending = sessions.pendingTransactions();
    if (pending.length === 0) return false;
    quitRequested = true;
    mainWindow?.webContents.send(CHANNELS.eventResolveTransactions, pending);
    return true;
  };

  registerIpc({
    store,
    tabs,
    scripts,
    agents: { access, broker },
    gcloud,
    sessions,
    isMainWindow: (contents) => mainWindow !== null && contents === mainWindow.webContents,
    afterSessionClose: () => {
      if (quitRequested && sessions.pendingTransactions().length === 0) {
        allowQuit = true;
        app.quit();
      }
    },
    onQuitCancelled: () => {
      quitRequested = false;
    },
    trail,
    recordConfig: (detail, env) => recordConfig(detail, env),
  });

  // Quitting: first the person's open transactions (a dialog), then the agents' (pending requests expire,
  // open transactions roll back, the socket goes away), then the connections. Bounded, so quitting never hangs.
  let cleanedUp = false;
  app.on('before-quit', (event) => {
    if (cleanedUp) return;
    if (!allowQuit && requestQuit()) {
      event.preventDefault();
      return;
    }
    allowQuit = true;
    event.preventDefault();
    const finish = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      trail.stop();
      app.quit();
    };
    const bound = setTimeout(finish, 4000);
    void Promise.allSettled([access.shutdown(), sessions.closeAll()]).then(() => {
      clearTimeout(bound);
      finish();
    });
  });

  buildMenu();
  mainWindow = createWindow();
}

app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && !allowQuit) void bootstrapWindowOnly();
});

function bootstrapWindowOnly(): void {
  mainWindow = createWindow();
}

void app.whenReady().then(async () => {
  if (!gotLock) return;
  // the locale comes first: the menu, dialogs and the window's argument depend on it
  initMainLocale();
  nativeTheme.themeSource = 'system';
  // development only: the packaged app takes its Dock icon from the bundle
  if (isMac && !app.isPackaged) app.dock?.setIcon(iconPath);
  try {
    await bootstrap();
  } catch (error) {
    // never end up without a window and without an explanation
    dialog.showErrorBox(m().native.startupFailed, error instanceof Error ? error.message : String(error));
    allowQuit = true;
    app.quit();
  }
});
