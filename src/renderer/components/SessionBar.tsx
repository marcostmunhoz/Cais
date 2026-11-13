import { useEffect, useState } from 'react';
import { AlertTriangle, Clock, Play, PlugZap, Save, Square, Unplug } from 'lucide-react';
import { connectionView } from '@shared/connection';
import { getDialect } from '@shared/dialects/registry';
import type { SessionMode } from '@shared/model';
import { isScriptDirty } from '@shared/scripts';
import { shortcutText } from '@shared/shortcuts';
import {
  cancelTab,
  changeMode,
  chooseDatabase,
  commitTab,
  connectTab,
  disconnectTab,
  effectiveMode,
  rollbackTab,
  runTab,
  saveTab,
} from '../lib/actions';
import { formatElapsed } from '../lib/format';
import { m } from '../lib/i18n';
import { useStore } from '../lib/store';

const MODES: SessionMode[] = ['read-only', 'transaction', 'autocommit'];

export function SessionBar({ tabId, platform }: { tabId: string; platform: string }) {
  const tab = useStore((s) => s.tabs.find((t) => t.id === tabId));
  const env = useStore((s) => s.catalog.environments.find((e) => e.id === tab?.environmentId));
  const project = useStore((s) => s.catalog.projects.find((p) => p.id === env?.projectId));
  const session = useStore((s) => s.sessions[tabId]);
  const run = useStore((s) => s.runs[tabId]);
  const schema = useStore((s) => (env ? s.schemas[env.id] : undefined));
  const pending = useStore((s) => s.pendingModes[tabId]);
  void pending;
  const script = useStore((s) => s.scripts.find((sc) => sc.id === tab?.scriptId));

  if (!tab || !env) return null;
  const mode = effectiveMode(tabId);
  const connected = session?.status === 'idle' || session?.status === 'running';
  const busy = !!run?.running || !!run?.connecting;
  const database = connected ? session!.database : (tab.database ?? env.defaultDatabase ?? null);
  const databases = schema?.tree?.databases.map((d) => d.name) ?? [];
  const options = database && !databases.includes(database) ? [database, ...databases] : databases;
  const txOpen = !!session?.transaction.open;
  const t = m().sessionBar;
  const view = connectionView(session, run);
  const chipDetail = view.status === 'connected' && view.detail ? `${getDialect(env.engine).displayName} ${view.detail}` : view.detail;
  const dirty = !!script && isScriptDirty(tab.sql, script);

  return (
    <>
      <div className={`sessionbar ${env.production ? 'prod' : ''}`} data-testid="sessionbar">
        <span className="crumb">{project?.name} ›</span>
        <span>{env.name}</span>
        {env.production && <span className="badge">{t.production}</span>}
        <span
          className="conn-chip"
          data-testid="conn-chip"
          data-status={view.status}
          title={chipDetail ? `${view.label} · ${chipDetail}` : view.label}
        >
          <span className="conn-dot" data-status={view.status} />
          <span className="conn-label">{view.label}</span>
          {/* an error's message is in the notice right below (and in the tooltip): the bar stays on one line */}
          {chipDetail && view.status !== 'error' && <span className="conn-detail">{chipDetail}</span>}
        </span>
        {view.action === 'connect' && (
          <button className="btn small" data-testid="btn-connect" onClick={() => void connectTab(tabId)}>
            <PlugZap size={12} /> {t.connect}
          </button>
        )}
        {view.action === 'reconnect' && (
          <button className="btn small" data-testid="btn-reconnect" onClick={() => void connectTab(tabId)}>
            <PlugZap size={12} /> {t.reconnect}
          </button>
        )}
        {view.action === 'disconnect' && (
          <button
            className="btn small ghost"
            data-testid="btn-disconnect"
            disabled={!!view.disconnectBlocked}
            title={view.disconnectBlocked ?? t.disconnectTitle}
            onClick={() => void disconnectTab(tabId)}
          >
            <Unplug size={12} /> {t.disconnect}
          </button>
        )}
        <select
          className="select"
          aria-label={t.currentDatabase}
          value={database ?? ''}
          disabled={busy || options.length === 0}
          onChange={(e) => void chooseDatabase(tabId, e.target.value)}
        >
          {!database && <option value="">{t.noDatabase}</option>}
          {options.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <div className="seg" role="radiogroup" aria-label={t.modeGroup}>
          {MODES.map((option) => (
            <button
              key={option}
              role="radio"
              aria-checked={mode === option}
              className={mode === option ? 'on' : ''}
              disabled={busy}
              onClick={() => void changeMode(tabId, option)}
            >
              {t.mode[option]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button
          className={`btn ${dirty ? 'accent' : ''}`}
          data-testid="btn-save"
          data-dirty={dirty ? 'true' : 'false'}
          aria-label={t.save}
          title={t.saveTitle({ save: shortcutText('save', platform), saveAs: shortcutText('saveAs', platform) })}
          onClick={() => void saveTab(tabId)}
        >
          <Save size={12} /> {t.save}
          {dirty && <span className="dirty-dot" aria-hidden="true">•</span>}
        </button>
        {run?.running ? (
          <button className="btn danger" onClick={() => void cancelTab(tabId)} aria-label={t.cancel}>
            <Square size={12} fill="currentColor" /> {t.cancel} <kbd>{shortcutText('cancel', platform)}</kbd>
          </button>
        ) : (
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void runTab(tabId, 'current')}
            aria-label={t.run}
            data-testid="run"
          >
            <Play size={12} fill="currentColor" /> {t.run} <kbd>{shortcutText('run', platform)}</kbd>
          </button>
        )}
      </div>
      {txOpen && <TxBar tabId={tabId} />}
      {view.status === 'error' && (
        <div className="noticebar" role="alert" data-testid="conn-notice">
          <AlertTriangle size={14} />
          <span>{view.detail ?? t.connectionLost}</span>
          <span className="spacer" />
          <button className="btn small" data-testid="notice-reconnect" onClick={() => void connectTab(tabId)}>
            {t.reconnect}
          </button>
          <button className="btn small ghost" data-testid="notice-disconnect" onClick={() => void disconnectTab(tabId)}>
            {t.disconnect}
          </button>
        </div>
      )}
      {session?.notice && session.status !== 'error' && (
        <div className="noticebar info" role="status" data-testid="session-notice">
          <AlertTriangle size={14} />
          <span>{session.notice}</span>
        </div>
      )}
    </>
  );
}

function TxBar({ tabId }: { tabId: string }) {
  const session = useStore((s) => s.sessions[tabId]);
  const run = useStore((s) => s.runs[tabId]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!session) return null;
  const tx = session.transaction;
  const busy = !!run?.running;
  const t = m().sessionBar;
  return (
    <div className="txbar" data-testid="txbar" role="status">
      <Clock size={14} />
      <span>
        {t.txOpen({ statements: tx.statements, elapsed: formatElapsed(now - (tx.startedAt ?? now)) })}
      </span>
      <span className="spacer" />
      <button className="btn warn-outline small" disabled={busy} onClick={() => void rollbackTab(tabId)}>
        {t.rollback}
      </button>
      <button className="btn warn small" disabled={busy} onClick={() => void commitTab(tabId)}>
        {t.commit}
      </button>
    </div>
  );
}
