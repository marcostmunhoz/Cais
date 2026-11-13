import { join } from 'node:path';

export const PROTOCOL = 1;

export const UNAVAILABLE_MESSAGE = 'Peça para a pessoa abrir o Cais e ligar o acesso de agentes.';

/** The Cais user data folder: where `agent-endpoint.json` lives. */
export function userDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Cais');
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Cais');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Cais');
}

export type Discovery = { socket: string } | { unavailable: true; reason: string } | { protocolMismatch: true };

/** Finds the socket: `CAIS_SOCKET`, else the endpoint file the open Cais wrote. Pure: files and processes are injected. */
export function discoverEndpoint(opts: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  readFile(path: string): string | null;
  pidAlive(pid: number): boolean;
}): Discovery {
  if (opts.env.CAIS_SOCKET) return { socket: opts.env.CAIS_SOCKET };
  const path = join(userDataDir(opts.env, opts.platform, opts.home), 'agent-endpoint.json');
  const raw = opts.readFile(path);
  if (raw === null) return { unavailable: true, reason: 'no_endpoint' };
  let data: { socket?: unknown; pid?: unknown; protocol?: unknown };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    return { unavailable: true, reason: 'bad_endpoint' };
  }
  if (typeof data.socket !== 'string' || !data.socket) return { unavailable: true, reason: 'bad_endpoint' };
  if (data.protocol !== PROTOCOL) return { protocolMismatch: true };
  if (typeof data.pid === 'number' && !opts.pidAlive(data.pid)) return { unavailable: true, reason: 'stale_endpoint' };
  return { socket: data.socket };
}
