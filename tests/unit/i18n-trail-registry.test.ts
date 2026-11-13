import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { messagesFor, setLocale } from '@shared/i18n';
import { AGENT_LEVEL_LABEL, AGENT_LEVELS } from '@shared/model';
import { AUTO_COMMIT_MAX_ROWS } from '@shared/agents';
import { Trail } from '@main/trail';
import { FakeClock } from '../support/agent-fakes';

afterEach(() => setLocale('pt-BR'));

describe('AGENT_LEVEL_LABEL follows the locale where it is read', () => {
  it('keeps the pt-BR names and its keys', () => {
    expect(Object.keys(AGENT_LEVEL_LABEL)).toEqual([...AGENT_LEVELS]);
    expect(AGENT_LEVEL_LABEL['approve-all']).toBe('Tudo com aprovação');
    expect(AGENT_LEVEL_LABEL['free-reads']).toBe('Leitura liberada, escrita com aprovação');
    expect(AGENT_LEVEL_LABEL['free-reads-writes']).toBe('Leitura e escrita liberadas');
  });

  it('renders English after setLocale', () => {
    setLocale('en');
    expect(AGENT_LEVEL_LABEL['approve-all']).toBe('Everything needs approval');
    expect(AGENT_LEVEL_LABEL['free-reads-writes']).toBe('Reads and writes allowed');
  });
});

describe('trail, registry and dialogs catalogs', () => {
  const pt = messagesFor('pt-BR');
  const en = messagesFor('en');

  it('keep the pt-BR wording', () => {
    expect(pt.trail.counts.rows({ count: 1234 })).toBe('1.234 linhas');
    expect(pt.trail.counts.affected({ count: 1 })).toBe('1 afetada');
    expect(pt.trail.state.committed).toBe('commit feito');
    expect(pt.trail.detail.sqlCut({ count: 150000 })).toBe('cortado: 150.000 caracteres no original');
    expect(pt.registry.levelHint['free-reads-writes']({ count: AUTO_COMMIT_MAX_ROWS })).toContain(
      `afeta até ${AUTO_COMMIT_MAX_ROWS.toLocaleString('pt-BR')} linhas`,
    );
    expect(pt.registry.credential.usedBy({ count: 1 })).toBe('Usada em 1 ambiente');
    expect(pt.registry.credential.usedBy({ count: 3 })).toBe('Usada em 3 ambientes');
    expect(pt.dialogs.closeTransaction.body({ count: 1 })).toBe(
      '1 comando ainda não foi confirmado. Escolha o que fazer antes de fechar a aba. Rollback desfaz tudo.',
    );
    expect(pt.dialogs.quit.body({ count: 2 })).toBe(
      '2 abas têm transação aberta. Escolha o que fazer antes de sair. Rollback desfaz tudo.',
    );
  });

  it('render English', () => {
    expect(en.trail.counts.rows({ count: 1234 })).toBe('1,234 rows');
    expect(en.trail.counts.rows({ count: 1 })).toBe('1 row');
    expect(en.trail.state.rolled_back).toBe('rolled back');
    expect(en.trail.mode['read-only']).toBe('Read-only');
    expect(en.trail.rollbackReason.access_off).toBe('agent access was turned off');
    expect(en.registry.levelHint['free-reads-writes']({ count: 1000 })).toContain('affects up to 1,000 rows');
    expect(en.registry.credential.usedBy({ count: 1 })).toBe('Used in 1 environment');
    expect(en.dialogs.closeTransaction.body({ count: 2 })).toBe(
      '2 statements are not committed yet. Choose what to do before closing the tab. Rollback undoes everything.',
    );
    expect(en.dialogs.quit.body({ count: 1 })).toBe(
      '1 tab has an open transaction. Choose what to do before quitting. Rollback undoes everything.',
    );
  });
});

describe('Trail.writeError follows the app locale', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function failingThenRecovered(): Trail {
    dir = mkdtempSync(join(tmpdir(), 'cais-i18n-trail-'));
    const clock = new FakeClock();
    clock.now = new Date(2026, 10, 12, 14, 3, 27).getTime();
    const trail = new Trail(join(dir, 'trail'), { now: () => clock.now, scheduler: clock, newId: () => 't1', mac: () => undefined });
    writeFileSync(join(dir, 'trail'), 'not a folder');
    const line = { actor: 'person' as const, environment: 'api/dev', production: false, mode: 'autocommit', sql: 'SELECT 1', state: 'ok' };
    expect(trail.append(line)).toBe(false);
    rmSync(join(dir, 'trail'));
    expect(trail.append(line)).toBe(true);
    return trail;
  }

  it('pt-BR', () => {
    expect(failingThenRecovered().list({ days: 1, limit: 5 }).writeError).toBe(
      'A trilha não pôde ser gravada em 12/11/2026, 14:03:27 (voltou a gravar depois).',
    );
  });

  it('en', () => {
    setLocale('en');
    expect(failingThenRecovered().list({ days: 1, limit: 5 }).writeError).toBe(
      'The trail could not be written at 11/12/2026, 02:03:27 PM (it has been writing again since).',
    );
  });
});
