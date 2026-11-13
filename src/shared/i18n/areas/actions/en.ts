import type { Shape } from '../../core';
import type { ptBR } from './pt-BR';

/** Area "actions", English. */
export const en: Shape<typeof ptBR> = {
  scriptProjectHasNoEnvironments: 'The script’s project has no environments.',
  scriptSaved: 'Script saved.',
  deleteScript: {
    title: 'Delete script',
    body: (p) => `Delete the script ${p.name}? This cannot be undone.`,
    confirm: 'Delete',
  },
  implicitCommit: {
    title: 'This statement causes an implicit commit',
    body: (p) =>
      `${p.engine} commits the open transaction before running this statement. What was already changed cannot be undone with Rollback.`,
    confirm: 'Run anyway',
  },
  productionAutocommit: {
    title: 'Auto-commit on production',
    body: (p) => `In Auto-commit each statement is committed right away, with no Rollback. This environment (${p.environment}) is production.`,
    confirm: 'Use Auto-commit',
  },
  rollbackIncomplete: 'Rollback incomplete: non-transactional tables kept what was written to them.',
};
