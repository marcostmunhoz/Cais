import { useEffect, useRef, useState } from 'react';
import { cancelTab, init, requestCloseTab, runTab, saveTab } from './lib/actions';
import { currentAgentModal } from './lib/agents';
import { m } from './lib/i18n';
import { setState, useStore, getState } from './lib/store';
import {
  CloseDirtyDialog,
  CloseTransactionDialog,
  ConfirmDialog,
  BytesConfirmDialog,
  QuitDialog,
  ProjectNameDialog,
  ScriptNameDialog,
  ScriptPicker,
  TabPicker,
  Toast,
} from './components/Dialogs';
import { AgentModals, AgentsPanel } from './components/Agents';
import { Editor } from './components/Editor';
import { RegistryDialog } from './components/Registry';
import { Results } from './components/Results';
import { SessionBar } from './components/SessionBar';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TabBar } from './components/Tabs';
import { TrailPanel } from './components/Trail';
import { Splitter } from './components/ui';
import logoMark from '../../resources/logo-mark.png';

function anyDialogOpen(): boolean {
  const s = getState();
  return !!(s.registry || s.picker || s.scriptPicker || s.scriptName || s.projectName || s.closeDirty || s.confirm || s.bytesConfirm || s.closeTx || s.quit || s.agentPanel || s.trailPanel || currentAgentModal(s));
}

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const s = getState();
      const key = e.key.toLowerCase();
      const active = s.activeTabId;
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      // a value typed in a grid cell is confirmed before running again or closing, so it counts as a pending
      // edit and the discard question shows instead of losing it silently
      const commitCellEditor = () => {
        const target = e.target as HTMLElement | null;
        if (target?.matches?.('[data-testid="cell-editor"]')) target.blur();
      };
      if (key === '.' && active && !anyDialogOpen()) {
        handled();
        void cancelTab(active);
      } else if (key === 't' && s.catalog.environments.length > 0 && !anyDialogOpen()) {
        handled();
        setState({ picker: true });
      } else if (key === 'o' && s.catalog.environments.length > 0 && !anyDialogOpen()) {
        handled();
        setState({ scriptPicker: true });
      } else if (key === 's' && active && !anyDialogOpen()) {
        handled();
        void saveTab(active, e.shiftKey);
      } else if (key === 'w' && active && !anyDialogOpen()) {
        handled();
        commitCellEditor();
        void requestCloseTab(active);
      } else if (e.key === 'Enter' && active && !anyDialogOpen()) {
        handled();
        commitCellEditor();
        void runTab(active, e.shiftKey ? 'all' : 'current');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

function Empty({ title, text, action }: { title: string; text: string; action: { label: string; run: () => void } }) {
  return (
    <div className="empty">
      <div className="box">
        <img className="empty-logo" src={logoMark} alt="" aria-hidden="true" draggable={false} />
        <h2>{title}</h2>
        <p>{text}</p>
        <button className="btn accent" onClick={action.run}>
          {action.label}
        </button>
      </div>
    </div>
  );
}

export function App({ platform }: { platform: string }) {
  const loaded = useStore((s) => s.loaded);
  const notices = useStore((s) => s.notices);
  const hasEnvironments = useStore((s) => s.catalog.environments.length > 0);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const environment = useStore((s) => s.catalog.environments.find((e) => e.id === activeTab?.environmentId));
  const schema = useStore((s) => (environment ? s.schemas[environment.id]?.tree : undefined));
  const sessionDatabase = useStore((s) => (activeTabId ? s.sessions[activeTabId]?.database : undefined));

  const [sidebarW, setSidebarW] = useState(248);
  const [editorH, setEditorH] = useState(250);
  const workspace = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void init();
  }, []);
  useGlobalShortcuts();

  if (!loaded) return null;

  const openRegistry = () => setState({ registry: { section: hasEnvironments ? 'environments' : 'credentials', editId: 'new' } });
  const database = sessionDatabase ?? activeTab?.database ?? environment?.defaultDatabase ?? null;

  const words = m().app;
  let main: React.ReactNode;
  if (!hasEnvironments) {
    main = (
      <Empty
        title={words.noEnvironments.title}
        text={words.noEnvironments.text}
        action={{ label: words.noEnvironments.action, run: openRegistry }}
      />
    );
  } else if (!activeTab || !environment) {
    main = (
      <>
        <TabBar />
        <Empty
          title={words.noTabs.title}
          text={words.noTabs.text}
          action={{ label: words.noTabs.action, run: () => setState({ picker: true }) }}
        />
      </>
    );
  } else {
    main = (
      <>
        <TabBar />
        <SessionBar tabId={activeTab.id} platform={platform} />
        <div className="workspace" ref={workspace}>
          <div className="editor-wrap" style={{ height: editorH, flex: 'none' }}>
            <Editor
              tabId={activeTab.id}
              environmentId={environment.id}
              initialSql={activeTab.sql}
              engine={environment.engine}
              schema={schema}
              database={database}
            />
          </div>
          <Splitter
            onDrag={(dy) => {
              const max = (workspace.current?.clientHeight ?? 600) - 120;
              setEditorH((h) => Math.max(80, Math.min(max, h + dy)));
            }}
          />
          <Results tabId={activeTab.id} />
        </div>
        <StatusBar tabId={activeTab.id} platform={platform} />
      </>
    );
  }

  return (
    <div className="app" style={{ ['--sidebar-w' as string]: `${sidebarW}px` }}>
      <div style={{ position: 'relative', minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Sidebar />
        </div>
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = sidebarW;
            const move = (ev: PointerEvent) => setSidebarW(Math.max(190, Math.min(420, startW + ev.clientX - startX)));
            const up = () => {
              window.removeEventListener('pointermove', move);
              window.removeEventListener('pointerup', up);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
          }}
        />
      </div>
      <main className="main">
        {notices.map((text) => (
          <div key={text} className="startup-notice" role="status" data-testid="startup-notice">
            <span style={{ flex: 1 }}>{text}</span>
            <button className="btn small" onClick={() => setState((s) => ({ notices: s.notices.filter((n) => n !== text) }))}>
              {words.noticeDismiss}
            </button>
          </div>
        ))}
        {main}
      </main>
      <RegistryDialog />
      <TabPicker />
      <ScriptPicker />
      <AgentsPanel />
      <TrailPanel />
      <AgentModals />
      <ScriptNameDialog />
      <ProjectNameDialog />
      <CloseDirtyDialog />
      <ConfirmDialog />
      <BytesConfirmDialog />
      <CloseTransactionDialog />
      <QuitDialog />
      <Toast />
    </div>
  );
}
