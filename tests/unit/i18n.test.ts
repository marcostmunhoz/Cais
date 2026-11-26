import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_LOCALE,
  createFormat,
  createI18n,
  fmt,
  getLocale,
  LOCALES,
  m,
  messagesFor,
  parseLocaleArg,
  ref,
  renderRef,
  resolveLocale,
  setLocale,
  type Shape,
} from '@shared/i18n';

/** Every entry of a catalog, as `[dotted key, value]`. */
function entries(node: unknown, prefix = ''): Array<[string, unknown]> {
  if (typeof node === 'string' || typeof node === 'function') return [[prefix, node]];
  expect(node, `${prefix} must be an object, a string or a function`).toBeTypeOf('object');
  const out: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out.push(...entries(value, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

/** Calls a catalog function with params that fit any entry: every property read returns a string or number. */
function renderWithDummies(fn: (params: unknown) => unknown): string {
  const params = new Proxy(
    {},
    {
      get: (_target, prop) => (prop === 'count' || prop === 'n' || prop === 'total' ? 2 : `x${String(prop)}`),
    },
  );
  return String(fn(params));
}

describe('resolveLocale', () => {
  it.each([
    [['en', 'pt-BR'], 'en'],
    [['pt-PT'], 'pt-BR'],
    [['fr', 'pt-BR'], 'pt-BR'],
    [[], 'en'],
    [['EN-us'], 'en'],
    [['pt'], 'pt-BR'],
    [['de-DE', 'fr'], 'en'],
    [['PT-br', 'en'], 'pt-BR'],
  ] as const)('%j gives %s', (preferred, expected) => {
    expect(resolveLocale(preferred)).toBe(expected);
  });
});

describe('parseLocaleArg (the preload)', () => {
  it('reads a known locale', () => {
    expect(parseLocaleArg(['electron', '--cais-locale=en'])).toBe('en');
    expect(parseLocaleArg(['--cais-locale=pt-BR'])).toBe('pt-BR');
  });

  it('refuses an unknown or missing locale and falls back to pt-BR', () => {
    expect(parseLocaleArg([])).toBe('pt-BR');
    expect(parseLocaleArg(['--cais-locale=fr'])).toBe('pt-BR');
    expect(parseLocaleArg(['--cais-locale=EN'])).toBe('pt-BR');
    expect(parseLocaleArg(['--cais-locale='])).toBe('pt-BR');
    expect(parseLocaleArg(['--cais-locale=en;rm'])).toBe('pt-BR');
    expect(parseLocaleArg(['--cais-locale=__proto__'])).toBe('pt-BR');
  });

  it('refuses conflicting values', () => {
    expect(parseLocaleArg(['--cais-locale=en', '--cais-locale=pt-BR'])).toBe('pt-BR');
    expect(parseLocaleArg(['--cais-locale=en', '--cais-locale=en'])).toBe('en');
  });

  it('takes an explicit fallback', () => {
    expect(parseLocaleArg(['--cais-locale=xx'], 'en')).toBe('en');
  });
});

describe('catalogs', () => {
  const pt = entries(messagesFor('pt-BR'));
  const en = entries(messagesFor('en'));

  it('have the same keys and the same kind of entry in both locales', () => {
    expect(en.map(([k]) => k)).toEqual(pt.map(([k]) => k));
    const kinds = (list: Array<[string, unknown]>) => list.map(([k, v]) => `${k}:${typeof v}`);
    expect(kinds(en)).toEqual(kinds(pt));
  });

  it('have every area in both locales, even the empty ones', () => {
    expect(Object.keys(messagesFor('en'))).toEqual(Object.keys(messagesFor('pt-BR')));
    expect(Object.keys(messagesFor('pt-BR'))).toEqual(
      expect.arrayContaining(['common', 'menu', 'native', 'mainMisc', 'agentsUi', 'dialect', 'model']),
    );
  });

  it('never use an exclamation mark', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of entries(messagesFor(locale))) {
        const text = typeof value === 'function' ? renderWithDummies(value as (p: unknown) => unknown) : String(value);
        expect(text, `${locale} ${key}`).not.toContain('!');
        expect(text.trim(), `${locale} ${key}`).not.toBe('');
      }
    }
  });

  it('name the registry screen the same way in its entry point and its title', () => {
    for (const locale of LOCALES) {
      expect(messagesFor(locale).sidebar.registerTitle, locale).toBe(messagesFor(locale).registry.dialogTitle);
    }
  });

  it('render the menu and notifications', () => {
    expect(messagesFor('pt-BR').menu.quit).toBe('Encerrar Cais');
    expect(messagesFor('en').menu.quit).toBe('Quit Cais');
    expect(messagesFor('pt-BR').native.notification.pendingMany({ count: 3 })).toBe('Pedidos de agente: 3 esperando você');
    expect(messagesFor('en').native.notification.pendingOne({ mode: 'write', environment: 'api/dev' })).toBe(
      'Agent request: write on api/dev',
    );
  });
});

describe('current locale', () => {
  afterEach(() => setLocale('pt-BR'));

  it('defaults to pt-BR and follows setLocale', () => {
    expect(getLocale()).toBe('pt-BR');
    expect(m().menu.edit).toBe('Editar');
    setLocale('en');
    expect(m().menu.edit).toBe('Edit');
    expect(fmt().formatNumber(1234.5)).toBe('1,234.5');
  });

  it('keeps agents in English', () => {
    expect(AGENT_LOCALE).toBe('en');
  });
});

describe('MessageRef', () => {
  it('renders a known key in both locales', () => {
    const r = ref('native.notification.awaitingCommit', { environment: 'api/pro' });
    expect(r).toEqual({ key: 'native.notification.awaitingCommit', params: { environment: 'api/pro' } });
    expect(renderRef(r, 'pt-BR')).toBe('Escrita de agente esperando seu Commit em api/pro');
    expect(renderRef(r, 'en')).toBe('Agent write waiting for your Commit on api/pro');
    expect(renderRef(ref('menu.about'), 'en')).toBe('About Cais');
    expect(createI18n('en').render(ref('menu.about'))).toBe('About Cais');
  });

  it('survives JSON (IPC, storage)', () => {
    const r = JSON.parse(JSON.stringify(ref('native.notification.pendingMany', { count: 2 }))) as { key: string };
    expect(renderRef(r, 'pt-BR')).toBe('Pedidos de agente: 2 esperando você');
  });

  it('returns the key for an unknown key, a partial path or an inherited property', () => {
    for (const key of ['nope.nothing', 'menu', 'menu.quit.more', 'native.notification', 'menu.constructor', '__proto__.x', '']) {
      expect(renderRef({ key }, 'en')).toBe(key);
    }
  });
});

describe('format', () => {
  it('formats numbers and plurals per locale', () => {
    const pt = createFormat('pt-BR');
    const en = createFormat('en');
    expect(pt.formatNumber(1234.5)).toBe('1.234,5');
    expect(en.formatNumber(1234.5)).toBe('1,234.5');
    const rows = { one: 'linha', other: 'linhas' };
    expect(pt.count(0, rows)).toBe('0 linhas');
    expect(pt.count(1, rows)).toBe('1 linha');
    expect(pt.count(1234, rows)).toBe('1.234 linhas');
    expect(en.count(1, { one: 'row', other: 'rows' })).toBe('1 row');
    expect(en.count(0, { one: 'row', other: 'rows' })).toBe('0 rows');
    expect(en.plural(3, { one: '# row', other: '# rows' })).toBe('3 rows');
  });

  it('formats dates and times per locale', () => {
    const at = new Date(2026, 10, 12, 14, 3, 27);
    expect(createFormat('pt-BR').formatDate(at)).toBe('12/11/2026');
    expect(createFormat('en').formatDate(at)).toBe('11/12/2026');
    expect(createFormat('pt-BR').formatTime(at)).toBe('14:03:27');
    expect(createFormat('pt-BR').formatDateTime(at)).toContain('12/11/2026');
  });
});

// Type-level checks: `npm run typecheck` fails if Shape stops catching a missing key, an extra key or a wrong
// parameter type in the `en` catalog.
const sample = { a: 'x', b: { c: (p: { n: number }) => `${p.n}` } };
export const typeChecks: Array<Shape<typeof sample>> = [
  { a: 'ok', b: { c: (p) => String(p.n) } },
  // @ts-expect-error missing key
  { a: 'y', b: {} },
  // @ts-expect-error extra key
  { a: 'y', b: { c: (p) => String(p.n), d: 'z' } },
  // @ts-expect-error wrong parameter type
  { a: 'y', b: { c: (p: { n: string }) => p.n } },
];
// @ts-expect-error unknown key
ref('menu.nothing');
// @ts-expect-error missing params
ref('native.notification.pendingMany');
