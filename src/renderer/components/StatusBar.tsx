import { connectionView } from '@shared/connection';
import { getDialect } from '@shared/dialects/registry';
import { EXTENDED_MAX_ROWS } from '@shared/model';
import { fetchMore } from '../lib/actions';
import { formatDuration } from '../lib/format';
import { m } from '../lib/i18n';
import { setState, useStore } from '../lib/store';
import { useActiveResult } from './Results';

export function StatusBar({ tabId, platform }: { tabId: string; platform: string }) {
  const tab = useStore((s) => s.tabs.find((t) => t.id === tabId));
  const env = useStore((s) => s.catalog.environments.find((e) => e.id === tab?.environmentId));
  const session = useStore((s) => s.sessions[tabId]);
  const run = useStore((s) => s.runs[tabId]);
  const { result, resultIndex } = useActiveResult(tabId);
  const agents = useStore((s) => s.agents);
  const waiting = agents.pending.length + agents.awaitingCommit.length;
  const mod = platform === 'darwin' ? 'Cmd' : 'Ctrl';

  const conn = connectionView(session, run);
  const connected = conn.status === 'connected' || conn.status === 'running';

  const rows = result?.rows?.length ?? 0;
  const truncated = !!result?.truncated;
  const engineName = env ? getDialect(env.engine).displayName : '';
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
      {connected && session?.serverVersion && (
        <span className="item">
          {engineName} {session.serverVersion}
        </span>
      )}
      <span className="item">{t.runHint({ mod })}</span>
    </footer>
  );
}
