import { useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Database, Eye, FileCode, History, Key, MoreHorizontal, Plus, Table2 } from 'lucide-react';
import type { Environment, Project, SavedScript } from '@shared/model';
import { lastRunText, sortByRecency } from '@shared/scripts';
import type { SchemaTable } from '@shared/results';
import {
  deleteScript,
  duplicateProject,
  duplicateScript,
  environmentHasTab,
  focusOrOpenEnvironment,
  loadSchema,
  openScript,
  openTab,
  openTableTab,
  renameProject,
  renameScript,
} from '../lib/actions';
import { m } from '../lib/i18n';
import { setState, useStore } from '../lib/store';
import { ContextMenu, type MenuEntry } from './ui';
import logoMark from '../../../resources/logo-mark.png';

function TableNode({ env, database, table, depth }: { env: Environment; database: string; table: SchemaTable; depth: number }) {
  const [open, setOpen] = useState(false);
  const Icon = table.type === 'view' ? Eye : Table2;
  return (
    <>
      <div
        className="tree-row"
        style={{ paddingLeft: 6 + depth * 12 }}
        onDoubleClick={() => openTableTab(env.id, database, table.name)}
        title={m().sidebar.tableTitle}
      >
        <span
          className="chev"
          role="button"
          aria-label={open ? m().sidebar.collapseColumns : m().sidebar.expandColumns}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <Icon size={13} />
        <span className="label">{table.name}</span>
      </div>
      {open &&
        table.columns.map((c) => (
          <div key={c.name} className="tree-row" style={{ paddingLeft: 6 + (depth + 1) * 12 + 14 }}>
            <span className="label" style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
              {c.name}
            </span>
            <span className="detail">
              {c.type}
              {c.key === 'PRI' ? ' · PK' : c.key === 'UNI' ? ' · UQ' : ''}
            </span>
          </div>
        ))}
    </>
  );
}

function DatabaseNode({ env, db }: { env: Environment; db: { name: string; tables: SchemaTable[] } }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="tree-row" style={{ paddingLeft: 6 + 2 * 12 }} onClick={() => setOpen((o) => !o)}>
        <span className="chev">{open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</span>
        <Database size={13} />
        <span className="label">{db.name}</span>
      </div>
      {open &&
        db.tables.map((t) => <TableNode key={t.name} env={env} database={db.name} table={t} depth={3} />)}
      {open && db.tables.length === 0 && <div className="tree-loading">{m().sidebar.noTables}</div>}
    </>
  );
}

function ScriptNode({ env, script }: { env: Environment; script: SavedScript }) {
  const environments = useStore((s) => s.catalog.environments);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const others = environments.filter((e) => e.projectId === script.projectId && e.id !== env.id);
  const text = m().sidebar;
  const items: MenuEntry[] = [
    { label: text.openScript, onSelect: () => openScript(script.id, env.id) },
    ...(others.length > 0
      ? [
          {
            label: text.openScriptIn,
            children: others.map((e) => ({ label: e.name, onSelect: () => openScript(script.id, e.id) })),
          },
        ]
      : []),
    { label: text.renameScript, onSelect: () => renameScript(script.id), separatorBefore: true },
    { label: text.duplicateScript, onSelect: () => void duplicateScript(script.id) },
    { label: text.deleteScript, onSelect: () => deleteScript(script.id) },
  ];
  return (
    <>
      <div
        className="tree-row script"
        style={{ paddingLeft: 6 + 3 * 12 + 14 }}
        onClick={() => openScript(script.id, env.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        title={lastRunText(script, environments, Date.now())}
        data-testid={`script-${script.name}`}
      >
        <span className="label">{script.name}</span>
        {script.createdBy === 'agent' && <span className="tag-agent">{text.agentTag}</span>}
        <button
          className="icon-btn row-action"
          aria-label={text.scriptMenu({ name: script.name })}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom + 2 });
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </>
  );
}

function ScriptsGroup({ env }: { env: Environment }) {
  const all = useStore((s) => s.scripts);
  const scripts = sortByRecency(all.filter((sc) => sc.projectId === env.projectId));
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <div
        className="tree-row"
        style={{ paddingLeft: 6 + 2 * 12 }}
        data-testid={`scripts-${env.name}`}
        onClick={() => setOpen((o) => !o)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <span className="chev">{open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</span>
        <FileCode size={13} />
        <span className="label">{m().sidebar.scripts}</span>
        <span className="detail" data-testid={`scripts-count-${env.name}`}>
          {scripts.length}
        </span>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[{ label: m().sidebar.newScript, onSelect: () => openTab(env.id) }]}
          onClose={() => setMenu(null)}
        />
      )}
      {open && scripts.map((script) => <ScriptNode key={script.id} env={env} script={script} />)}
      {open && scripts.length === 0 && (
        <div className="tree-loading" style={{ paddingLeft: 6 + 3 * 12 + 14 }}>
          {m().sidebar.scriptsEmpty}
        </div>
      )}
    </>
  );
}

function EnvNode({ env, expanded, onToggle }: { env: Environment; expanded: boolean; onToggle: () => void }) {
  const schema = useStore((s) => s.schemas[env.id]);
  const activeEnv = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.environmentId);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // whether the environment had a tab before the first click of this gesture: a double click opens
  // another tab only when one already existed
  const hadTab = useRef(false);

  const text = m().sidebar;
  const items: MenuEntry[] = [
    { label: text.newTab, onSelect: () => openTab(env.id) },
    { label: text.editEnvironment, onSelect: () => setState({ registry: { section: 'environments', editId: env.id } }) },
    {
      label: text.duplicateEnvironment,
      onSelect: () => setState({ registry: { section: 'environments', editId: 'new', duplicateOf: env.id } }),
    },
    { label: text.refreshSchema, onSelect: () => void loadSchema(env.id, true) },
  ];

  return (
    <>
      <div
        className={`tree-row ${activeEnv === env.id ? 'active' : ''}`}
        style={{ paddingLeft: 6 + 12 }}
        onClick={(e) => {
          // the second click of a double click is handled by onDoubleClick
          if (e.detail > 1) return;
          hadTab.current = environmentHasTab(env.id);
          focusOrOpenEnvironment(env.id);
          if (!expanded) onToggle();
        }}
        onDoubleClick={() => {
          // another tab, only if one existed before the gesture: the first click may have just created it
          if (hadTab.current) openTab(env.id);
        }}
        title={text.envTitle}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        data-testid={`env-${env.name}`}
      >
        <span
          className="chev"
          role="button"
          aria-label={expanded ? text.collapseDatabases : text.expandDatabases}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
            if (!expanded) void loadSchema(env.id);
          }}
        >
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <span className={`dot ${env.production ? 'prod' : ''}`} />
        <span className="label">{env.name}</span>
        <button
          className="icon-btn row-action"
          aria-label={text.environmentMenu({ name: env.name })}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom + 2 });
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {expanded && <ScriptsGroup env={env} />}
      {expanded && schema?.status === 'loading' && !schema.tree && <div className="tree-loading">{text.loadingSchema}</div>}
      {expanded && schema?.status === 'error' && <div className="tree-error">{schema.error}</div>}
      {expanded && schema?.tree?.databases.map((db) => <DatabaseNode key={db.name} env={env} db={db} />)}
    </>
  );
}

function ProjectNode({ project, envs }: { project: Project; envs: Environment[] }) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const text = m().sidebar;
  const newEnvironment = () => setState({ registry: { section: 'environments', editId: 'new', projectId: project.id } });
  const items: MenuEntry[] = [
    { label: text.newEnvironment, onSelect: newEnvironment },
    { label: text.renameProject, onSelect: () => renameProject(project.id), separatorBefore: true },
    { label: text.duplicateProject, onSelect: () => duplicateProject(project.id) },
  ];
  return (
    <>
      <div
        className="tree-row project"
        onClick={() => setOpen((o) => !o)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        data-testid={`project-${project.name}`}
      >
        <span className="chev">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
        <span className="label">{project.name}</span>
        <button
          className="icon-btn row-action"
          aria-label={text.projectMenu({ name: project.name })}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom + 2 });
          }}
        >
          <MoreHorizontal size={13} />
        </button>
        <button
          className="icon-btn row-action"
          aria-label={text.newEnvironmentIn({ name: project.name })}
          title={text.newEnvironment}
          onClick={(e) => {
            e.stopPropagation();
            newEnvironment();
          }}
        >
          <Plus size={13} />
        </button>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {open &&
        envs.map((env) => (
          <EnvNode
            key={env.id}
            env={env}
            expanded={expanded.has(env.id)}
            onToggle={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(env.id)) next.delete(env.id);
                else next.add(env.id);
                return next;
              })
            }
          />
        ))}
    </>
  );
}

export function Sidebar() {
  const projects = useStore((s) => s.catalog.projects);
  const environments = useStore((s) => s.catalog.environments);
  const waiting = useStore((s) => s.agents.pending.length + s.agents.awaitingCommit.length);
  const text = m().sidebar;
  return (
    <nav className="sidebar" aria-label={text.navLabel}>
      <div className="sidebar-head drag">
        <span className="sidebar-brand">
          <img className="brand-mark" src={logoMark} alt="" aria-hidden="true" draggable={false} />
          <span className="no-drag">{text.projects}</span>
        </span>
        <button
          className="icon-btn no-drag"
          aria-label={text.registerLabel}
          title={text.registerTitle}
          onClick={() => setState({ registry: { section: 'environments', editId: 'new' } })}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="tree">
        {[...projects]
          .sort((a, b) => a.order - b.order)
          .map((p) => (
            <ProjectNode key={p.id} project={p} envs={environments.filter((e) => e.projectId === p.id)} />
          ))}
        {projects.length === 0 && <div className="tree-loading" style={{ paddingLeft: 6 }}>{text.noProjects}</div>}
      </div>
      <div className="sidebar-foot">
        <div
          className="tree-row"
          role="button"
          tabIndex={0}
          onClick={() => setState({ registry: { section: 'credentials' } })}
          onKeyDown={(e) => e.key === 'Enter' && setState({ registry: { section: 'credentials' } })}
        >
          <Key size={13} />
          <span className="label">{text.credentials}</span>
        </div>
        <div
          className="tree-row"
          role="button"
          tabIndex={0}
          data-testid="agents-entry"
          onClick={() => setState({ agentPanel: true })}
          onKeyDown={(e) => e.key === 'Enter' && setState({ agentPanel: true })}
        >
          <Bot size={13} />
          <span className="label">{text.agents}</span>
          {waiting > 0 && <span className="count-pill">{waiting}</span>}
        </div>
        <div
          className="tree-row"
          role="button"
          tabIndex={0}
          data-testid="trail-entry"
          onClick={() => setState({ trailPanel: true })}
          onKeyDown={(e) => e.key === 'Enter' && setState({ trailPanel: true })}
        >
          <History size={13} />
          <span className="label">{text.trail}</span>
        </div>
      </div>
    </nav>
  );
}
