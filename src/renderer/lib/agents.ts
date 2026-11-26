import type { AgentRequestView } from '@shared/agents';
import type { AppState } from './store';
import { m } from './i18n';

export type AgentModal = { kind: 'commit' | 'approve'; request: AgentRequestView; queued: number };

/** Dialogs that sit on top of the agent modals' turn: they wait until those close. */
export function otherDialogOpen(s: AppState): boolean {
  return !!(s.registry || s.picker || s.scriptPicker || s.scriptName || s.closeDirty || s.confirm || s.closeTx || s.quit || s.agentPanel || s.trailPanel || s.about);
}

/**
 * The modal to show now, one request at a time: an open agent transaction first (it has a clock),
 * then the oldest pending request. A request the person closed with Esc waits for "Review".
 */
export function currentAgentModal(s: AppState): AgentModal | null {
  if (otherDialogOpen(s)) return null;
  const visible = (r: AgentRequestView): boolean => !s.agentDismissed.includes(r.id) || s.agentFocus === r.id;
  const focus = [...s.agents.awaitingCommit, ...s.agents.pending].find((r) => r.id === s.agentFocus);
  const commit = focus?.status === 'awaiting_commit' ? focus : s.agents.awaitingCommit.find(visible);
  if (commit) return { kind: 'commit', request: commit, queued: s.agents.pending.length };
  const pending = focus?.status === 'pending_approval' ? focus : s.agents.pending.find(visible);
  if (pending) {
    const queued = s.agents.pending.filter((r) => r.id !== pending.id && visible(r)).length;
    return { kind: 'approve', request: pending, queued };
  }
  return null;
}

/**
 * A client name as recorded (trail lines, requests). The broker's own defaults ('agente', 'pessoa') are persisted
 * as is and read in the app locale here; any other name is the agent's own and shows unchanged.
 */
export function clientName(client: string | undefined): string {
  if (!client) return '?';
  const names: Record<string, string> = m().trail.client;
  return Object.hasOwn(names, client) ? names[client]! : client;
}
