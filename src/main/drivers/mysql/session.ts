import type mysql from 'mysql2';
import type { SessionMode } from '@shared/model';
import type { CellValue, ColumnMeta, StatementResult } from '@shared/results';
import { m, ref } from '@shared/i18n';
import { CaisError } from '../../errors';
import { quoteIdent } from '@shared/dialects/mysql/literals';
import type { DbSession, DbSessionError, ExecuteOptions, MysqlConnectParams } from '../types';
import { DriverError } from '../types';
import { closeQuietly, connect, mysqlParams, query } from './connection';
import { mapMysqlError } from './errors';
import { columnMeta, toCell, type FieldLike } from './values';

const SERVER_STATUS_IN_TRANS = 0x0001;
const SERVER_STATUS_AUTOCOMMIT = 0x0002;
// built where they are used, so the text follows the app locale; the ref lets agents read them in English
const lostError = (): DbSessionError => ({ message: m().mainMisc.driver.lost, ref: ref('mainMisc.driver.lost'), fatal: true });
const cancelledError = (): DbSessionError => ({
  message: m().mainMisc.driver.cancelled,
  ref: ref('mainMisc.driver.cancelled'),
  code: 'CANCELLED',
});
/** sql_mode flags that change how the server splits strings and quotes: the classifier assumes neither is on. */
const LEXING_MODES = new Set(['NO_BACKSLASH_ESCAPES', 'ANSI_QUOTES', 'ANSI']);

interface Config {
  config: { charsetNumber: number };
}

interface Streamed {
  result: StatementResult;
  /** serverStatus of the OK packet, when the statement ended with one. */
  serverStatus?: number;
}

export class MysqlSession implements DbSession {
  private fatalCallbacks: ((err: DbSessionError) => void)[] = [];
  private fatalSent = false;
  private selectLimit: number | null = null;
  private running = false;
  private cancelRequested = false;
  private mode: SessionMode = 'autocommit';
  private pendingKill: Promise<void> | null = null;
  private dead: DbSessionError | null = null;
  private closing = false;
  private abort: ((info: DbSessionError) => void) | null = null;
  /** sql_mode pinned at applyMode (lexing flags removed), re-asserted with the read-only/transaction prelude. */
  private sqlMode: string | null = null;
  /** mysql2's client character set right after the app set utf8mb4: any change means someone ran SET NAMES. */
  private safeCharset: number | null = null;
  private limits: { maxExecutionMs?: number; lockWaitSeconds?: number } = {};
  /** An execute() is in progress (prelude, statement or transaction probe). */
  private executing = false;
  /**
   * Agent sessions: utf8mb4, the pinned sql_mode and the mode's autocommit are re-asserted before every
   * statement in every mode. The person's read-only tabs get the same; their Auto-commit and Transação tabs keep
   * their own session (sql_mode, SHOW WARNINGS, ROW_COUNT()).
   */
  private strict = false;
  /** The person's sql_mode before a read-only pin removed the string/quote flags: given back on leaving read-only. */
  private ownSqlMode: string | null = null;

  constructor(
    private readonly conn: mysql.Connection,
    private readonly params: MysqlConnectParams,
    readonly serverVersion: string,
    private readonly threadId: number,
  ) {
    const lost = (info: DbSessionError): void => {
      if (this.closing) return;
      this.dead ??= { ...info, fatal: true };
      this.reportFatal(this.dead);
      this.abort?.(this.dead);
    };
    conn.on('error', (error) => lost(this.map(error, false)));
    conn.on('end', () => lost(lostError()));
    conn.on('close', () => lost(lostError()));
  }

  private map(error: unknown, cancelled: boolean): DbSessionError {
    return mapMysqlError(error, {
      iam: this.params.authPlugin === 'mysql_clear_password',
      host: this.params.host,
      port: this.params.port,
      cancelled,
    });
  }

  private reportFatal(info: DbSessionError): void {
    if (this.fatalSent) return;
    this.fatalSent = true;
    for (const cb of this.fatalCallbacks) cb({ ...info, fatal: true });
  }

  onFatalError(cb: (err: DbSessionError) => void): void {
    this.fatalCallbacks.push(cb);
  }

  /**
   * One round trip that a lost connection (or destroy()) always ends: mysql2 may never settle a query on a
   * half-closed socket, so the abort hook rejects it.
   */
  private call(sql: string): Promise<{ rows: unknown[]; fields: mysql.FieldPacket[] }> {
    if (this.dead) return Promise.reject(new DriverError(this.dead.message, this.dead));
    return new Promise((resolve, reject) => {
      const hook = (info: DbSessionError): void => reject(new DriverError(info.message, info));
      this.abort = hook;
      query(this.conn, sql).then(resolve, reject).finally(() => {
        if (this.abort === hook) this.abort = null;
      });
    });
  }

  private async exec(sql: string): Promise<void> {
    if (this.dead) throw new DriverError(this.dead.message, this.dead);
    try {
      await this.call(sql);
    } catch (error) {
      if (error instanceof DriverError) throw error;
      const info = this.map(error, false);
      throw new DriverError(info.message, info);
    }
  }

  private get charsetNumber(): number {
    return (this.conn as unknown as Config).config.charsetNumber;
  }

  private get guarded(): boolean {
    return this.strict || this.mode === 'read-only';
  }

  /** The session's sql_mode without the flags that change string and quote rules. */
  private async pinnedSqlMode(): Promise<string> {
    if (this.dead) throw new DriverError(this.dead.message, this.dead);
    let current: string;
    try {
      const { rows } = await this.call('SELECT @@SESSION.sql_mode');
      current = String((rows[0] as unknown[] | undefined)?.[0] ?? '');
    } catch (error) {
      if (error instanceof DriverError) throw error;
      const info = this.map(error, false);
      throw new DriverError(info.message, info);
    }
    if (this.ownSqlMode === null && !this.strict) this.ownSqlMode = current;
    return current
      .split(',')
      .map((m) => m.trim().toUpperCase())
      .filter((m) => /^[A-Z_]+$/.test(m) && !LEXING_MODES.has(m))
      .join(',');
  }

  /**
   * Mode, plus the session rules the classifier relies on: utf8mb4 as the client character set and no
   * NO_BACKSLASH_ESCAPES / ANSI_QUOTES in sql_mode (the agents and read-only tabs cannot change either).
   */
  async applyMode(mode: SessionMode, opts: { strict?: boolean } = {}): Promise<void> {
    if (opts.strict) this.strict = true;
    this.mode = mode;
    let sqlMode = '';
    if (this.guarded) {
      this.sqlMode = await this.pinnedSqlMode();
      sqlMode = `, SESSION sql_mode = '${this.sqlMode}'`;
    } else {
      this.sqlMode = null;
      if (this.ownSqlMode !== null && /^[A-Z_,]*$/.test(this.ownSqlMode)) sqlMode = `, SESSION sql_mode = '${this.ownSqlMode}'`;
      this.ownSqlMode = null;
    }
    await this.exec(
      `SET NAMES utf8mb4${sqlMode}, SESSION transaction_read_only = ${mode === 'read-only' ? 1 : 0}, autocommit = ${mode === 'transaction' ? 0 : 1}`,
    );
    this.safeCharset = this.charsetNumber;
  }

  isAlive(): boolean {
    return !this.dead && !this.closing;
  }

  /** COM_RESET_CONNECTION, then mode and limits again (the reset brings back the server defaults). */
  async reset(): Promise<void> {
    await this.pendingKill;
    if (this.dead) throw new DriverError(this.dead.message, this.dead);
    await new Promise<void>((resolve, reject) => {
      (this.conn as unknown as { reset(cb: (error: unknown) => void): void }).reset((error) => {
        if (error) {
          const info = this.map(error, false);
          reject(new DriverError(info.message, info));
        } else resolve();
      });
    });
    this.selectLimit = null;
    await this.applyMode(this.mode, { strict: this.strict });
    await this.applyLimits(this.limits);
  }

  destroy(): void {
    this.dead ??= lostError();
    this.abort?.(this.dead);
    this.reportFatal(this.dead);
    this.closing = true;
    this.conn.destroy();
    // mysql2's destroy() only half-closes the socket: drop it for real
    (this.conn as unknown as { stream?: { destroy?: () => void } }).stream?.destroy?.();
  }

  async currentDatabase(): Promise<string | null> {
    const { rows } = await this.call('SELECT DATABASE()');
    const value = (rows[0] as unknown[] | undefined)?.[0];
    return value === null || value === undefined ? null : String(value);
  }

  async commit(): Promise<void> {
    await this.exec('COMMIT');
  }

  lastRollbackIncomplete = false;

  async rollback(): Promise<void> {
    await this.exec('ROLLBACK');
    // warning 1196: "Some non-transactional changed tables couldn't be rolled back"
    try {
      const { rows } = await this.call('SHOW WARNINGS');
      this.lastRollbackIncomplete = (rows as unknown[][]).some((r) => Number(r[1]) === 1196);
    } catch {
      this.lastRollbackIncomplete = false;
    }
  }

  async applyLimits(limits: { maxExecutionMs?: number; lockWaitSeconds?: number }): Promise<void> {
    this.limits = { ...this.limits, ...limits };
    const parts: string[] = [];
    if (limits.maxExecutionMs !== undefined) parts.push(`max_execution_time = ${Math.floor(limits.maxExecutionMs)}`);
    if (limits.lockWaitSeconds !== undefined) parts.push(`innodb_lock_wait_timeout = ${Math.floor(limits.lockWaitSeconds)}`);
    if (parts.length > 0) await this.exec(`SET SESSION ${parts.join(', ')}`);
  }

  async cancel(): Promise<void> {
    if (!this.executing) return;
    this.cancelRequested = true;
    // during the prelude or the probe there is nothing to kill: the statement will not start
    if (this.running) await this.kill();
  }

  /** Issues KILL QUERY and remembers it, so the next statement never starts before it finished. */
  private kill(): Promise<void> {
    const work = this.doKill();
    const tracked = work
      .catch(() => undefined)
      .then(() => {
        if (this.pendingKill === tracked) this.pendingKill = null;
      });
    this.pendingKill = tracked;
    return work;
  }

  private async doKill(): Promise<void> {
    let control: mysql.Connection | undefined;
    try {
      // an IAM token from open time may have expired: ask for fresh parameters
      const params = this.params.refresh ? mysqlParams(await this.params.refresh().catch(() => this.params)) : this.params;
      control = await connect({ ...params, database: undefined });
      await query(control, `KILL QUERY ${this.threadId}`);
    } catch (error) {
      const info = this.map(error, false);
      throw CaisError.of(ref('mainMisc.driver.cancelFailed', { message: info.message }));
    } finally {
      if (control) await closeQuietly(control);
    }
  }

  /** The server's own view: the status flags of an OK packet that changes nothing. Ends when the connection does. */
  private probeStatus(): Promise<number | undefined> {
    return new Promise((resolve) => {
      if (this.dead) return resolve(undefined);
      const hook = (): void => resolve(undefined);
      this.abort = hook;
      this.conn.query('SET @cais_tx_probe = 0', (error, result) => {
        if (this.abort === hook) this.abort = null;
        if (error) return resolve(undefined);
        resolve((result as { serverStatus?: number } | undefined)?.serverStatus);
      });
    });
  }

  async useDatabase(name: string): Promise<StatementResult> {
    return this.execute(`USE ${quoteIdent(name)}`, { maxRows: 1 });
  }

  /** `DO 0` changes nothing and reports the server's transaction flag in the OK packet. */
  async transactionProbe(): Promise<boolean | undefined> {
    const probe = await this.execute('DO 0', { maxRows: 1 }).catch(() => undefined);
    return probe?.inTransaction;
  }

  async execute(sql: string, opts: ExecuteOptions): Promise<StatementResult> {
    const started = performance.now();
    const base: StatementResult = { index: 0, sql, kind: 'other', verb: '', durationMs: 0 };
    const elapsed = (): number => Math.round(performance.now() - started);
    await this.pendingKill;
    if (this.dead) return { ...base, durationMs: elapsed(), error: this.dead };
    this.executing = true;
    this.cancelRequested = false;
    try {
      // Session settings are re-asserted before every statement: read-only can never be left off, a
      // transaction never turns into autocommit, and the client character set stays utf8mb4.
      const limit = opts.maxRows + 1;
      const settings: string[] = [];
      const guarded = this.guarded;
      if (guarded || this.charsetNumber !== this.safeCharset) settings.push('NAMES utf8mb4');
      if (guarded && this.sqlMode !== null) settings.push(`SESSION sql_mode = '${this.sqlMode}'`);
      if (this.selectLimit !== limit) settings.push(`SESSION sql_select_limit = ${limit}`);
      if (this.mode === 'read-only') settings.push('SESSION transaction_read_only = 1', 'SESSION autocommit = 1');
      if (this.mode === 'transaction' && this.strict) settings.push('SESSION autocommit = 0');
      if (settings.length > 0) {
        try {
          await this.call(`SET ${settings.join(', ')}`);
          this.selectLimit = limit;
          this.safeCharset = this.charsetNumber;
        } catch (error) {
          const info = error instanceof DriverError ? error.info : this.map(error, false);
          if (info.fatal) this.reportFatal(info);
          return { ...base, durationMs: elapsed(), error: info };
        }
      }
      if (this.cancelRequested) return { ...base, durationMs: elapsed(), error: cancelledError() };

      this.running = true;
      let streamed: Streamed;
      try {
        streamed = await this.stream(sql, opts.maxRows, started, base, opts.stopAtCap !== false);
        await this.pendingKill; // a KILL still in flight must not hit the probe or the next statement
      } finally {
        this.running = false;
      }
      const { result } = streamed;
      if (this.mode === 'transaction' && !result.error?.fatal) {
        const status = !result.columns && !result.error && streamed.serverStatus !== undefined ? streamed.serverStatus : await this.probeStatus();
        if (status !== undefined) {
          result.inTransaction = (status & SERVER_STATUS_IN_TRANS) !== 0;
          if ((status & SERVER_STATUS_AUTOCOMMIT) !== 0) {
            // Transação never turns into auto-commit: put it back and say what happened
            await this.call('SET SESSION autocommit = 0').catch(() => undefined);
            result.notice = m().mainMisc.driver.autocommitTurnedOn;
          }
        }
      } else if (this.mode === 'read-only' && !result.error?.fatal && streamed.serverStatus !== undefined && (streamed.serverStatus & SERVER_STATUS_IN_TRANS) !== 0) {
        // something opened a transaction in a read-only session (it would hold metadata locks): end it
        await this.call('ROLLBACK').catch(() => undefined);
      }
      return result;
    } finally {
      this.executing = false;
    }
  }

  private stream(sql: string, maxRows: number, started: number, base: StatementResult, stopAtCap: boolean): Promise<Streamed> {
    return new Promise((resolve) => {
      let columns: ColumnMeta[] | undefined;
      const rows: CellValue[][] = [];
      let received = 0;
      let truncated = false;
      let killedForCap = false;
      let ok: { affectedRows?: number; insertId?: number | string; warningStatus?: number; serverStatus?: number } | undefined;
      let done = false;

      const finish = (extra: Partial<StatementResult>): void => {
        if (done) return;
        done = true;
        this.abort = null;
        resolve({
          result: { ...base, durationMs: Math.round(performance.now() - started), ...extra },
          serverStatus: ok?.serverStatus,
        });
      };
      // an error emitted on the connection (not on the query) must still end this statement
      this.abort = (info) => finish({ error: info });

      const q = this.conn.query({ sql, rowsAsArray: true });
      q.on('fields', (fields: FieldLike[] | null, resultIndex?: number) => {
        // OK packets (no result set) report null fields
        if (fields && !resultIndex && !columns) {
          columns = fields.map(columnMeta);
        }
      });
      q.on('result', (row: unknown, resultIndex?: number) => {
        if (Array.isArray(row)) {
          if (resultIndex) return; // only the first result set is kept
          received++;
          if (received <= maxRows) {
            rows.push((row as unknown[]).map(toCell));
          } else {
            truncated = true;
            if (stopAtCap && received > maxRows + 1 && !killedForCap) {
              // the server is not limiting rows (explicit LIMIT): stop the query
              killedForCap = true;
              this.kill().catch(() => undefined);
            }
          }
        } else {
          ok = row as typeof ok;
        }
      });
      q.on('error', (error: unknown) => {
        const info = this.map(error, this.cancelRequested);
        if (killedForCap && (info.errno === 1317 || info.code === 'ER_QUERY_INTERRUPTED')) {
          finish({ columns, rows, truncated: true });
          return;
        }
        if (info.fatal) {
          this.dead ??= info;
          this.reportFatal(info);
        }
        finish({ error: info });
      });
      q.on('end', () => {
        if (columns) {
          if (this.cancelRequested && !killedForCap) {
            finish({ error: cancelledError() });
            return;
          }
          finish({ columns, rows, ...(truncated ? { truncated: true } : {}) });
          return;
        }
        finish({
          affectedRows: Number(ok?.affectedRows ?? 0),
          ...(ok?.insertId !== undefined && Number(ok.insertId) !== 0 ? { insertId: String(ok.insertId) } : {}),
          ...(ok?.warningStatus ? { warnings: ok.warningStatus } : {}),
        });
      });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await closeQuietly(this.conn);
  }
}

export async function openMysqlSession(params: MysqlConnectParams): Promise<MysqlSession> {
  let conn: mysql.Connection;
  try {
    conn = await connect(params);
  } catch (error) {
    const info = mapMysqlError(error, {
      iam: params.authPlugin === 'mysql_clear_password',
      host: params.host,
      port: params.port,
      cancelled: false,
    });
    throw new DriverError(info.message, info);
  }
  try {
    const { rows } = await query(conn, 'SELECT VERSION()');
    const version = String((rows[0] as unknown[])[0]);
    return new MysqlSession(conn, params, version, conn.threadId as number);
  } catch (error) {
    conn.destroy();
    const info = mapMysqlError(error, { iam: false, host: params.host, port: params.port, cancelled: false });
    throw new DriverError(info.message, info);
  }
}
