import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createI18n, m, setLocale } from '@shared/i18n';
import { connectionView } from '@shared/connection';
import { duplicateName, formatAgo, lastRunText, sortByRecency } from '@shared/scripts';
import type { Environment } from '@shared/model';
import type { SessionState } from '@shared/results';

// The renderer's format helpers read the locale through `lib/i18n`, which reads `window.cais` at load:
// give it a minimal window, then import. The path is not a literal so the node typecheck (no DOM types)
// does not follow it into renderer code.
interface RendererFormat {
  nf: { format(n: number): string };
  formatCount(n: number): string;
  plural(n: number, one: string, many: string): string;
  formatDuration(ms: number): string;
}
const RENDERER_FORMAT = '../../src/renderer/lib/format';
let format: RendererFormat;
beforeAll(async () => {
  vi.stubGlobal('window', { cais: { locale: 'pt-BR' } });
  vi.stubGlobal('document', { documentElement: {} });
  format = (await import(/* @vite-ignore */ RENDERER_FORMAT)) as RendererFormat;
  setLocale('pt-BR');
});

afterEach(() => setLocale('pt-BR'));

const envs = [{ id: 'pro', name: 'pro' }] as unknown as Environment[];
const now = Date.UTC(2026, 10, 12, 12);

describe('shared script helpers follow the app locale', () => {
  it('pt-BR keeps the current wording', () => {
    expect(formatAgo(now - 30_000, now)).toBe('agora há pouco');
    expect(formatAgo(now - 60_000, now)).toBe('há 1 minuto');
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe('há 3 horas');
    expect(lastRunText({ lastRun: { environmentId: 'pro', at: now - 2 * 86_400_000 } }, envs, now)).toBe('rodou em pro há 2 dias');
    expect(lastRunText({ lastRun: { environmentId: 'gone', at: now - 86_400_000 } }, envs, now)).toBe('rodou em ambiente removido há 1 dia');
    expect(lastRunText({}, envs, now)).toBe('ainda não rodou');
  });

  it('en renders every part in English', () => {
    setLocale('en');
    expect(formatAgo(now - 30_000, now)).toBe('just now');
    expect(formatAgo(now - 60_000, now)).toBe('1 minute ago');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(lastRunText({ lastRun: { environmentId: 'pro', at: now - 2 * 86_400_000 } }, envs, now)).toBe('ran on pro 2 days ago');
    expect(lastRunText({ lastRun: { environmentId: 'gone', at: now - 3_600_000 } }, envs, now)).toBe('ran on removed environment 1 hour ago');
    expect(lastRunText({}, envs, now)).toBe('not run yet');
    expect(duplicateName('Report', () => false)).toBe('Report (copy)');
  });

  it('sorting by recency keeps names stable in both locales', () => {
    const list = [
      { name: 'b', updatedAt: 1 },
      { name: 'a', updatedAt: 1 },
      { name: 'c', updatedAt: 2 },
    ];
    expect(sortByRecency(list).map((s) => s.name)).toEqual(['c', 'a', 'b']);
    setLocale('en');
    expect(sortByRecency(list).map((s) => s.name)).toEqual(['c', 'a', 'b']);
  });
});

describe('connection view labels', () => {
  const session = (patch: Partial<SessionState>): SessionState =>
    ({ tabId: 't', environmentId: 'e', status: 'idle', mode: 'autocommit', database: null, transaction: { open: false, statements: 0 }, ...patch }) as SessionState;

  it('en labels and blocked reasons', () => {
    setLocale('en');
    expect(connectionView(session({})).label).toBe('Connected');
    expect(connectionView(session({ status: 'disconnected', disconnectReason: 'idle' })).label).toBe('Disconnected after inactivity');
    expect(connectionView(session({ transaction: { open: true, statements: 1 } })).disconnectBlocked).toBe('Commit or roll back first');
  });
});

describe('renderer format helpers', () => {
  it('pt-BR numbers and plurals stay as before', () => {
    expect(format.formatCount(1234)).toBe('1.234');
    expect(format.plural(1, 'linha', 'linhas')).toBe('1 linha');
    expect(format.plural(0, 'linha', 'linhas')).toBe('0 linhas');
    expect(format.plural(2500, 'linha', 'linhas')).toBe('2.500 linhas');
    expect(format.formatDuration(1500)).toBe('1,5 s');
    expect(format.nf.format(1000)).toBe('1.000');
  });

  it('en uses English separators', () => {
    setLocale('en');
    expect(format.formatCount(1234)).toBe('1,234');
    expect(format.plural(2500, 'row', 'rows')).toBe('2,500 rows');
    expect(format.formatDuration(1500)).toBe('1.5 s');
    expect(format.formatDuration(250)).toBe('250 ms');
  });
});

describe('renderer catalog areas', () => {
  const pt = createI18n('pt-BR').messages;
  const en = createI18n('en').messages;

  it('pt-BR keeps the texts the e2e selectors use', () => {
    expect(pt.sessionBar.mode['read-only']).toBe('Somente leitura');
    expect(pt.sessionBar.txOpen({ statements: 2, elapsed: '5s' })).toBe('Transação aberta · 2 comandos · 5s');
    expect(pt.sessionBar.modeFixedTitle({ engine: 'BigQuery', mode: 'read-only' })).toBe('BigQuery só lê nesta versão');
    expect(pt.sessionBar.modeFixedTitle({ engine: 'X', mode: 'transaction' })).toBe('X só aceita o modo Transação');
    expect(pt.sessionBar.modeFixedTitle({ engine: 'X', mode: 'autocommit' })).toBe('X só aceita o modo Auto-commit');
    expect(pt.statusBar.rows({ n: 1 })).toBe('1 linha');
    expect(pt.statusBar.truncated({ n: 1000 })).toBe('Truncado em 1.000 linhas');
    expect(pt.results.label.rows({ n: 1, verb: 'SELECT', rows: 0 })).toBe('1 · SELECT · 0 linhas');
    expect(pt.results.noStatement).toBe('Nenhum comando sob o cursor.');
    expect(pt.actions.implicitCommit.body({ engine: 'MySQL' })).toContain('O MySQL confirma a transação aberta');
  });

  it('en renders the same entries in English', () => {
    expect(en.sessionBar.mode['read-only']).toBe('Read-only');
    expect(en.sessionBar.txOpen({ statements: 1, elapsed: '5s' })).toBe('Transaction open · 1 statement · 5s');
    expect(en.sessionBar.modeFixedTitle({ engine: 'BigQuery', mode: 'read-only' })).toBe('BigQuery is read-only in this version');
    expect(en.sessionBar.modeFixedTitle({ engine: 'X', mode: 'transaction' })).toBe('X only accepts Transaction mode');
    expect(en.sessionBar.modeFixedTitle({ engine: 'X', mode: 'autocommit' })).toBe('X only accepts Auto-commit mode');
    expect(en.statusBar.affectedRows({ n: 3 })).toBe('3 rows affected');
    expect(en.statusBar.runHint({ shortcut: 'Ctrl+Enter' })).toBe('Ctrl+Enter runs the statement under the cursor');
    expect(en.results.label.error({ n: 2, verb: 'UPDATE' })).toBe('2 · UPDATE · error');
    expect(en.results.bytesPartial({ length: 4096, shown: 64 })).toBe('(4,096 bytes, showing the first 64)');
    expect(en.tabs.close({ label: 'api · dev' })).toBe('Close tab api · dev');
    expect(en.actions.productionAutocommit.body({ environment: 'pro' })).toContain('with no Rollback');
  });

  it('m() follows the current locale for the renderer areas', () => {
    expect(m().app.noTabs.title).toBe('Nenhuma aba aberta');
    setLocale('en');
    expect(m().app.noTabs.title).toBe('No open tabs');
    expect(m().sidebar.trail).toBe('Trail');
    expect(m().editor.codemirror.controlCharacter).toBe('Control character');
  });
});
