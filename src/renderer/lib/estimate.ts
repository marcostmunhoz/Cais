// "Estimate while typing": the dry run of the statement under the cursor, for engines that answer one (BigQuery).
// The renderer decides when to ask (after a pause, see estimateLint.ts) and remembers answers; main decides what may
// leave the app, so a text it refuses never reaches the server whatever this file asks.

import { capabilitiesOf } from '@shared/engines';
import type { EstimateResponse } from '@shared/ipc';
import { getState, setState, type EstimateView } from './store';

export type Settled = Extract<EstimateResponse, { state: 'ok' | 'error' | 'refused' }>;

/** How long an answer is trusted: tables and views change, and a name that did not exist a minute ago may now. */
export const ESTIMATE_TTL_MS = 2 * 60 * 1000;
const CACHE_MAX = 200;

const cache = new Map<string, { at: number; response: Settled }>();
/** The newest request of each tab: an answer that is not its tab's newest is dropped. */
const newest = new Map<string, number>();
let sequence = 0;

/** Forgets every answer and drops the ones still in flight (the switch went off; tests). */
export function resetEstimates(): void {
  cache.clear();
  newest.clear(); // the sequence keeps counting, so an answer already in flight never matches a newer request
}

/**
 * Forgets what was remembered for one environment: its connection came back, or its schema was read again, so
 * what the server said before may no longer hold. (An environment edit needs no call: its settings are in the key.)
 */
export function forgetEstimates(environmentId: string): void {
  const prefix = `${environmentId}\u0000`;
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
}

/** The switch is on, the engine answers dry runs and the tab is connected: only then is anything asked. */
export function estimateAvailable(tabId: string): boolean {
  const s = getState();
  if (!s.estimateAsYouType) return false;
  const tab = s.tabs.find((t) => t.id === tabId);
  const env = s.catalog.environments.find((e) => e.id === tab?.environmentId);
  const session = s.sessions[tabId];
  return !!env && capabilitiesOf(env.engine).dryRun === true && (session?.status === 'idle' || session?.status === 'running');
}

export function clearEstimate(tabId: string): void {
  newest.delete(tabId);
  if (getState().estimates[tabId]) {
    setState((s) => {
      const { [tabId]: _gone, ...estimates } = s.estimates;
      return { estimates };
    });
  }
}

function show(tabId: string, view: EstimateView): void {
  setState((s) => ({ estimates: { ...s.estimates, [tabId]: view } }));
}

/** Same environment (as it is configured now), dataset and text: the same question. */
function keyOf(tabId: string, text: string): string | null {
  const s = getState();
  const tab = s.tabs.find((t) => t.id === tabId);
  if (!tab) return null;
  const env = s.catalog.environments.find((e) => e.id === tab.environmentId);
  return [tab.environmentId, JSON.stringify(env ?? null), s.sessions[tabId]?.database ?? '', text].join('\u0000');
}

/** Only what the server said about the text is remembered: a failure on the way to it (network, permission, quota) may pass. */
function worthRemembering(answer: Settled): boolean {
  return answer.state !== 'error' || answer.error.inStatement === true;
}

/**
 * Asks (or remembers) what one statement would read, and shows it in the tab's status bar. `null`: nothing was
 * learned (switch off, not connected, nothing to ask, a newer request took over, or the call failed).
 */
export async function estimateStatement(tabId: string, text: string): Promise<Settled | null> {
  const key = keyOf(tabId, text);
  if (!key || !estimateAvailable(tabId)) {
    clearEstimate(tabId);
    return null;
  }
  const mine = ++sequence;
  newest.set(tabId, mine);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ESTIMATE_TTL_MS) {
    show(tabId, { text, pending: false, response: hit.response });
    return hit.response;
  }
  // the last answer stays on show, dimmed (pending), while this text is asked about
  const previous = getState().estimates[tabId]?.response;
  show(tabId, { text, pending: true, ...(previous ? { response: previous } : {}) });
  let answer: EstimateResponse;
  try {
    answer = await window.cais.session.estimate(tabId, text);
  } catch {
    answer = { state: 'skipped', reason: 'cancelled' };
  }
  if (newest.get(tabId) !== mine) return null;
  if (answer.state === 'skipped') {
    // skipped ('cancelled' also stands for a failed call): nothing was learned about this text, and an answer is never
    // shown under a text it was not computed for, so there is nothing to show
    clearEstimate(tabId);
    return null;
  }
  if (worthRemembering(answer)) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), response: answer });
  }
  show(tabId, { text, pending: false, response: answer });
  return answer;
}
