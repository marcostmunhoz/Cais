import { Plus, X } from 'lucide-react';
import { connectionTitle, connectionView } from '@shared/connection';
import { isScriptDirty } from '@shared/scripts';
import { shortcutText } from '@shared/shortcuts';
import { requestCloseTab, selectTab } from '../lib/actions';
import { m } from '../lib/i18n';
import { setState, useStore } from '../lib/store';

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const environments = useStore((s) => s.catalog.environments);
  const projects = useStore((s) => s.catalog.projects);
  const sessions = useStore((s) => s.sessions);
  const runs = useStore((s) => s.runs);
  const scripts = useStore((s) => s.scripts);
  const t = m().tabs;

  return (
    <div className="tabbar drag" role="tablist" aria-label={t.strip}>
      {tabs.map((tab) => {
        const env = environments.find((e) => e.id === tab.environmentId);
        const project = projects.find((p) => p.id === env?.projectId);
        const prod = !!env?.production;
        const tx = sessions[tab.id]?.transaction.open;
        const script = scripts.find((sc) => sc.id === tab.scriptId);
        const dirty = !!script && isScriptDirty(tab.sql, script);
        const where = env ? `${project?.name ?? ''} · ${env.name}` : t.removedEnvironment;
        const label = script ? script.name : where;
        const conn = connectionView(sessions[tab.id], runs[tab.id]);
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeTabId}
            tabIndex={0}
            className={`tab no-drag ${tab.id === activeTabId ? 'active' : ''} ${prod ? 'prod' : ''}`}
            onClick={() => selectTab(tab.id)}
            onKeyDown={(e) => e.key === 'Enter' && selectTab(tab.id)}
            onAuxClick={(e) => e.button === 1 && void requestCloseTab(tab.id)}
            title={script ? `${script.name} · ${where}` : label}
            data-testid="tab"
          >
            <span className="conn-dot" data-status={conn.status} data-testid="tab-status" title={connectionTitle(conn)} aria-hidden="true" />
            <span className="name">{label}</span>
            {script && <span className="tab-env">{env?.name}</span>}
            {dirty && (
              <span className="dirty-mark" data-testid="dirty-mark" title={t.unsaved}>
                •
              </span>
            )}
            {tx && <span className="tx-mark" title={t.transactionOpen} />}
            <button
              className="close"
              aria-label={t.close({ label })}
              onClick={(e) => {
                e.stopPropagation();
                void requestCloseTab(tab.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <button className="tab-add no-drag" aria-label={t.newTab} title={t.newTabTitle({ shortcut: shortcutText('newTab', window.cais.platform) })} onClick={() => setState({ picker: true })}>
        <Plus size={14} />
      </button>
    </div>
  );
}
