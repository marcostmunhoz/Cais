import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import type { TrailActor, TrailEntry, TrailPage } from '@shared/trail';
import { displaySql } from '@shared/text';
import { setState, useStore } from '../lib/store';
import { fmt, m } from '../lib/i18n';
import { SqlView } from './SqlView';
import { DialogHead, Modal } from './ui';
import { errorMessage } from '../lib/errors';
import { clientName } from '../lib/agents';

const PERIOD_DAYS = [1, 7, 30, 90] as const;

const PAGE = 200;

type Labels = Record<string, string | ((p: never) => string)>;

/** The label of a code from a catalog table, or the code itself when the table does not know it (older or newer lines). */
function label(table: Labels, code: string): string {
  if (!Object.hasOwn(table, code)) return code;
  const entry = table[code];
  return typeof entry === 'string' ? entry : code;
}

const BAD = new Set(['error', 'refused', 'failed', 'rejected', 'expired', 'rolled_back', 'cancelled']);

const when = (ts: number): string =>
  new Date(ts).toLocaleString(fmt().locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

const place = (slug: string): string => (slug ? slug.replace('/', ' · ') : '—');

/** A trail file day (YYYY-MM-DD) as a local date. */
function day(value: string): string {
  const [y, mo, d] = value.split('-').map(Number);
  if (!y || !mo || !d) return value;
  return fmt().formatDate(new Date(y, mo - 1, d));
}

function who(e: TrailEntry): string {
  const t = m().trail.actor;
  if (e.actor === 'person') return t.person;
  if (e.actor === 'cais') return t.cais;
  return t.agent({ client: clientName(e.client) });
}

function what(e: TrailEntry): string {
  if (e.event && e.event !== 'statement') return label(m().trail.event, e.event);
  return label(m().trail.mode, e.mode);
}

function counts(e: TrailEntry): string {
  const t = m().trail.counts;
  const parts: string[] = [];
  if (e.rows !== undefined) parts.push(t.rows({ count: e.rows }));
  if (e.affectedRows !== undefined) parts.push(t.affected({ count: e.affectedRows }));
  if (e.statements) {
    const affected = e.statements.reduce((n, s) => n + (s.affectedRows ?? 0), 0);
    const rows = e.statements.reduce((n, s) => n + (s.rows ?? 0), 0);
    if (e.mode === 'write') parts.push(t.affected({ count: affected }));
    else if (rows > 0) parts.push(t.rows({ count: rows }));
  }
  if (e.durationMs !== undefined) parts.push(t.duration({ count: e.durationMs }));
  return parts.join(' · ');
}

function Detail({ entry }: { entry: TrailEntry }) {
  const t = m().trail;
  const d = t.detail;
  const rows: [string, string][] = [];
  rows.push([d.when, fmt().formatDateTime(entry.ts)]);
  rows.push([d.who, who(entry)]);
  if (entry.environment) rows.push([d.environment, `${place(entry.environment)}${entry.production ? ` ${d.productionSuffix}` : ''}`]);
  if (entry.database) rows.push([d.database, entry.database]);
  if (entry.reason) rows.push([d.reason, entry.reason]);
  if (entry.decidedBy) rows.push([d.decidedBy, label(t.decidedBy, entry.decidedBy)]);
  if (entry.secondDecidedBy) rows.push([d.secondDecidedBy, label(t.secondDecidedBy, entry.secondDecidedBy)]);
  if (entry.shareResult === false) rows.push([d.result, d.resultWithheld]);
  if (entry.errorCode) rows.push([d.error, `${entry.errorCode}${entry.errno !== undefined ? ` (${entry.errno})` : ''}`]);
  if (entry.rollbackReason) rows.push([d.rollbackBy, label(t.rollbackReason, entry.rollbackReason)]);
  if (entry.rollbackIncomplete) rows.push([d.warning, d.rollbackIncomplete]);
  if (entry.detail) rows.push([d.detail, entry.detail]);
  if (entry.sqlLength) rows.push([d.sql, d.sqlCut({ count: entry.sqlLength })]);
  if (entry.statements && entry.statements.length > 1) {
    rows.push([
      d.statements,
      entry.statements
        .map(
          (s, i) =>
            `#${i + 1} ${s.verb}${s.affectedRows !== undefined ? ` ${d.statementAffected({ count: s.affectedRows })}` : s.rows !== undefined ? ` ${d.statementRows({ count: s.rows })}` : ''}${s.errorCode ? ` ${s.errorCode}` : ''}`,
        )
        .join(' · '),
    ]);
  }
  return (
    <div className="agent-detail" data-testid="trail-detail">
      <div className="agent-meta">
        {rows.map(([k, v]) => (
          <span key={k} style={{ display: 'contents' }}>
            <span className="k">{k}</span>
            <span className="v">{v}</span>
          </span>
        ))}
      </div>
      {entry.sql && <SqlView value={entry.sql} label={d.sql} />}
    </div>
  );
}

/** The trail of executions: read-only, newest first, filters on the period, who, environment and text. */
export function TrailPanel() {
  const open = useStore((s) => s.trailPanel);
  const environments = useStore((s) => s.catalog.environments);
  const projects = useStore((s) => s.catalog.projects);
  const [days, setDays] = useState(7);
  const [actor, setActor] = useState<TrailActor | ''>('');
  const [environmentId, setEnvironmentId] = useState('');
  const [text, setText] = useState('');
  const [page, setPage] = useState<TrailPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  const load = async (before?: number): Promise<void> => {
    const mine = ++generation.current;
    setLoading(true);
    try {
      const next = await window.cais.trail.list({
        days,
        limit: PAGE,
        ...(before !== undefined ? { before } : {}),
        ...(actor ? { actor } : {}),
        ...(environmentId ? { environmentId } : {}),
        ...(text.trim() ? { text: text.trim() } : {}),
      });
      if (mine !== generation.current) return;
      setError(null);
      setPage((prev) => (before !== undefined && prev ? { ...next, entries: [...prev.entries, ...next.entries] } : next));
    } catch (e) {
      if (mine === generation.current) setError(errorMessage(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => void load(), text ? 250 : 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, days, actor, environmentId, text]);

  if (!open) return null;
  const close = () => setState({ trailPanel: false });
  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? '?';
  const keyOf = (e: TrailEntry): string => `${e.id}:${e.ts}`;
  const t = m().trail;
  return (
    <Modal title={t.title} onClose={close} className="trail-panel">
      <DialogHead
        title={t.title}
        right={
          <button className="btn small" onClick={close}>
            {t.close}
          </button>
        }
      />
      <div className="dialog-body">
        <div className="trail-filters">
          <select className="input" aria-label={t.period.label} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {PERIOD_DAYS.map((n) => (
              <option key={n} value={n}>
                {t.period[`d${n}`]}
              </option>
            ))}
          </select>
          <select className="input" aria-label={t.filter.actorLabel} data-testid="trail-actor" value={actor} onChange={(e) => setActor(e.target.value as TrailActor | '')}>
            <option value="">{t.filter.actorAll}</option>
            <option value="person">{t.filter.actorPerson}</option>
            <option value="agent">{t.filter.actorAgent}</option>
            <option value="cais">{t.filter.actorCais}</option>
          </select>
          <select className="input" aria-label={t.filter.environmentLabel} value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
            <option value="">{t.filter.environmentAll}</option>
            {environments.map((e) => (
              <option key={e.id} value={e.id}>
                {projectName(e.projectId)} · {e.name}
              </option>
            ))}
          </select>
          <input
            className="input search"
            aria-label={t.filter.searchLabel}
            data-testid="trail-search"
            placeholder={t.filter.searchPlaceholder}
            value={text}
            maxLength={200}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="trail-status">
          {page && page.tampered.length > 0 && (
            <span className="agent-alert" role="alert" data-testid="trail-tampered">
              <AlertTriangle size={13} /> {t.tampered({ days: page.tampered.map(day).join(', ') })}
            </span>
          )}
          {page?.writeError && (
            <span className="agent-alert" role="alert">
              <AlertTriangle size={13} /> {page.writeError}
            </span>
          )}
          {page && (
            <span className="muted" data-testid="trail-verified">
              {page.verified ? (
                <>
                  <ShieldCheck size={12} style={{ verticalAlign: -2 }} /> {t.verified}
                </>
              ) : (
                t.unverified
              )}
            </span>
          )}
          {error && (
            <span className="form-error" role="alert">
              {error}
            </span>
          )}
        </div>
        {page && page.entries.length === 0 && !loading && <div className="muted">{t.empty}</div>}
        {page?.entries.map((e) => {
          const key = keyOf(e);
          // automatic only when the second decision was the policy's: a write the person committed is the person's
          const automatic = e.state === 'committed' && e.secondDecidedBy === 'policy';
          const tone = BAD.has(e.state) ? 'bad' : automatic || e.state === 'running' ? 'warn' : '';
          return (
            <div key={key}>
              <div
                className="agent-row trail-row"
                role="button"
                tabIndex={0}
                data-testid="trail-row"
                onClick={() => setDetail(detail === key ? null : key)}
                onKeyDown={(ev) => ev.key === 'Enter' && setDetail(detail === key ? null : key)}
              >
                <span className="when">{when(e.ts)}</span>
                <span className="who">{who(e)}</span>
                <span className="where">
                  {place(e.environment)}
                  {e.production && <span className="badge" style={{ marginLeft: 6 }}>{t.production}</span>}
                </span>
                <span className="agent-pill">{what(e)}</span>
                <span className={`agent-pill ${tone}`}>
                  {label(t.state, e.state)}
                  {automatic ? ` (${t.automatic})` : ''}
                  {e.imported ? ` · ${t.imported}` : ''}
                </span>
                <span className="first">{e.sql ? displaySql(e.sql).trim().split('\n')[0] : (e.detail ?? '')}</span>
                <span className="counts">{counts(e)}</span>
              </div>
              {detail === key && <Detail entry={e} />}
            </div>
          );
        })}
        {page?.nextBefore !== undefined && (
          <div className="trail-more">
            <button className="btn small" disabled={loading} onClick={() => void load(page.nextBefore)}>
              {t.loadMore}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
