import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, Bot, Clock, Eye } from 'lucide-react';
import type { AgentRequestStatus, AgentRequestView } from '@shared/agents';
import {
  approveAgent,
  commitAgent,
  dismissAgentModal,
  rejectAgent,
  reviewAgentRequest,
  revokeAgentGrant,
  rollbackAgent,
  setAgentAccess,
} from '../lib/actions';
import { clientName, currentAgentModal } from '../lib/agents';
import { plural } from '../lib/format';
import { getLocale, m } from '../lib/i18n';
import { getDialect } from '@shared/dialects/registry';
import { displaySql } from '@shared/text';
import { AGENT_LEVEL_LABEL, agentLevelOf } from '@shared/model';
import { setState, useStore } from '../lib/store';
import { SqlView } from './SqlView';
import { DialogHead, Modal } from './ui';

/** Labels come from the catalog when the text is drawn (app locale), never at module load. */
const t = () => m().agentsUi;

const STATUS_TONE: Partial<Record<AgentRequestStatus, 'warn' | 'bad' | 'good'>> = {
  pending_approval: 'warn',
  awaiting_commit: 'warn',
  running: 'warn',
  failed: 'bad',
  rejected: 'bad',
  expired: 'bad',
  rolled_back: 'bad',
  committed: 'good',
  succeeded: 'good',
};

const clock = (ms: number): string => new Date(ms).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });

function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Re-renders every second while something on screen counts down. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** Buttons that decide something stay disabled for a moment, so a stray key or click right after a modal appears cannot approve. */
function useArmed(key: string, ms = 600): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    const id = setTimeout(() => setArmed(true), ms);
    return () => clearTimeout(id);
  }, [key, ms]);
  return armed;
}

const kindLabel = (kind: string): string => (kind === 'read' ? t().kind.read : kind === 'write' ? t().kind.write : t().kind.other);

/**
 * Every command on its own row (number, kind, text) so nothing hides behind padding. When the list needs
 * scrolling, `onReachedEnd(false)` holds the approve button until the person has scrolled to the end.
 */
function StatementList({ request, onGate }: { request: AgentRequestView; onGate: (open: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const check = (): void => {
    const el = box.current;
    if (!el) return;
    const overflow = el.scrollHeight > el.clientHeight + 1;
    onGate(!overflow || el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
  };
  useLayoutEffect(check, [request.id]);
  useEffect(() => {
    // CodeMirror lays its rows out after mount: measure again
    const id = setTimeout(check, 50);
    return () => clearTimeout(id);
  }, [request.id]);
  return (
    <div className="stmt-list" ref={box} onScroll={check} data-testid="stmt-list" tabIndex={0} aria-label={t().modal.statements}>
      {request.statements.map((s, i) => (
        <div className="stmt" key={i} data-testid="stmt">
          <div className="stmt-head">
            <span className="stmt-n">#{i + 1}</span>
            <span className={`agent-pill ${s.kind === 'write' ? 'warn' : ''}`}>{kindLabel(s.kind)}</span>
          </div>
          <SqlView value={s.sql} label={t().modal.statement({ n: i + 1 })} environmentId={request.environmentId} />
        </div>
      ))}
    </div>
  );
}

function Meta({ request }: { request: AgentRequestView }) {
  const msg = t().modal;
  const engine = useStore((s) => s.catalog.environments.find((e) => e.id === request.environmentId)?.engine);
  const term = engine ? getDialect(engine).databaseTerm : 'database';
  return (
    <div className="agent-meta">
      <span className="k">{msg.environment}</span>
      <span className="v">
        {request.environmentLabel}
        {request.database ? msg[term]({ database: request.database }) : ''}
      </span>
      <span className="k">{msg.client}</span>
      <span className="v">
        {clientName(request.client)} <span className="muted">{msg.clientNote}</span>
      </span>
      {request.reason && (
        <>
          <span className="k">{msg.reason}</span>
          <span className="v" data-testid="agent-reason">
            {request.reason}
          </span>
        </>
      )}
    </div>
  );
}

function Alerts({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="agent-alerts" role="alert">
      {warnings.map((w) => (
        <span key={w} className="agent-alert">
          <AlertTriangle size={13} /> {w}
        </span>
      ))}
    </div>
  );
}

/** One request at a time: Recusar has the focus, Enter never approves, Esc leaves the request pending. */
function ApprovalModal({ request, queued }: { request: AgentRequestView; queued: number }) {
  const write = request.mode === 'write';
  const [share, setShare] = useState(true);
  const [grant, setGrant] = useState(false);
  const [why, setWhy] = useState('');
  const armed = useArmed(request.id);
  // the approve button also waits for the person to scroll a list that does not fit
  const [seenAll, setSeenAll] = useState(false);
  const Icon = write ? Bot : Eye;
  const msg = t().modal;
  const title = write ? msg.titleWrite : msg.titleRead;
  return (
    <Modal
      key={request.id}
      title={title}
      onClose={() => dismissAgentModal(request.id)}
      align="center"
      className={`agent-modal ${request.production ? 'prod' : ''}`}
    >
      <div className="agent-head">
        <Icon size={18} />
        <h2>{title}</h2>
        {queued > 0 && (
          <span className="queue" data-testid="agent-queue">
            {msg.queued({ count: queued })}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {request.production && <span className="badge">{msg.production}</span>}
      </div>
      <div className="dialog-body" style={{ overflow: 'auto' }}>
        {/* alerts first: they must be on screen while the approve button is enabled */}
        <Alerts warnings={request.warnings} />
        {request.approvalReason && (
          <div className="agent-note warn" data-testid="agent-approval-reason">
            {request.approvalReason}
          </div>
        )}
        <Meta request={request} />
        <StatementList request={request} onGate={setSeenAll} />
        <div className="agent-note">
          {plural(request.statements.length, msg.statementOne, msg.statementMany)}
          {!seenAll && msg.scrollToEnd}
        </div>
        {write && <div className="agent-note">{msg.writeNote}</div>}
        <div className="agent-checks">
          {!write && (
            <label className="check" title={share ? undefined : msg.grantNeedsShare}>
              <input type="checkbox" checked={grant && share} disabled={!share} onChange={(e) => setGrant(e.target.checked)} />
              {msg.grantReads({ environment: request.environmentLabel })}
              {!share && <span className="muted">{msg.grantOnlyShared}</span>}
            </label>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={share}
              onChange={(e) => {
                setShare(e.target.checked);
                if (!e.target.checked) setGrant(false);
              }}
            />
            {msg.share}
          </label>
        </div>
        <input
          className="input"
          aria-label={msg.rejectReason}
          placeholder={msg.rejectReason}
          value={why}
          maxLength={300}
          onChange={(e) => setWhy(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.preventDefault();
          }}
        />
      </div>
      <div className="dialog-foot">
        <button className="btn" autoFocus onClick={() => void rejectAgent(request.id, why)}>
          {msg.reject}
        </button>
        <button
          className={`btn ${write ? 'warn' : 'primary'}`}
          disabled={!armed || !seenAll}
          onClick={() => void approveAgent(request.id, { shareResult: share, ...(grant && share ? { grantReads: true } : {}) })}
        >
          {write ? msg.runInTransaction : msg.approve}
        </button>
      </div>
    </Modal>
  );
}

/** Second decision of a write: what changed, a clock, Rollback (focused) and Commit. */
function CommitModal({ request }: { request: AgentRequestView }) {
  const now = useNow(true);
  const armed = useArmed(request.id);
  const left = (request.rollbackAt ?? now) - now;
  const msg = t().commitModal;
  return (
    <Modal
      key={request.id}
      title={msg.title}
      onClose={() => dismissAgentModal(request.id)}
      align="center"
      className={`agent-modal ${request.production ? 'prod' : ''}`}
    >
      <div className="agent-head">
        <Clock size={18} />
        <h2>{msg.title}</h2>
        <span className="agent-clock" data-testid="agent-clock">
          {msg.rollbackIn({ time: mmss(left) })}
        </span>
        {request.production && <span className="badge">{t().modal.production}</span>}
      </div>
      <div className="dialog-body" style={{ overflow: 'auto' }}>
        <Alerts warnings={request.warnings} />
        {request.commitReason && (
          <div className="agent-note warn" data-testid="agent-commit-reason">
            {msg.autoCommitStopped({ reason: request.commitReason })}
          </div>
        )}
        <Meta request={request} />
        <div className="agent-summary" data-testid="agent-summary">
          {request.statements.map((s, i) => (
            <div className="row" key={i}>
              {/* the whole command, with the same markers as the approval modal */}
              <div className="sql">
                <SqlView value={s.sql} label={t().modal.statement({ n: i + 1 })} environmentId={request.environmentId} />
              </div>
              <span>
                {s.error
                  ? msg.error
                  : s.affectedRows !== undefined
                    ? plural(s.affectedRows, msg.affectedOne, msg.affectedMany)
                    : s.rows !== undefined
                      ? plural(s.rows, msg.rowOne, msg.rowMany)
                      : msg.noRows}
              </span>
            </div>
          ))}
        </div>
        <div className="agent-note">{msg.note}</div>
      </div>
      <div className="dialog-foot">
        <button className="btn" autoFocus onClick={() => void rollbackAgent(request.id)}>
          {msg.rollback}
        </button>
        <button className="btn warn" disabled={!armed} onClick={() => void commitAgent(request.id)}>
          {msg.commit}
        </button>
      </div>
    </Modal>
  );
}

export function AgentModals() {
  // separate selectors: each returns something stable (a snapshot object or a primitive), never a fresh wrapper
  const request = useStore((s) => currentAgentModal(s)?.request);
  const kind = useStore((s) => currentAgentModal(s)?.kind);
  const queued = useStore((s) => currentAgentModal(s)?.queued ?? 0);
  if (!request) return null;
  // keyed by request: armed, sharing choice, grant box and scroll state never carry over to the next request
  return kind === 'commit' ? (
    <CommitModal key={request.id} request={request} />
  ) : (
    <ApprovalModal key={request.id} request={request} queued={queued} />
  );
}

function RequestRow({ request, onOpen, open }: { request: AgentRequestView; onOpen: () => void; open: boolean }) {
  const tone = STATUS_TONE[request.status];
  const msg = t().detail;
  return (
    <>
      <div className="agent-row" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()} data-testid="agent-recent">
        <span className="when">{clock(request.createdAt)}</span>
        <span className="where">{request.environmentLabel}</span>
        <span className="agent-pill">{kindLabel(request.mode)}</span>
        <span className={`agent-pill ${tone ?? ''}`}>
          {t().status[request.status]}
          {request.status === 'committed' && request.secondDecidedBy === 'policy' ? msg.automatic : ''}
        </span>
        <span className="first">{displaySql(request.sql).trim().split('\n')[0]}</span>
      </div>
      {open && (
        <div className="agent-detail" data-testid="agent-detail">
          <div className="agent-meta">
            <span className="k">{t().modal.client}</span>
            <span className="v">{clientName(request.client)}</span>
            {request.reason && (
              <>
                <span className="k">{t().modal.reason}</span>
                <span className="v">{request.reason}</span>
              </>
            )}
            {request.decidedBy && (
              <>
                <span className="k">{msg.decidedBy}</span>
                <span className="v">
                  {t().decidedBy[request.decidedBy]}
                  {request.decidedAt ? msg.at({ time: clock(request.decidedAt) }) : ''}
                </span>
              </>
            )}
            {request.secondDecidedBy && (
              <>
                <span className="k">{request.status === 'committed' ? msg.commitBy : msg.secondDecision}</span>
                <span className="v">{t().secondDecidedBy[request.secondDecidedBy]}</span>
              </>
            )}
            {request.mode === 'read' && request.status !== 'rejected' && request.status !== 'expired' && request.shareResult === false && (
              <>
                <span className="k">{msg.result}</span>
                <span className="v">{msg.withheld}</span>
              </>
            )}
            {request.rejectionReason && (
              <>
                <span className="k">{msg.rejection}</span>
                <span className="v">{request.rejectionReason}</span>
              </>
            )}
            {request.rollbackIncomplete && (
              <>
                <span className="k">{msg.attention}</span>
                <span className="v" role="alert">{msg.rollbackIncomplete}</span>
              </>
            )}
            {request.rollbackReason && (
              <>
                <span className="k">{msg.rollbackBy}</span>
                <span className="v">{t().rollbackReason[request.rollbackReason]}</span>
              </>
            )}
            {request.errorMessage && (
              <>
                <span className="k">{msg.error}</span>
                <span className="v">{request.errorMessage}</span>
              </>
            )}
          </div>
          <SqlView value={request.sql} label={msg.sql} environmentId={request.environmentId} />
        </div>
      )}
    </>
  );
}

export function AgentsPanel() {
  const open = useStore((s) => s.agentPanel);
  const agents = useStore((s) => s.agents);
  const environments = useStore((s) => s.catalog.environments);
  const projects = useStore((s) => s.catalog.projects);
  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? '?';
  const [detail, setDetail] = useState<string | null>(null);
  const hasClock = agents.grants.length > 0 || agents.pending.length > 0;
  const now = useNow(open && hasClock);
  if (!open) return null;
  const close = () => setState({ agentPanel: false });
  const waiting = [...agents.awaitingCommit, ...agents.pending];
  const msg = t().panel;
  return (
    <Modal title={msg.title} onClose={close} className="agents-panel">
      <DialogHead
        title={msg.title}
        right={
          <button className="btn small" onClick={close}>
            {msg.close}
          </button>
        }
      />
      <div className="dialog-body">
        <div className="switch">
          <button
            role="switch"
            aria-checked={agents.enabled}
            aria-label={msg.access}
            data-testid="agent-switch"
            onClick={() => void setAgentAccess(!agents.enabled)}
          />
          <div>
            <div className="title">{msg.access}</div>
            <div className="phrase">{msg.phrase}</div>
            {agents.startError && (
              <div className="form-error" role="alert" style={{ marginTop: 6 }}>
                {agents.startError}
              </div>
            )}
          </div>
        </div>

        <div className="agents-section">
          <h3>{msg.pending}</h3>
          {waiting.length === 0 && <div className="muted">{msg.noPending}</div>}
          {waiting.map((r) => (
            <div className="agent-row" key={r.id} data-testid="agent-pending">
              <span className="when">{clock(r.createdAt)}</span>
              <span className="where">{r.environmentLabel}</span>
              <span className="agent-pill">{kindLabel(r.mode)}</span>
              <span className="first">{displaySql(r.sql).trim().split('\n')[0]}</span>
              {r.status === 'pending_approval' && r.expiresAt && <span className="muted">{msg.expiresIn({ time: mmss(r.expiresAt - now) })}</span>}
              {r.status === 'awaiting_commit' && r.rollbackAt && (
                <span className="agent-clock">{t().commitModal.rollbackIn({ time: mmss(r.rollbackAt - now) })}</span>
              )}
              <button className="btn small" onClick={() => reviewAgentRequest(r.id)}>
                {msg.review}
              </button>
            </div>
          ))}
        </div>

        <div className="agents-section">
          <h3>{msg.grants}</h3>
          {agents.grants.length === 0 && <div className="muted">{msg.noGrants}</div>}
          {agents.grants.map((g) => (
            <div className="agent-row" key={g.environmentId} data-testid="agent-grant">
              <span className="where" style={{ flex: 1 }}>
                {msg.grantReads({ environment: g.environmentLabel })}
              </span>
              <span className="muted">{msg.remaining({ time: mmss(g.expiresAt - now) })}</span>
              <button className="btn small" onClick={() => void revokeAgentGrant(g.environmentId)}>
                {msg.revoke}
              </button>
            </div>
          ))}
        </div>

        <div className="agents-section">
          <h3>{msg.byEnvironment}</h3>
          {environments.length === 0 && <div className="muted">{msg.noEnvironments}</div>}
          {environments.map((e) => (
            <div className="agent-row" key={e.id} data-testid="agent-level-row">
              <span className="where" style={{ flex: 1 }}>
                {projectName(e.projectId)} · {e.name}
                {e.production && <span className="badge" style={{ marginLeft: 6 }}>{t().modal.production}</span>}
              </span>
              <span className={`agent-pill ${agentLevelOf(e) === 'free-reads-writes' || (e.production && agentLevelOf(e) !== 'approve-all') ? 'warn' : ''}`}>{AGENT_LEVEL_LABEL[agentLevelOf(e)]}</span>
            </div>
          ))}
        </div>

        <div className="agents-section">
          <h3>{msg.recent}</h3>
          {agents.recent.length === 0 && <div className="muted">{msg.noRecent}</div>}
          {agents.recent.map((r) => (
            <RequestRow key={r.id} request={r} open={detail === r.id} onOpen={() => setDetail(detail === r.id ? null : r.id)} />
          ))}
        </div>
      </div>
    </Modal>
  );
}
