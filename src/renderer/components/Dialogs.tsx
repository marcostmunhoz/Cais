import { useEffect, useMemo, useRef, useState } from 'react';
import {
  answerCloseDirty,
  cancelQuit,
  openScriptFromPicker,
  openTab,
  resolveQuit,
  resolveTransactionThenClose,
  submitProjectName,
  submitScriptName,
} from '../lib/actions';
import { MAX_SCRIPT_NAME } from '@shared/model';
import { GIB } from '@shared/engines';
import { displaySql } from '@shared/text';
import { MAX_CATALOG_NAME } from '@shared/names';
import { fmt, getLocale, m } from '../lib/i18n';
import { sortByRecency } from '@shared/scripts';
import { getState, setState, useStore } from '../lib/store';
import { DialogHead, Modal } from './ui';

export function ConfirmDialog() {
  const confirm = useStore((s) => s.confirm);
  if (!confirm) return null;
  const close = () => setState({ confirm: null });
  return (
    <Modal
      title={confirm.title}
      onClose={close}
      className="confirm"
      align="center"
      footer={
        <>
          <button className="btn" autoFocus onClick={close}>
            {m().dialogs.cancel}
          </button>
          <button className={`btn ${confirm.danger ? 'danger' : 'accent'}`} onClick={confirm.onConfirm}>
            {confirm.confirmLabel}
          </button>
        </>
      }
    >
      <DialogHead title={confirm.title} />
      <div className="dialog-body" style={{ width: 460 }}>
        <div>{confirm.body}</div>
        {confirm.notes?.map((note) => (
          <div key={note} className="muted">
            {note}
          </div>
        ))}
        {confirm.items && (
          <pre className="confirm-list">{confirm.items.join('\n')}</pre>
        )}
      </div>
    </Modal>
  );
}

/** BigQuery: every statement of the run estimated above the environment's limit, with the estimate. Nothing ran yet. */
export function BytesConfirmDialog() {
  const request = useStore((s) => s.bytesConfirm);
  if (!request) return null;
  const close = () => setState({ bytesConfirm: null });
  const t = m().dialogs.bytesConfirm;
  const format = fmt();
  // the ceiling the confirmed run gets: the limit, or the largest estimate rounded up to a whole GiB
  const largest = Math.max(...request.statements.map((s) => s.bytesEstimated));
  const cap = Math.max(request.limit, Math.ceil(largest / GIB) * GIB);
  return (
    <Modal
      title={t.title}
      onClose={close}
      className="confirm"
      align="center"
      footer={
        <>
          <button className="btn" autoFocus data-testid="bytes-cancel" onClick={close}>
            {m().dialogs.cancel}
          </button>
          <button className="btn accent" data-testid="bytes-confirm" onClick={request.onConfirm}>
            {t.confirm}
          </button>
        </>
      }
    >
      <DialogHead title={t.heading} />
      <div className="dialog-body" style={{ width: 520 }} data-testid="bytes-dialog">
        <div>{t.body({ limit: format.formatBytes(request.limit), cap: format.formatBytes(cap) })}</div>
        <ul className="bytes-list">
          {request.statements.map((s) => (
            <li key={s.index} data-testid="bytes-item">
              <span className="bytes-estimate">{t.estimate({ bytes: format.formatBytes(s.bytesEstimated) })}</span>
              <code>{displaySql(s.sql)}</code>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

export function CloseTransactionDialog() {
  const closing = useStore((s) => s.closeTx);
  const session = useStore((s) => (s.closeTx ? s.sessions[s.closeTx.tabId] : undefined));
  if (!closing) return null;
  const close = () => setState({ closeTx: null });
  const count = session?.transaction.statements ?? 0;
  const t = m().dialogs;
  return (
    <Modal
      title={t.closeTransaction.title}
      onClose={close}
      align="center"
      footer={
        <>
          <button className="btn" onClick={close}>
            {t.cancel}
          </button>
          <button className="btn" onClick={() => void resolveTransactionThenClose(closing.tabId, 'commit')}>
            {t.commit}
          </button>
          <button className="btn danger" autoFocus onClick={() => void resolveTransactionThenClose(closing.tabId, 'rollback')}>
            {t.rollback}
          </button>
        </>
      }
    >
      <DialogHead title={t.closeTransaction.heading} />
      <div className="dialog-body" style={{ width: 440 }}>
        {t.closeTransaction.body({ count })}
      </div>
    </Modal>
  );
}

export function QuitDialog() {
  const pending = useStore((s) => s.quit);
  if (!pending) return null;
  const t = m().dialogs;
  return (
    <Modal
      title={t.quit.title}
      onClose={() => void cancelQuit()}
      align="center"
      footer={
        <>
          <button className="btn" onClick={() => void cancelQuit()}>
            {t.cancel}
          </button>
          <button className="btn" onClick={() => void resolveQuit(pending, 'commit')}>
            {t.commit}
          </button>
          <button className="btn danger" autoFocus onClick={() => void resolveQuit(pending, 'rollback')}>
            {t.rollback}
          </button>
        </>
      }
    >
      <DialogHead title={t.quit.heading} />
      <div className="dialog-body" style={{ width: 440 }}>
        {t.quit.body({ count: pending.length })}
      </div>
    </Modal>
  );
}

export function TabPicker() {
  const open = useStore((s) => s.picker);
  const environments = useStore((s) => s.catalog.environments);
  const projects = useStore((s) => s.catalog.projects);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
    }
  }, [open]);

  const items = useMemo(() => {
    const all = environments.map((env) => {
      const project = projects.find((p) => p.id === env.projectId);
      return { env, label: `${project?.name ?? ''} · ${env.name}`, order: project?.order ?? 0 };
    });
    all.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, getLocale()));
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((i) => tokens.every((t) => i.label.toLowerCase().includes(t)));
  }, [environments, projects, query]);

  if (!open) return null;
  const close = () => setState({ picker: false });
  const choose = (i: number) => {
    const item = items[i];
    if (item) openTab(item.env.id);
  };
  const t = m().dialogs.tabPicker;

  return (
    <Modal title={t.title} onClose={close}>
      <div className="picker">
        <input
          ref={input}
          autoFocus
          placeholder={t.placeholder}
          aria-label={t.searchLabel}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(items.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(index);
            }
          }}
        />
        <ul role="listbox" aria-label={t.listLabel}>
          {items.map((item, i) => (
            <li
              key={item.env.id}
              role="option"
              aria-selected={i === index}
              className={i === index ? 'on' : ''}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(i)}
            >
              <span className={`dot ${item.env.production ? 'prod' : ''}`} />
              <span>{item.label}</span>
              {item.env.production && <span className="badge">{t.production}</span>}
            </li>
          ))}
          {items.length === 0 && (
            <li className="muted" style={{ justifyContent: 'center' }}>
              {t.empty}
            </li>
          )}
        </ul>
      </div>
    </Modal>
  );
}

export function CloseDirtyDialog() {
  const closing = useStore((s) => s.closeDirty);
  const script = useStore((s) => s.scripts.find((sc) => sc.id === s.tabs.find((t) => t.id === s.closeDirty?.tabId)?.scriptId));
  if (!closing) return null;
  const close = () => setState({ closeDirty: null });
  const t = m().dialogs;
  return (
    <Modal
      title={t.closeDirty.title}
      onClose={close}
      align="center"
      footer={
        <>
          <button className="btn" onClick={close}>
            {t.cancel}
          </button>
          <button className="btn danger" onClick={() => void answerCloseDirty(closing.tabId, 'discard')}>
            {t.closeDirty.discard}
          </button>
          <button className="btn primary" autoFocus onClick={() => void answerCloseDirty(closing.tabId, 'save')}>
            {t.closeDirty.save}
          </button>
        </>
      }
    >
      <DialogHead title={t.closeDirty.heading} />
      <div className="dialog-body" style={{ width: 440 }}>
        {t.closeDirty.body({ name: script?.name ?? '' })}
      </div>
    </Modal>
  );
}

/** Name prompt shared by save, save as and rename. */
export function ScriptNameDialog() {
  const request = useStore((s) => s.scriptName);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(request?.initialName ?? '');
    setError(null);
    setBusy(false);
  }, [request]);

  if (!request) return null;
  const close = () => setState({ scriptName: null });
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const message = await submitScriptName(request, name);
    setBusy(false);
    if (message) setError(message);
  };
  const t = m().dialogs;
  const title = request.kind === 'rename' ? t.scriptName.renameTitle : t.scriptName.saveTitle;
  return (
    <Modal
      title={title}
      onClose={close}
      align="center"
      footer={
        <>
          <button className="btn" onClick={close}>
            {t.cancel}
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
            {request.kind === 'rename' ? t.scriptName.rename : t.scriptName.save}
          </button>
        </>
      }
    >
      <DialogHead title={title} />
      <div className="dialog-body" style={{ width: 420 }}>
        <div className="field">
          <label htmlFor="script-name">{t.scriptName.label}</label>
          <input
            id="script-name"
            autoFocus
            className="input"
            aria-label={t.scriptName.label}
            value={name}
            maxLength={MAX_SCRIPT_NAME}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Name prompt for renaming or duplicating a project. */
export function ProjectNameDialog() {
  const request = useStore((s) => s.projectName);
  const source = useStore((s) => s.catalog.projects.find((p) => p.id === s.projectName?.projectId));
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(request?.initialName ?? '');
    setError(null);
    setBusy(false);
  }, [request]);

  if (!request) return null;
  const text = m().dialogs.projectName;
  const close = () => setState({ projectName: null });
  const submit = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    const message = await submitProjectName(request, name);
    setBusy(false);
    if (message) setError(message);
  };
  const rename = request.kind === 'rename';
  const title = rename ? text.renameTitle : text.duplicateTitle;
  return (
    <Modal
      title={title}
      onClose={close}
      align="center"
      footer={
        <>
          <button className="btn" onClick={close}>
            {text.cancel}
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void submit()} data-testid="project-name-submit">
            {rename ? text.rename : text.duplicate}
          </button>
        </>
      }
    >
      <DialogHead title={title} />
      <div className="dialog-body" style={{ width: 420 }}>
        <div className="field">
          <label htmlFor="project-name">{text.label}</label>
          <input
            id="project-name"
            autoFocus
            className="input"
            value={name}
            maxLength={MAX_CATALOG_NAME}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <span className="hint">{rename ? text.renameHint : text.duplicateHint({ source: source?.name ?? '' })}</span>
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Cmd+O: search by "projeto · nome". */
export function ScriptPicker() {
  const open = useStore((s) => s.scriptPicker);
  const scripts = useStore((s) => s.scripts);
  const projects = useStore((s) => s.catalog.projects);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
    }
  }, [open]);

  const items = useMemo(() => {
    const all = sortByRecency(scripts).map((script) => ({
      script,
      label: `${projects.find((p) => p.id === script.projectId)?.name ?? ''} · ${script.name}`,
    }));
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((i) => tokens.every((t) => i.label.toLowerCase().includes(t)));
  }, [scripts, projects, query]);

  if (!open) return null;
  const close = () => setState({ scriptPicker: false });
  const choose = (i: number) => {
    const item = items[i];
    if (item) openScriptFromPicker(item.script.id);
  };
  const t = m().dialogs.scriptPicker;
  return (
    <Modal title={t.title} onClose={close}>
      <div className="picker">
        <input
          autoFocus
          placeholder={t.placeholder}
          aria-label={t.searchLabel}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(items.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(index);
            }
          }}
        />
        <ul role="listbox" aria-label={t.listLabel}>
          {items.map((item, i) => (
            <li
              key={item.script.id}
              role="option"
              aria-selected={i === index}
              className={i === index ? 'on' : ''}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(i)}
            >
              <span>{item.label}</span>
              {item.script.createdBy === 'agent' && <span className="tag-agent">{t.agent}</span>}
            </li>
          ))}
          {items.length === 0 && (
            <li className="muted" style={{ justifyContent: 'center' }}>
              {scripts.length === 0 ? t.noScripts : t.empty}
            </li>
          )}
        </ul>
      </div>
    </Modal>
  );
}

export function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div className={`toast ${toast.kind}`} role="status" onClick={() => setState({ toast: null })}>
      {toast.message}
    </div>
  );
}

export { getState };
