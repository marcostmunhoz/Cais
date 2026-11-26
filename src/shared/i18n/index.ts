/**
 * i18n entry point (pure TS: Intl only, no Node, no DOM).
 *
 * - Catalogs live in `areas/<area>/pt-BR.ts` (the reference) and `areas/<area>/en.ts` (typed `Shape<typeof ptBR>`).
 * - `m()` gives the messages of the current locale, `fmt()` its number/date formatting. The current locale is set
 *   once per process (`setLocale`) by main (`src/main/i18n.ts`) and by the renderer (`src/renderer/lib/i18n.ts`);
 *   it stays pt-BR when nobody sets it (unit tests).
 * - `MessageRef` carries text that two audiences read: `renderRef(ref, locale)` renders it for the person in the
 *   app locale and for agents in `AGENT_LOCALE` (English, fixed).
 */
import { createFormat, type Format, type Locale, type Shape } from './core';
import { ptBR as commonPtBR } from './areas/common/pt-BR';
import { en as commonEn } from './areas/common/en';
import { ptBR as menuPtBR } from './areas/menu/pt-BR';
import { en as menuEn } from './areas/menu/en';
import { ptBR as aboutPtBR } from './areas/about/pt-BR';
import { en as aboutEn } from './areas/about/en';
import { ptBR as nativePtBR } from './areas/native/pt-BR';
import { en as nativeEn } from './areas/native/en';
import { ptBR as appPtBR } from './areas/app/pt-BR';
import { en as appEn } from './areas/app/en';
import { ptBR as sidebarPtBR } from './areas/sidebar/pt-BR';
import { en as sidebarEn } from './areas/sidebar/en';
import { ptBR as tabsPtBR } from './areas/tabs/pt-BR';
import { en as tabsEn } from './areas/tabs/en';
import { ptBR as sessionBarPtBR } from './areas/sessionBar/pt-BR';
import { en as sessionBarEn } from './areas/sessionBar/en';
import { ptBR as statusBarPtBR } from './areas/statusBar/pt-BR';
import { en as statusBarEn } from './areas/statusBar/en';
import { ptBR as editorPtBR } from './areas/editor/pt-BR';
import { en as editorEn } from './areas/editor/en';
import { ptBR as resultsPtBR } from './areas/results/pt-BR';
import { en as resultsEn } from './areas/results/en';
import { ptBR as gridPtBR } from './areas/grid/pt-BR';
import { en as gridEn } from './areas/grid/en';
import { ptBR as dialogsPtBR } from './areas/dialogs/pt-BR';
import { en as dialogsEn } from './areas/dialogs/en';
import { ptBR as registryPtBR } from './areas/registry/pt-BR';
import { en as registryEn } from './areas/registry/en';
import { ptBR as agentsUiPtBR } from './areas/agentsUi/pt-BR';
import { en as agentsUiEn } from './areas/agentsUi/en';
import { ptBR as trailPtBR } from './areas/trail/pt-BR';
import { en as trailEn } from './areas/trail/en';
import { ptBR as actionsPtBR } from './areas/actions/pt-BR';
import { en as actionsEn } from './areas/actions/en';
import { ptBR as formatPtBR } from './areas/format/pt-BR';
import { en as formatEn } from './areas/format/en';
import { ptBR as mainSessionsPtBR } from './areas/mainSessions/pt-BR';
import { en as mainSessionsEn } from './areas/mainSessions/en';
import { ptBR as mainCatalogPtBR } from './areas/mainCatalog/pt-BR';
import { en as mainCatalogEn } from './areas/mainCatalog/en';
import { ptBR as mainScriptsPtBR } from './areas/mainScripts/pt-BR';
import { en as mainScriptsEn } from './areas/mainScripts/en';
import { ptBR as mainIpcPtBR } from './areas/mainIpc/pt-BR';
import { en as mainIpcEn } from './areas/mainIpc/en';
import { ptBR as mainMiscPtBR } from './areas/mainMisc/pt-BR';
import { en as mainMiscEn } from './areas/mainMisc/en';
import { ptBR as dialectPtBR } from './areas/dialect/pt-BR';
import { en as dialectEn } from './areas/dialect/en';
import { ptBR as textPtBR } from './areas/text/pt-BR';
import { en as textEn } from './areas/text/en';
import { ptBR as scriptsPtBR } from './areas/scripts/pt-BR';
import { en as scriptsEn } from './areas/scripts/en';
import { ptBR as modelPtBR } from './areas/model/pt-BR';
import { en as modelEn } from './areas/model/en';

export * from './core';

const ptBRMessages = {
  common: commonPtBR,
  menu: menuPtBR,
  about: aboutPtBR,
  native: nativePtBR,
  app: appPtBR,
  sidebar: sidebarPtBR,
  tabs: tabsPtBR,
  sessionBar: sessionBarPtBR,
  statusBar: statusBarPtBR,
  editor: editorPtBR,
  results: resultsPtBR,
  grid: gridPtBR,
  dialogs: dialogsPtBR,
  registry: registryPtBR,
  agentsUi: agentsUiPtBR,
  trail: trailPtBR,
  actions: actionsPtBR,
  format: formatPtBR,
  mainSessions: mainSessionsPtBR,
  mainCatalog: mainCatalogPtBR,
  mainScripts: mainScriptsPtBR,
  mainIpc: mainIpcPtBR,
  mainMisc: mainMiscPtBR,
  dialect: dialectPtBR,
  text: textPtBR,
  scripts: scriptsPtBR,
  model: modelPtBR,
};

/** Every message of one locale, grouped by area: `messages.menu.quit`, `messages.native.notification.pendingOne(…)`. */
export type Messages = Shape<typeof ptBRMessages>;

/** One area's messages, for code that receives only its part: `(msgs: AreaMessages<'mainSessions'>) => …`. */
export type AreaMessages<A extends keyof Messages> = Messages[A];

const enMessages: Messages = {
  common: commonEn,
  menu: menuEn,
  about: aboutEn,
  native: nativeEn,
  app: appEn,
  sidebar: sidebarEn,
  tabs: tabsEn,
  sessionBar: sessionBarEn,
  statusBar: statusBarEn,
  editor: editorEn,
  results: resultsEn,
  grid: gridEn,
  dialogs: dialogsEn,
  registry: registryEn,
  agentsUi: agentsUiEn,
  trail: trailEn,
  actions: actionsEn,
  format: formatEn,
  mainSessions: mainSessionsEn,
  mainCatalog: mainCatalogEn,
  mainScripts: mainScriptsEn,
  mainIpc: mainIpcEn,
  mainMisc: mainMiscEn,
  dialect: dialectEn,
  text: textEn,
  scripts: scriptsEn,
  model: modelEn,
};

const CATALOGS: Record<Locale, Messages> = { 'pt-BR': ptBRMessages, en: enMessages };

export function messagesFor(locale: Locale): Messages {
  return CATALOGS[locale];
}

// --- current locale (one per process) ---

let current: Locale = 'pt-BR';

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

/** Messages of the current locale. Call it where the text is produced (not at module load), so the locale is set. */
export function m(): Messages {
  return CATALOGS[current];
}

/** Number/date/plural formatting of the current locale. */
export function fmt(): Format {
  return createFormat(current);
}

/** Everything bound to one explicit locale, for code that must not depend on the process locale. */
export interface I18n {
  readonly locale: Locale;
  readonly messages: Messages;
  readonly format: Format;
  render(ref: MessageRef): string;
}

export function createI18n(locale: Locale): I18n {
  return {
    locale,
    messages: CATALOGS[locale],
    format: createFormat(locale),
    render: (ref) => renderRef(ref, locale),
  };
}

// --- message references ---

/**
 * A message rendered later, possibly twice (person in the app locale, agent in English). Plain data, safe to send
 * over IPC or store: `key` is `'<area>.<path>.<entry>'`, `params` goes to the entry's function.
 */
export interface MessageRef {
  key: string;
  params?: Record<string, string | number>;
}

type Entry = string | ((params: never) => string);

/** Every key that points at a catalog entry, e.g. `'native.notification.pendingOne'`. */
export type MessageKey = KeysOf<Messages>;

type KeysOf<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends Entry ? `${Prefix}${K}` : KeysOf<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

type EntryAt<T, K extends string> = K extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? EntryAt<T[Head], Rest>
    : never
  : K extends keyof T
    ? T[K]
    : never;

/** The params object an entry takes (`undefined` for plain text). */
export type ParamsOf<K extends MessageKey> = EntryAt<Messages, K> extends (params: infer P) => string ? P : undefined;

/** Builds a `MessageRef` with a checked key and checked params: `ref('native.notification.pendingMany', { count: 2 })`. */
export function ref<K extends MessageKey>(
  key: K,
  ...params: ParamsOf<K> extends undefined ? [] : [ParamsOf<K>]
): MessageRef {
  const p = params[0] as Record<string, string | number> | undefined;
  return p === undefined ? { key } : { key, params: p };
}

/** Renders a reference in a locale. An unknown key renders as the key itself (never throws). */
export function renderRef(reference: MessageRef, locale: Locale): string {
  let node: unknown = CATALOGS[locale];
  for (const part of reference.key.split('.')) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, part)) return reference.key;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node === 'string') return node;
  if (typeof node === 'function') return String((node as (p: unknown) => unknown)(reference.params ?? {}));
  return reference.key;
}

/** Renders a reference in the current locale (the person's). */
export function render(reference: MessageRef): string {
  return renderRef(reference, current);
}
