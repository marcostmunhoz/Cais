// What each engine can do, for both sides: the renderer needs it too and cannot see the driver. Pure TypeScript.

import type { Engine, Environment, SessionMode } from './model';

export interface EngineCapabilities {
  /** The session modes the engine accepts, in the order the mode picker lists them. */
  modes: readonly SessionMode[];
  /** The result grid may edit rows (UPDATE by primary key). */
  gridEdit: boolean;
}

const CAPABILITIES: Record<Engine, EngineCapabilities> = {
  mysql: { modes: ['read-only', 'transaction', 'autocommit'], gridEdit: true },
};

export function capabilitiesOf(engine: Engine): EngineCapabilities {
  return CAPABILITIES[engine];
}

/**
 * The mode a new tab opens in: read-only in production, Auto-commit elsewhere when the engine takes it,
 * otherwise the first mode the engine accepts.
 */
export function initialModeFor(caps: EngineCapabilities, production: boolean): SessionMode {
  const { modes } = caps;
  if (production && modes.includes('read-only')) return 'read-only';
  if (!production && modes.includes('autocommit')) return 'autocommit';
  return modes[0] ?? 'read-only';
}

/**
 * What identifies where an environment connects to. Two environments with the same key reach the same server
 * with the same credential. A new engine adds its own fields here, and every comparison follows.
 */
export function connectionTargetKey(env: Pick<Environment, 'host' | 'port' | 'credentialId'>): string {
  return JSON.stringify([env.host, env.port, env.credentialId]);
}

export function sameTarget(a: Pick<Environment, 'host' | 'port' | 'credentialId'>, b: Pick<Environment, 'host' | 'port' | 'credentialId'>): boolean {
  return connectionTargetKey(a) === connectionTargetKey(b);
}
