import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TRAIL_RETENTION_DAYS } from '@shared/agents';
import { fmt, m } from '@shared/i18n';
import type { TrailEntry, TrailPage, TrailQuery } from '@shared/trail';
import type { Scheduler } from './agents/sessions';

const DAY_MS = 24 * 3_600_000;
/** The SQL kept per line. Longer text is cut and the line says how long it was. */
export const TRAIL_MAX_SQL = 100_000;
/** A line never passes this many bytes, whatever the characters: a day file stays readable. */
export const TRAIL_MAX_LINE_BYTES = 128 * 1024;
/** Agent lines of one day stop at this many bytes: an agent cannot flood the day the person reads. */
export const TRAIL_AGENT_DAY_BYTES = 64 * 1024 * 1024;
const FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MAC_TAIL = /,"mac":"([0-9a-f]{64})"\}$/;

export interface TrailDeps {
  now(): number;
  scheduler: Scheduler;
  newId(): string;
  /** HMAC under the seal key; undefined when the vault is not available (the trail is then not chained). */
  mac(text: string): string | undefined;
  retentionDays?: number;
}

/** A line to write: the trail adds the time (and an id when there is none). */
export type TrailInput = Omit<TrailEntry, 'ts' | 'id'> & { id?: string };

const dayOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

/**
 * A password the person typed in SQL (ALTER/CREATE USER … IDENTIFIED BY, SET PASSWORD, SOURCE_PASSWORD,
 * START REPLICA … PASSWORD, CREATE SERVER … PASSWORD, CLONE … IDENTIFIED BY) leaves the trail as ***. On
 * purpose coarse: from the first IDENTIFIED or PASSWORD on, everything between the first and the last quote is
 * masked, so no escape rule, comment or second literal (REPLACE 'old') lets a piece through. Only the person's
 * lines: an agent cannot run any of these, and masking its SQL would let it hide text from the trail.
 */
export function redactSecrets(sql: string): string {
  const at = sql.search(/IDENTIFIED|PASSWORD/i);
  if (at === -1) return sql;
  const rest = sql.slice(at);
  const first = rest.search(/['"]/);
  if (first === -1) return sql;
  const last = Math.max(rest.lastIndexOf("'"), rest.lastIndexOf('"'));
  return sql.slice(0, at) + rest.slice(0, first) + "'***'" + rest.slice(last + 1);
}

/**
 * The trail of every execution in the Cais, by the person and by agents: one file per day
 * (UTC) in `<userData>/trail`, 0600, 90 days. Each line carries a MAC chained to the previous line of the
 * same file under the seal key, so a line edited, added or removed in the middle shows.
 * Never result data.
 */
export class Trail {
  private readonly lastMac = new Map<string, string>();
  /** Chain checks of whole day files, by name, size and times: a page never hides a day that does not match. */
  private readonly checked = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; intact: boolean }>();
  /** Bytes of agent lines written per day by this run (seeded from the file size when unknown). */
  private readonly agentBytes = new Map<string, number>();
  private agentFull = false;
  private timer: unknown;
  /** Set when a write failed; cleared by the next one that works. */
  private failingSince: number | undefined;
  private firstFailure: number | undefined;

  constructor(
    private readonly dir: string,
    private readonly deps: TrailDeps,
  ) {}

  /** The trail already has days on disk. */
  hasDays(): boolean {
    return this.files().length > 0;
  }

  /** The last write worked (or none was tried yet). */
  healthy(): boolean {
    return this.failingSince === undefined;
  }

  /** Agent lines can be written today: the trail works and the day's agent budget is not used up. */
  healthyForAgents(): boolean {
    return this.healthy() && !(this.agentFull && this.agentBytes.get(dayOf(this.deps.now()))! >= TRAIL_AGENT_DAY_BYTES);
  }

  /** Writes one line. Returns false when it could not be written: callers that need the line can stop. */
  append(input: TrailInput): boolean {
    const ts = this.deps.now();
    const entry: TrailEntry = { ...input, id: input.id ?? this.deps.newId(), ts } as TrailEntry;
    return this.write(entry);
  }

  private write(entry: TrailEntry): boolean {
    const raw = entry.sql ?? '';
    const sql = entry.actor === 'person' ? redactSecrets(raw) : raw;
    let cut: TrailEntry =
      sql.length > TRAIL_MAX_SQL ? { ...entry, sql: sql.slice(0, TRAIL_MAX_SQL), sqlLength: entry.sqlLength ?? sql.length } : { ...entry, sql };
    const day = dayOf(cut.ts);
    const path = join(this.dir, `${day}.jsonl`);
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      let body = JSON.stringify({ ...cut, time: new Date(cut.ts).toISOString() });
      // characters can take up to 6 bytes once escaped: cut the SQL until the whole line fits
      while (Buffer.byteLength(body, 'utf8') > TRAIL_MAX_LINE_BYTES && cut.sql.length > 0) {
        const keep = Math.floor(cut.sql.length / 2);
        cut = { ...cut, sql: cut.sql.slice(0, keep), sqlLength: cut.sqlLength ?? sql.length };
        body = JSON.stringify({ ...cut, time: new Date(cut.ts).toISOString() });
      }
      if (cut.actor === 'agent') {
        // unknown day (a restart): count the whole file, person lines included, which only errs on the safe side
        const used = this.agentBytes.get(day) ?? (existsSync(path) ? statSync(path).size : 0);
        if (used + body.length > TRAIL_AGENT_DAY_BYTES) {
          this.agentFull = true;
          this.agentBytes.set(day, Math.max(used, TRAIL_AGENT_DAY_BYTES));
          return false;
        }
        this.agentBytes.set(day, used + body.length);
      }
      const prev = this.lastMac.get(day) ?? this.tailMac(path);
      const mac = this.deps.mac(`trail:${prev}:${body}`);
      const line = mac ? `${body.slice(0, -1)},"mac":"${mac}"}` : body;
      const fresh = !existsSync(path);
      appendFileSync(path, line + '\n', { mode: 0o600 });
      if (fresh) chmodSync(path, 0o600);
      this.lastMac.set(day, mac ?? '');
      this.failingSince = undefined;
      return true;
    } catch {
      this.failingSince ??= this.deps.now();
      this.firstFailure ??= this.deps.now();
      return false;
    }
  }

  /** MAC of the last line of a file written before this run (or '' for a new file). Reads only the file's end. */
  private tailMac(path: string): string {
    if (!existsSync(path)) return '';
    const size = statSync(path).size;
    const length = Math.min(size, TRAIL_MAX_LINE_BYTES + 1024);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    const last = buffer.toString('utf8').split('\n').filter(Boolean).at(-1);
    return (last && MAC_TAIL.exec(last)?.[1]) ?? '';
  }

  /** Drops days past the retention now, then every 24 hours. Moves the old agent trail in, once. */
  start(legacyAgentFile?: string): void {
    if (legacyAgentFile) this.importLegacy(legacyAgentFile);
    this.prune();
    this.timer = this.deps.scheduler.set(() => this.start(), DAY_MS);
  }

  stop(): void {
    if (this.timer !== undefined) this.deps.scheduler.clear(this.timer);
    this.timer = undefined;
  }

  private retentionDays(): number {
    return this.deps.retentionDays ?? TRAIL_RETENTION_DAYS;
  }

  prune(): void {
    const oldest = dayOf(this.deps.now() - this.retentionDays() * DAY_MS);
    for (const name of this.files()) {
      const day = FILE.exec(name)![1]!;
      if (day < oldest) rmSync(join(this.dir, name), { force: true });
    }
  }

  /**
   * An agents-only trail file (agent-audit.jsonl), when present, becomes part of this one, once, then goes
   * away. Only into a trail that has nothing yet, with ids of their own and
   * marked as imported: a file dropped there later cannot stand in for a real line, nor be signed as if the Cais
   * had written it.
   */
  private importLegacy(path: string): void {
    if (!existsSync(path)) return;
    if (this.files().length > 0) {
      rmSync(path, { force: true });
      return;
    }
    try {
      const limit = this.deps.now() - this.retentionDays() * DAY_MS;
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      const entries: TrailEntry[] = [];
      for (const line of lines) {
        try {
          const raw = JSON.parse(line) as Partial<TrailEntry> & { time?: string };
          if (typeof raw.ts !== 'number' || raw.ts < limit) continue;
          const { time: _time, ...rest } = raw;
          entries.push({ ...rest, actor: 'agent', id: `legacy:${rest.id ?? this.deps.newId()}`, imported: true } as TrailEntry);
        } catch {
          // a broken line stays out
        }
      }
      entries.sort((a, b) => a.ts - b.ts);
      for (const entry of entries) if (!this.write(entry)) return; // keep the old file when the move fails
      rmSync(path, { force: true });
    } catch {
      // keep the old file
    }
  }

  private files(): string[] {
    try {
      return readdirSync(this.dir).filter((n) => FILE.test(n)).sort();
    } catch {
      return [];
    }
  }

  /** Whether a whole day file still matches its chain (cached while the file does not change). */
  private dayIntact(day: string): boolean {
    let stat: { size: number; mtimeMs: number; ctimeMs: number };
    try {
      stat = statSync(join(this.dir, `${day}.jsonl`));
    } catch {
      return true;
    }
    const cached = this.checked.get(day);
    // ctime cannot be set back by hand (mtime can): a same-length edit still invalidates the cache
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs) return cached.intact;
    const { intact } = this.readDay(day);
    this.checked.set(day, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, intact });
    return intact;
  }

  /** Lines of one day, oldest first, and whether the chain holds. */
  private readDay(day: string): { entries: TrailEntry[]; intact: boolean } {
    const verified = this.deps.mac('probe') !== undefined;
    let text: string;
    try {
      text = readFileSync(join(this.dir, `${day}.jsonl`), 'utf8');
    } catch (error) {
      // gone is fine; there but unreadable (too big, no permission) is reported, never silently empty
      return { entries: [], intact: (error as NodeJS.ErrnoException).code === 'ENOENT' };
    }
    const entries: TrailEntry[] = [];
    let intact = true;
    let prev = '';
    for (const line of text.split('\n')) {
      if (!line) continue;
      const tail = MAC_TAIL.exec(line);
      const body = tail ? `${line.slice(0, tail.index)}}` : line;
      if (verified) {
        const expected = this.deps.mac(`trail:${prev}:${body}`);
        if (!tail || tail[1] !== expected) intact = false;
        prev = tail?.[1] ?? '';
      }
      try {
        const { time: _time, ...entry } = JSON.parse(body) as TrailEntry & { time?: string };
        entries.push(entry);
      } catch {
        intact = false;
      }
    }
    return { entries, intact };
  }

  /**
   * Newest first. Agent requests show once, in their last state. `nextBefore` pages back; lines that share
   * the time of the last one stay on the same page, so none falls between pages.
   */
  list(q: TrailQuery): TrailPage {
    const now = this.deps.now();
    const days = Math.min(Math.max(1, Math.floor(q.days)), this.retentionDays());
    const from = now - days * DAY_MS;
    const before = q.before ?? Number.POSITIVE_INFINITY;
    const limit = Math.min(Math.max(1, Math.floor(q.limit)), 1000);
    const firstDay = dayOf(from);
    // a request lives minutes: one day past `before` is enough to know its last state
    const lastDay = Number.isFinite(before) ? dayOf(Math.min(before, now) + DAY_MS) : dayOf(now + DAY_MS);
    const text = q.text?.trim().toLowerCase();
    const out: TrailEntry[] = [];
    const tampered: string[] = [];
    const seen = new Set<string>();
    let nextBefore: number | undefined;
    let boundary: number | undefined;
    const names = this.files()
      .map((n) => FILE.exec(n)![1]!)
      .filter((d) => d >= firstDay && d <= lastDay)
      .reverse();
    outer: for (const day of names) {
      const { entries } = this.readDay(day);
      // newest first by time, not by place in the file: a clock that went back must not hide a line between pages
      for (const entry of entries.slice().reverse().sort((a, b) => b.ts - a.ts)) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        if (entry.ts >= before || entry.ts < from) continue;
        if (boundary !== undefined && entry.ts !== boundary) {
          nextBefore = boundary;
          break outer;
        }
        if (q.actor && entry.actor !== q.actor) continue;
        if (q.environmentId && entry.environmentId !== q.environmentId) continue;
        if (text) {
          const hay = [entry.sql, entry.reason, entry.client, entry.environment, entry.detail].filter(Boolean).join('\n').toLowerCase();
          if (!hay.includes(text)) continue;
        }
        out.push(entry);
        if (out.length >= limit && boundary === undefined) boundary = entry.ts;
      }
    }
    // every day of the period is checked, whether or not a line of it made it to this page
    for (const day of this.files().map((n) => FILE.exec(n)![1]!)) {
      if (day >= firstDay && !this.dayIntact(day)) tampered.push(day);
    }
    return {
      entries: out.sort((a, b) => b.ts - a.ts),
      ...(nextBefore !== undefined ? { nextBefore } : {}),
      tampered: [...new Set(tampered)].sort().reverse(),
      ...(this.firstFailure !== undefined
        ? { writeError: this.writeError(this.firstFailure) }
        : {}),
      verified: this.deps.mac('probe') !== undefined,
    };
  }

  /** Shown to the person in the trail panel, in the app locale. */
  private writeError(firstFailure: number): string {
    const at = fmt().formatDateTime(firstFailure);
    return this.healthy() ? m().trail.writeErrorRecovered({ at }) : m().trail.writeError({ at });
  }
}
