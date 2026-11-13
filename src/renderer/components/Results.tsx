import { useEffect, useMemo, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { ChevronDown, Copy, PanelRight, X } from 'lucide-react';
import type { CellValue, ColumnMeta, StatementResult } from '@shared/results';
import { getDialect } from '@shared/dialects/registry';
import { cellInputText, cellLock, gridEditability, parseCellInput, pendingCount, type EditTarget, type PendingCells } from '@shared/grid';
import {
  applyEdits,
  discardEdits,
  dismissEditNotice,
  effectiveMode,
  generateUpdates,
  loadSchema,
  selectResult,
  setCellEdit,
} from '../lib/actions';
import { m, render } from '../lib/i18n';
import {
  displayCell,
  formatDuration,
  isNumericType,
  prettyJson,
  toDelimited,
  toJson,
  type Selection,
} from '../lib/format';
import { useStore } from '../lib/store';
import { ContextMenu, type MenuEntry } from './ui';

const ROW_H = 24;
const HEAD_H = 28;
const GUTTER_W = 52;

export function resultLabel(r: StatementResult): string {
  const n = r.index + 1;
  const t = m().results.label;
  if (r.error) return t.error({ n, verb: r.verb || t.statement });
  if (r.columns) return t.rows({ n, verb: r.verb, rows: r.rows?.length ?? 0 });
  return t.affected({ n, verb: r.verb, rows: r.affectedRows ?? 0 });
}

function ErrorCard({ result }: { result: StatementResult }) {
  const e = result.error!;
  const refused = e.code === 'REFUSED';
  const t = m().results;
  const detail = [
    e.detail ?? (refused ? null : e.message),
    e.code ? t.code({ code: e.code }) : null,
    e.errno !== undefined ? `errno: ${e.errno}` : null,
    e.sqlState ? `sqlstate: ${e.sqlState}` : null,
  ].filter(Boolean);
  return (
    <div className="error-card" role="alert">
      <div className="title">{refused ? t.refused : t.error}</div>
      <div>{e.message}</div>
      {e.hint && <div className="muted">{e.hint}</div>}
      {detail.length > 0 && (
        <details>
          <summary>{t.details}</summary>
          <pre>{detail.join('\n')}</pre>
        </details>
      )}
    </div>
  );
}

function Message({ text }: { text: string }) {
  return (
    <div className="error-card" role="alert">
      <div className="title">{m().results.cannotContinue}</div>
      <div>{text}</div>
    </div>
  );
}

function estimateWidths(columns: ColumnMeta[], rows: CellValue[][]): number[] {
  return columns.map((col, c) => {
    let chars = col.name.length + col.type.length + 2;
    for (let r = 0; r < Math.min(rows.length, 60); r++) {
      chars = Math.max(chars, displayCell(rows[r]![c] ?? null).length);
    }
    return Math.round(Math.min(Math.max(chars * 7.2 + 20, 76), 340));
  });
}

type Cell = { r: number; c: number };

interface GridProps {
  columns: ColumnMeta[];
  rows: CellValue[][];
  focus: Cell | null;
  anchor: Cell | null;
  onSelect: (anchor: Cell, focus: Cell) => void;
  onCopy: (e: React.ClipboardEvent) => void;
  scroller: React.RefObject<HTMLDivElement | null>;
  /** Pending new values, shown in place of the server's and marked. */
  edited?: PendingCells;
  /** The cell being edited and its input. */
  editing?: { cell: Cell; input: React.ReactNode } | null;
  onEditRequest: (cell: Cell) => void;
  onCellMenu: (cell: Cell, x: number, y: number) => void;
}

function Grid({ columns, rows, focus, anchor, onSelect, onCopy, scroller, edited, editing, onEditRequest, onCellMenu }: GridProps) {
  const widths = useMemo(() => estimateWidths(columns, rows), [columns, rows]);
  const totalW = GUTTER_W + widths.reduce((a, b) => a + b, 0);

  // the cell being edited stays mounted while scrolled away, so its input keeps the typed text and the focus
  const editingCell = useRef<Cell | undefined>(undefined);
  editingCell.current = editing?.cell;
  const keepEditing = (pick: (cell: Cell) => number) => (range: Range) => {
    const out = defaultRangeExtractor(range);
    const cell = editingCell.current;
    if (cell) {
      const i = pick(cell);
      if (i >= 0 && i < range.count && !out.includes(i)) {
        out.push(i);
        out.sort((a, b) => a - b);
      }
    }
    return out;
  };
  const rowV = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    rangeExtractor: keepEditing((cell) => cell.r),
  });
  const colV = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => widths[i] ?? 100,
    overscan: 3,
    paddingStart: GUTTER_W,
    rangeExtractor: keepEditing((cell) => cell.c),
  });
  // an edit opened from the keyboard may be on a cell out of view (the focus after clicking a header)
  const editR = editing?.cell.r;
  const editC = editing?.cell.c;
  useEffect(() => {
    if (editR === undefined || editC === undefined) return;
    rowV.scrollToIndex(editR);
    colV.scrollToIndex(editC);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editR, editC]);

  const sel: Selection | null =
    anchor && focus
      ? {
          r1: Math.min(anchor.r, focus.r),
          r2: Math.max(anchor.r, focus.r),
          c1: Math.min(anchor.c, focus.c),
          c2: Math.max(anchor.c, focus.c),
        }
      : null;

  const dragging = useRef(false);
  const cellAt = (target: EventTarget | null): { r: number; c: number } | null => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>('[data-r],[data-hc],[data-gr]');
    if (!el) return null;
    if (el.dataset.hc !== undefined) return { r: -1, c: Number(el.dataset.hc) };
    if (el.dataset.gr !== undefined) return { r: Number(el.dataset.gr), c: -2 };
    return { r: Number(el.dataset.r), c: Number(el.dataset.c) };
  };
  const lastRow = rows.length - 1;
  const lastCol = columns.length - 1;

  const onMouseDown = (e: React.MouseEvent) => {
    const hit = cellAt(e.target);
    if (!hit || e.button !== 0) return;
    dragging.current = true;
    const window_ = () => {
      dragging.current = false;
      window.removeEventListener('mouseup', window_);
    };
    window.addEventListener('mouseup', window_);
    if (hit.r === -1) {
      onSelect({ r: 0, c: hit.c }, { r: lastRow, c: hit.c }); // whole column
    } else if (hit.c === -2) {
      onSelect({ r: hit.r, c: 0 }, { r: hit.r, c: lastCol }); // whole row
    } else if (e.shiftKey && anchor) {
      onSelect(anchor, hit);
    } else {
      onSelect(hit, hit);
    }
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragging.current || !anchor) return;
    const hit = cellAt(e.target);
    if (hit && hit.r >= 0 && hit.c >= 0) onSelect(anchor, hit);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if ((e.key === 'Enter' || e.key === 'F2') && !mod && !e.altKey && focus) {
      e.preventDefault();
      onEditRequest(focus);
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      onSelect({ r: 0, c: 0 }, { r: lastRow, c: lastCol });
      return;
    }
    const f = focus ?? { r: 0, c: 0 };
    let next = f;
    if (e.key === 'ArrowDown') next = { r: Math.min(lastRow, f.r + 1), c: f.c };
    else if (e.key === 'ArrowUp') next = { r: Math.max(0, f.r - 1), c: f.c };
    else if (e.key === 'ArrowRight') next = { r: f.r, c: Math.min(lastCol, f.c + 1) };
    else if (e.key === 'ArrowLeft') next = { r: f.r, c: Math.max(0, f.c - 1) };
    else return;
    e.preventDefault();
    onSelect(e.shiftKey && anchor ? anchor : next, next);
    rowV.scrollToIndex(next.r);
    colV.scrollToIndex(next.c);
  };

  const isNum = columns.map((c) => isNumericType(c.type));

  return (
    <div
      className="grid"
      ref={scroller}
      tabIndex={0}
      role="grid"
      aria-label={m().results.gridLabel}
      aria-rowcount={rows.length}
      aria-colcount={columns.length}
      data-testid="result-grid"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onKeyDown={onKeyDown}
      onCopy={onCopy}
      onDoubleClick={(e) => {
        const hit = cellAt(e.target);
        if (hit && hit.r >= 0 && hit.c >= 0) onEditRequest(hit);
      }}
      onContextMenu={(e) => {
        const hit = cellAt(e.target);
        if (!hit || hit.r < 0 || hit.c < 0) return;
        e.preventDefault();
        const inside = sel && hit.r >= sel.r1 && hit.r <= sel.r2 && hit.c >= sel.c1 && hit.c <= sel.c2;
        if (!inside) onSelect(hit, hit);
        onCellMenu(hit, e.clientX, e.clientY);
      }}
    >
      <div style={{ width: totalW, height: HEAD_H + rowV.getTotalSize(), position: 'relative' }}>
        <div className="grid-head" style={{ height: HEAD_H, width: totalW }} role="row">
          <div className="grid-cell gutter head" style={{ left: 0, width: GUTTER_W, height: HEAD_H, position: 'sticky' }} />
          {colV.getVirtualItems().map((vc) => {
            const col = columns[vc.index]!;
            return (
              <div
                key={vc.key}
                role="columnheader"
                data-hc={vc.index}
                className={`grid-cell head ${isNum[vc.index] ? 'num' : ''}`}
                style={{ left: vc.start, width: vc.size, height: HEAD_H }}
                title={`${col.name} (${col.type})`}
              >
                <span>{col.name}</span>
                <span className="type">{col.type}</span>
              </div>
            );
          })}
        </div>
        {rowV.getVirtualItems().map((vr) => {
          const row = rows[vr.index]!;
          return (
            <div
              key={vr.key}
              role="row"
              aria-rowindex={vr.index + 1}
              style={{ position: 'absolute', top: HEAD_H + vr.start, left: 0, width: totalW, height: ROW_H }}
            >
              <div
                data-gr={vr.index}
                className="grid-cell gutter"
                style={{ left: 0, width: GUTTER_W, height: ROW_H, position: 'sticky' }}
              >
                {vr.index + 1}
              </div>
              {colV.getVirtualItems().map((vc) => {
                const rowEdits = edited?.[vr.index];
                const isEdited = !!rowEdits && Object.hasOwn(rowEdits, vc.index);
                const original = row[vc.index] ?? null;
                const value = isEdited ? (rowEdits[vc.index] ?? null) : original;
                const inSel = sel && vr.index >= sel.r1 && vr.index <= sel.r2 && vc.index >= sel.c1 && vc.index <= sel.c2;
                const isFocus = focus?.r === vr.index && focus?.c === vc.index;
                const isEditing = editing?.cell.r === vr.index && editing.cell.c === vc.index;
                const cls = [
                  'grid-cell',
                  isNum[vc.index] ? 'num' : '',
                  inSel ? 'sel' : '',
                  isFocus ? 'focus' : '',
                  isEdited ? 'edited' : '',
                  isEditing ? 'editing' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <div
                    key={vc.key}
                    role="gridcell"
                    data-r={vr.index}
                    data-c={vc.index}
                    data-col={columns[vc.index]!.name}
                    {...(isEdited ? { 'data-edited': 'true', title: m().grid.cell.original({ value: displayCell(original) }) } : {})}
                    className={cls}
                    style={{ left: vc.start, width: vc.size, height: ROW_H }}
                  >
                    {isEditing ? editing.input : value === null ? (
                      <span className="null">NULL</span>
                    ) : typeof value === 'object' ? (
                      <span className="binary">{displayCell(value)}</span>
                    ) : (
                      <span>{value}</span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The input of a cell being edited: Enter confirms, Esc cancels, leaving the cell confirms. */
function CellEditor({
  initial,
  label,
  invalid,
  onCommit,
  onCancel,
}: {
  initial: string;
  label: string;
  invalid: boolean;
  onCommit: (text: string, how: 'enter' | 'blur', touched: boolean) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  // leaving an editor nobody typed in records nothing: a NULL cell opens empty, and empty text is not NULL
  const touched = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const closed = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <input
      ref={input}
      className={`cell-input ${invalid ? 'invalid' : ''}`}
      data-testid="cell-editor"
      aria-label={label}
      aria-invalid={invalid}
      spellCheck={false}
      value={text}
      onChange={(e) => {
        touched.current = true;
        setText(e.target.value);
      }}
      onKeyDown={(e) => {
        // the grid's own keys (arrows, Cmd+A, Enter) must not act while typing
        e.stopPropagation();
        if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          onCommit(text, 'enter', touched.current);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closed.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (!closed.current) onCommit(text, 'blur', touched.current);
      }}
      onMouseDown={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onCopy={stop}
      onCut={stop}
      onPaste={stop}
    />
  );
}

function CellPanel({ column, value }: { column?: ColumnMeta; value: CellValue | undefined }) {
  const t = m().results;
  let body: React.ReactNode;
  if (!column || value === undefined) {
    body = <span className="muted">{t.selectCell}</span>;
  } else if (value === null) {
    body = <span className="null">NULL</span>;
  } else if (typeof value === 'object') {
    body = `0x${value.hex}${value.hex.length / 2 < value.length ? `…\n\n${t.bytesPartial({ length: value.length, shown: value.hex.length / 2 })}` : `\n\n${t.bytes({ length: value.length })}`}`;
  } else {
    const text = String(value);
    body = (column.type === 'json' || /^\s*[[{]/.test(text) ? prettyJson(text) : null) ?? text;
  }
  return (
    <aside className="cellpanel" aria-label={t.cellValue} data-testid="cell-panel">
      <div className="cellpanel-head">
        <span>{column?.name ?? t.value}</span>
        {column && <span className="muted mono">{column.type}</span>}
      </div>
      {column && value !== undefined ? <pre>{body}</pre> : <div className="cellpanel-empty">{body}</div>}
    </aside>
  );
}

export function Results({ tabId }: { tabId: string }) {
  const run = useStore((s) => s.runs[tabId]);
  const results = run?.results ?? [];
  const active = results[Math.min(run?.active ?? 0, Math.max(0, results.length - 1))];
  const environmentId = useStore((s) => s.tabs.find((t) => t.id === tabId)?.environmentId ?? '');
  const engine = useStore((s) => s.catalog.environments.find((e) => e.id === environmentId)?.engine ?? 'mysql');
  const schemaStatus = useStore((s) => s.schemas[environmentId]?.status);
  const schemaTree = useStore((s) => (s.schemas[environmentId]?.status === 'ready' ? s.schemas[environmentId]?.tree : undefined));
  const mode = useStore(() => effectiveMode(tabId));

  const [anchor, setAnchor] = useState<Cell | null>(null);
  const [focus, setFocus] = useState<Cell | null>(null);
  const [panel, setPanel] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number; cell?: Cell } | null>(null);
  const [editing, setEditing] = useState<{ cell: Cell; initial: string; invalid: boolean } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // a new result starts with nothing selected and nothing being edited
  useEffect(() => {
    setAnchor(null);
    setFocus(null);
    setEditing(null);
    setHint(null);
    setQueued(null);
  }, [active]);

  const columns = active?.columns;
  const rows = active?.rows ?? [];

  // editing in the grid: decided from the result's metadata and the environment's schema
  const fromTable = !!active && !active.error && !!columns?.some((c) => c.source);
  useEffect(() => {
    if (fromTable && schemaStatus === undefined && environmentId) void loadSchema(environmentId);
  }, [fromTable, schemaStatus, environmentId]);
  const target = useMemo(
    () => (active && columns ? gridEditability(active, schemaTree, getDialect(engine).valueKind) : null),
    [active, columns, schemaTree, engine],
  );
  // a table created or changed after the schema was read: read it again, once per result
  const refreshed = useRef(new WeakSet<StatementResult>());
  useEffect(() => {
    if (!active || !target || schemaStatus !== 'ready') return;
    const stale = target.editable
      ? target.columns.some((c) => !c.editable && c.reason.key === 'grid.reason.staleColumn')
      : target.reason.key === 'grid.reason.unknownTable' || target.reason.key === 'grid.reason.staleSchema';
    if (!stale) return;
    if (refreshed.current.has(active)) return;
    refreshed.current.add(active);
    void loadSchema(environmentId, true);
  }, [active, target, schemaStatus, environmentId]);

  const edits = run?.edits && run.edits.result === active ? run.edits.cells : undefined;
  const pending = edits ? pendingCount(edits) : { changes: 0, rows: 0 };
  const shownRows = useMemo(
    () =>
      edits
        ? rows.map((row, r) => (edits[r] ? row.map((v, c) => (Object.hasOwn(edits[r]!, c) ? (edits[r]![c] ?? null) : v)) : row))
        : rows,
    [rows, edits],
  );

  const refocusGrid = () => requestAnimationFrame(() => scroller.current?.focus());
  const schemaError = useStore((s) => (s.schemas[environmentId]?.status === 'error' ? s.schemas[environmentId]?.error : undefined));
  // a double click while the schema loads opens the cell once it is known
  const [queued, setQueued] = useState<Cell | null>(null);
  const startEdit = (cell: Cell) => {
    if (!active || !target || run?.running) return;
    const original = rows[cell.r]?.[cell.c] ?? null;
    const lock = cellLock(target, cell.c, original);
    if (lock) {
      if (lock.key === 'grid.reason.schemaLoading') {
        if (schemaError !== undefined) {
          setHint(m().grid.reason.schemaFailed({ message: schemaError }));
          return;
        }
        if (schemaStatus === undefined && environmentId) void loadSchema(environmentId);
        setQueued(cell);
      }
      setHint(render(lock));
      return;
    }
    setHint(null);
    setEditing({ cell, initial: cellInputText(shownRows[cell.r]?.[cell.c] ?? null), invalid: false });
  };
  useEffect(() => {
    if (!queued || !target) return;
    if (!target.editable && target.reason.key === 'grid.reason.schemaLoading' && schemaError === undefined) return;
    setQueued(null);
    startEdit(queued);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, target, schemaError]);
  const commitEdit = (text: string, how: 'enter' | 'blur', touched: boolean) => {
    if (!editing || !active || !target?.editable) return;
    if (!touched && !editing.invalid) {
      // nothing typed: the cell keeps what it holds (NULL stays NULL, a pending NULL stays pending)
      setHint(null);
      setEditing(null);
      if (how === 'enter') refocusGrid();
      return;
    }
    const column = target.columns[editing.cell.c];
    if (!column?.editable) return;
    const parsed = parseCellInput(text, column, getDialect(engine));
    if ('error' in parsed) {
      setHint(render(parsed.error));
      if (how === 'enter') {
        setEditing({ ...editing, initial: text, invalid: true });
        return;
      }
    } else {
      setHint(null);
      setCellEdit(tabId, active, editing.cell.r, editing.cell.c, parsed.value);
    }
    setEditing(null);
    if (how === 'enter') refocusGrid();
  };
  const cellEntries = (cell: Cell): MenuEntry[] => {
    if (!active || !target?.editable || cellLock(target, cell.c, rows[cell.r]?.[cell.c] ?? null)) return [];
    const column = target.columns[cell.c] as EditTarget['columns'][number] & { editable: true };
    const out: MenuEntry[] = [{ label: m().grid.menu.edit, onSelect: () => startEdit(cell) }];
    if (column.nullable) out.push({ label: m().grid.menu.setNull, onSelect: () => setCellEdit(tabId, active, cell.r, cell.c, null) });
    if (edits?.[cell.r] && Object.hasOwn(edits[cell.r]!, cell.c)) {
      out.push({ label: m().grid.menu.undo, onSelect: () => setCellEdit(tabId, active, cell.r, cell.c, undefined) });
    }
    return out;
  };
  const sel: Selection | null =
    anchor && focus
      ? {
          r1: Math.min(anchor.r, focus.r),
          r2: Math.max(anchor.r, focus.r),
          c1: Math.min(anchor.c, focus.c),
          c2: Math.max(anchor.c, focus.c),
        }
      : null;

  const write = (text: string) => {
    // The async clipboard API needs a focused document; fall back to execCommand when it refuses.
    const fallback = () => {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    };
    navigator.clipboard.writeText(text).catch(fallback);
  };
  const copyEntries = (): MenuEntry[] =>
    columns
      ? [
          { label: m().results.copyTsv, onSelect: () => write(toDelimited(columns, shownRows, sel, '\t')) },
          { label: m().results.copyCsv, onSelect: () => write(toDelimited(columns, shownRows, sel, ',')) },
          { label: m().results.copyJson, onSelect: () => write(toJson(columns, shownRows, sel)) },
        ]
      : [];
  const menuEntries = (cell?: Cell): MenuEntry[] => {
    const edit = cell ? cellEntries(cell) : [];
    const copy = copyEntries();
    if (edit.length > 0 && copy[0]) copy[0] = { ...copy[0], separatorBefore: true };
    return [...edit, ...copy];
  };
  const readOnly = mode === 'read-only';
  const editArea = (
    <>
      {run?.editNotice && (
        <div className="grid-notice" role="alert" data-testid="grid-edit-notice">
          <div className="lines">
            {run.editNotice.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
          <button className="icon-btn" aria-label={m().grid.notice.close} title={m().grid.notice.close} onClick={() => dismissEditNotice(tabId)}>
            <X size={13} />
          </button>
        </div>
      )}
      {pending.changes > 0 && (
        <div className="grid-editbar" role="toolbar" aria-label={m().grid.bar.summary(pending)} data-testid="grid-edit-bar">
          <span className="summary" data-testid="grid-edit-summary">
            {m().grid.bar.summary(pending)}
          </span>
          <span className="spacer" />
          <button className="btn small" data-testid="edit-generate" title={m().grid.bar.generateTitle} onClick={() => void generateUpdates(tabId)}>
            {m().grid.bar.generate}
          </button>
          <button
            className="btn small accent"
            data-testid="edit-apply"
            disabled={readOnly || !!run?.running}
            title={readOnly ? m().grid.bar.applyReadOnly : m().grid.bar.applyTitle}
            onClick={() => void applyEdits(tabId)}
          >
            {m().grid.bar.apply}
          </button>
          <button className="btn small ghost" data-testid="edit-discard" onClick={() => discardEdits(tabId)}>
            {m().grid.bar.discard}
          </button>
        </div>
      )}
      {hint && (
        <div className="grid-hint" role="status" data-testid="grid-hint">
          {hint}
        </div>
      )}
    </>
  );

  const text = m().results;
  let content: React.ReactNode;
  if (run?.connecting) {
    content = <div className="placeholder">{text.connecting}</div>;
  } else if (run?.message === text.noStatement) {
    content = <div className="placeholder">{text.noStatement}</div>;
  } else if (run?.message) {
    content = <Message text={run.message} />;
  } else if (!active) {
    content = (
      <div className="placeholder">
        <span>{text.empty}</span>
      </div>
    );
  } else if (active.error) {
    content = <ErrorCard result={active} />;
  } else if (columns) {
    content = (
      <div className="result-body">
        <div className="grid-wrap">
          {editArea}
          {rows.length === 0 ? (
            <div className="placeholder">{text.noRows}</div>
          ) : (
            <Grid
              key={`${active.index}:${active.sql}`}
              columns={columns}
              rows={rows}
              focus={focus}
              anchor={anchor}
              scroller={scroller}
              edited={edits}
              editing={
                editing && target?.editable
                  ? {
                      cell: editing.cell,
                      input: (
                        <CellEditor
                          key={`${editing.cell.r}:${editing.cell.c}:${editing.invalid}`}
                          initial={editing.initial}
                          invalid={editing.invalid}
                          label={m().grid.cell.editorLabel({ column: columns[editing.cell.c]!.name })}
                          onCommit={commitEdit}
                          onCancel={() => {
                            setEditing(null);
                            // at once, not on the next frame: a key pressed right after Esc (Enter, F2, an arrow)
                            // goes to the grid. The input does not commit on this blur (Esc marked it closed).
                            scroller.current?.focus();
                          }}
                        />
                      ),
                    }
                  : null
              }
              onEditRequest={startEdit}
              onCellMenu={(cell, x, y) => setMenu({ x, y, cell })}
              onSelect={(a, f) => {
                setAnchor(a);
                setFocus(f);
                setHint(null);
              }}
              onCopy={(e) => {
                e.preventDefault();
                e.clipboardData.setData('text/plain', toDelimited(columns, shownRows, sel, '\t'));
              }}
            />
          )}
        </div>
        {panel && (
          <CellPanel
            column={focus ? columns[focus.c] : undefined}
            value={focus ? shownRows[focus.r]?.[focus.c] : undefined}
          />
        )}
      </div>
    );
  } else {
    content = (
      <div className="affected" data-testid="affected">
        <div>
          <strong>{text.affectedRows({ n: active.affectedRows ?? 0 })}</strong> ·{' '}
          {formatDuration(active.durationMs)}
        </div>
        {active.insertId && <div className="muted">{text.insertId({ id: active.insertId })}</div>}
        {!!active.warnings && <div className="muted">{text.warnings({ n: active.warnings })}</div>}
        {active.notice && (
          <div className="warn" role="alert">
            {active.notice}
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="results" aria-label={text.section}>
      <div className="result-tabs" role="tablist">
        {results.map((r, i) => (
          <button
            key={`${r.index}:${r.sql}`}
            role="tab"
            aria-selected={r === active}
            className={`result-tab ${r === active ? 'on' : ''} ${r.error ? 'err' : ''}`}
            onClick={() => selectResult(tabId, i)}
            title={r.sql}
          >
            {resultLabel(r)}
          </button>
        ))}
        <span className="spacer" />
        {columns && rows.length > 0 && (
          <>
            <button
              className="btn ghost small"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setMenu({ x: rect.left, y: rect.bottom + 4 });
              }}
              aria-haspopup="menu"
            >
              <Copy size={13} /> {text.copy} <ChevronDown size={12} />
            </button>
            <button
              className="icon-btn"
              onClick={() => setPanel((p) => !p)}
              aria-pressed={panel}
              title={text.cellPanel}
              aria-label={text.cellPanel}
            >
              <PanelRight size={15} />
            </button>
          </>
        )}
      </div>
      {content}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuEntries(menu.cell)} onClose={() => setMenu(null)} />}
    </section>
  );
}

export function useActiveResult(tabId: string | null): { result?: StatementResult; resultIndex: number } {
  const run = useStore((s) => (tabId ? s.runs[tabId] : undefined));
  if (!run || run.results.length === 0) return { resultIndex: 0 };
  const index = Math.min(run.active, run.results.length - 1);
  return { result: run.results[index], resultIndex: index };
}

