import { connectionView } from '@shared/connection';
import { shortcutText } from '@shared/shortcuts';
import { engineVersionLabel } from '@shared/dialects/registry';
import { EXTENDED_MAX_ROWS } from '@shared/model';
import { fetchMore } from '../lib/actions';
import { formatDuration } from '../lib/format';
import { m } from '../lib/i18n';
import { setState, useStore, type EstimateView } from '../lib/store';
import { useActiveResult } from './Results';

export function StatusBar({ tabId, platform }: { tabId: string; platform: string }) {
  const tab = useStore((s) => s.tabs.find((t) => t.id === tabId));
  const env = useStore((s) => s.catalog.environments.find((e) => e.id === tab?.environmentId));
  const session = useStore((s) => s.sessions[tabId]);
  const run = useStore((s) => s.runs[tabId]);
  const { result, resultIndex } = useActiveResult(tabId);
  const estimate = useStore((s) => s.estimates[tabId]);
  const estimateOn = useStore((s) => s.estimateAsYouType);
  const agents = useStore((s) => s.agents);
  const waiting = agents.pending.length + agents.awaitingCommit.length;
  const shortcut = shortcutText('run', platform);

  const conn = connectionView(session, run);
  const connected = conn.status === 'connected' || conn.status === 'running';

  const rows = result?.rows?.length ?? 0;
  const truncated = !!result?.truncated;
  const t = m().statusBar;

  return (
    <footer className="statusbar" data-testid="statusbar">
      <span className="item" data-testid="conn-state" data-status={conn.status} title={conn.status === 'error' ? conn.detail : undefined}>
        <span className="conn-dot" data-status={conn.status} />
        {conn.label}
      </span>
      {result && !result.error && (
        <span className="item" data-testid="result-summary">
          {result.columns
            ? t.rows({ n: rows })
            : t.affectedRows({ n: result.affectedRows ?? 0 })}{' '}
          · {formatDuration(result.durationMs)}
        </span>
      )}
      {result?.stats && !result.error && (result.stats.bytesProcessed !== undefined || result.stats.bytesBilled !== undefined) && (
        <span className="item" data-testid="result-bytes">
          {[
            result.stats.bytesProcessed !== undefined ? t.bytesProcessed({ bytes: result.stats.bytesProcessed }) : null,
            result.stats.bytesBilled !== undefined ? t.bytesBilled({ bytes: result.stats.bytesBilled }) : null,
            result.stats.cacheHit ? t.cacheHit : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      )}
      {estimateOn && connected && estimate && <EstimateItem estimate={estimate} limit={env && 'maxBytesBilled' in env ? env.maxBytesBilled : undefined} />}
      {truncated && (
        <span className="item warn" data-testid="truncated">
          {t.truncated({ n: rows })}
          {/* fetching more runs the statement again: only for a plain read (never CALL or EXECUTE) */}
          {rows < EXTENDED_MAX_ROWS && result.kind === 'read' && (
            <>
              {' · '}
              <button className="link-btn" disabled={run?.running} onClick={() => void fetchMore(tabId, resultIndex)}>
                {t.fetchMore({ n: EXTENDED_MAX_ROWS })}
              </button>
            </>
          )}
        </span>
      )}
      <span className="spacer" />
      {agents.enabled && (
        <button
          className={`agents-item ${waiting > 0 ? 'attn' : ''}`}
          data-testid="agents-status"
          onClick={() => setState({ agentPanel: true })}
          title={t.agentsTitle}
        >
          <span className="status-dot" />
          {t.agentsOn}{waiting > 0 ? ` · ${t.requests({ n: waiting })}` : ''}
        </button>
      )}
      {connected && session?.serverVersion && env && (
        <span className="item">{engineVersionLabel(env.engine, session.serverVersion)}</span>
      )}
      <span className="item">{t.runHint({ shortcut })}</span>
    </footer>
  );
}

/** "Estimar ao digitar": what the statement under the cursor would read, or what the dry run said about it. */
function EstimateItem({ estimate, limit }: { estimate: EstimateView; limit: number | undefined }) {
  const t = m().statusBar;
  const response = estimate.response;
  let state: 'pending' | 'ok' | 'over' | 'error' | 'refused';
  let text: string;
  let title: string | undefined;
  if (!response) {
    state = 'pending';
    text = t.estimating;
  } else if (response.state === 'ok') {
    const bytes = response.bytes ?? 0;
    const over = limit !== undefined && bytes > limit;
    state = over ? 'over' : 'ok';
    text = over ? t.estimateOverLimit({ bytes, limit }) : t.estimate({ bytes });
  } else if (response.state === 'error') {
    state = 'error';
    text = response.error.inStatement ? t.estimateError : t.estimateUnavailable;
    title = response.error.message;
  } else {
    state = 'refused';
    text = t.estimateRefused({ reason: response.message });
  }
  return (
    <span
      className={`item ${state === 'error' || state === 'over' ? 'warn' : ''}`}
      data-testid="estimate"
      data-state={state}
      aria-busy={estimate.pending}
      title={title}
      style={estimate.pending && response ? { opacity: 0.6 } : undefined}
    >
      {text}
    </span>
  );
}
