// Which engines have a syntax check in the editor, and the worker that runs it. The check comes from a grammar bundled
// with the app (the worker is a separate file the page loads on the first statement), never from the server.
import { capabilitiesOf } from '@shared/engines';
import type { Engine } from '@shared/model';
import { createSyntaxCheck, type SyntaxCheck, type SyntaxWorkerLike } from './client';

/** The worker of each engine that has a grammar (the engine's `syntaxCheck` capability says which do). */
const WORKERS: Partial<Record<Engine, () => SyntaxWorkerLike>> = {
  mysql: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as SyntaxWorkerLike,
};

const checks: Partial<Record<Engine, SyntaxCheck>> = {};

/** The engine's syntax check, or null when it has none (its errors come from the server). */
export function syntaxCheckFor(engine: Engine): SyntaxCheck | null {
  const make = WORKERS[engine];
  if (!capabilitiesOf(engine).syntaxCheck || !make) return null;
  return (checks[engine] ??= createSyntaxCheck(make));
}
