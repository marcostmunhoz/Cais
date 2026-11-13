import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { dirname } from 'node:path';
import { z } from 'zod';
import { AGENT_MAX_ROWS, AGENT_PROTOCOL, MAX_MESSAGE_BYTES, MAX_SQL_BYTES } from '@shared/agents';
import { writeFileAtomic } from '../store/atomic';
import { ref } from '@shared/i18n';
import { AgentError, agentText } from './errors';
import type { AgentBroker } from './broker';

const text = (max: number) => z.string().min(1).max(max);
const optText = (max: number) => z.string().max(max).optional();

const envelope = z.object({
  id: z.union([z.string().max(100), z.number()]),
  method: z.string().max(40),
  params: z.unknown().optional(),
});

const schemas = {
  hello: z.object({}).strict(),
  envs: z.object({}).strict(),
  schema: z.object({ env: text(200), database: optText(200), table: optText(200), client: optText(100) }).strict(),
  query: z
    .object({
      env: text(200),
      sql: z.string().min(1).max(MAX_SQL_BYTES),
      write: z.boolean().optional(),
      reason: optText(1000),
      database: optText(200),
      max_rows: z.number().int().min(1).max(AGENT_MAX_ROWS).optional(),
      wait: z.boolean().optional(),
      timeout: z.number().int().min(1).max(3600).optional(),
      client: optText(100),
    })
    .strict(),
  status: z.object({ id: text(100), wait: z.boolean().optional(), timeout: z.number().int().min(1).max(3600).optional() }).strict(),
  requests: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict(),
  scripts: z.object({ project: optText(200) }).strict(),
  script: z.object({ id: text(100) }).strict(),
  script_save: z
    .object({
      project: text(200),
      name: text(1000),
      sql: z.string().min(1).max(MAX_SQL_BYTES),
      database: optText(200),
      client: optText(100),
    })
    .strict(),
} as const;

type Method = keyof typeof schemas;

export interface ServerDeps {
  broker: AgentBroker;
  socketPath: string;
  endpointPath: string;
  platform: NodeJS.Platform;
  pid: number;
  appVersion: string;
  log?(message: string): void;
}

const MAX_CONNECTIONS = 32;
/** A connection that sends nothing for this long is dropped (the CLI sends its message at once). */
const IDLE_TIMEOUT_MS = 5_000;

function probe(path: string): Promise<'alive' | 'dead'> {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('alive'); // does not answer in time: assume somebody owns it, never delete
    }, 800);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve('alive');
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve('dead');
    });
  });
}

/** The local socket the CLI talks to. It exists only while agent access is on. */
export class AgentServer {
  private server: net.Server | null = null;
  /** What this instance created: stop() removes only these, never a file it did not make. */
  private createdSocket = false;
  private createdEndpoint = false;
  private readonly connections = new Set<net.Socket>();

  constructor(private readonly deps: ServerDeps) {}

  isListening(): boolean {
    return this.server !== null;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const { socketPath, platform } = this.deps;
    const unix = platform !== 'win32';
    if (unix) {
      mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
      await this.clearStaleSocket(socketPath);
    }
    const server = net.createServer((socket) => this.onConnection(socket));
    server.maxConnections = MAX_CONNECTIONS;
    // the socket file is created with the process umask: make it owner-only from the first instant
    const previousUmask = unix ? process.umask(0o177) : undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } finally {
      if (previousUmask !== undefined) process.umask(previousUmask);
    }
    this.createdSocket = unix;
    if (unix) chmodSync(socketPath, 0o600);
    server.on('error', (error) => this.deps.log?.(`agent socket error: ${error.message}`));
    this.server = server;
    await writeFileAtomic(
      this.deps.endpointPath,
      JSON.stringify({ socket: socketPath, pid: this.deps.pid, protocol: AGENT_PROTOCOL }, null, 2),
    );
    this.createdEndpoint = true;
  }

  private async clearStaleSocket(path: string): Promise<void> {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return; // nothing there
    }
    if (!stat.isSocket()) throw new AgentError(ref('agentsUi.error.socketPathTaken'), 'socket_path_taken');
    if ((await probe(path)) === 'alive') {
      throw new AgentError(ref('agentsUi.error.socketInUse'), 'socket_in_use');
    }
    unlinkSync(path);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.createdSocket) {
      this.createdSocket = false;
      try {
        unlinkSync(this.deps.socketPath);
      } catch {
        // already gone
      }
    }
    if (this.createdEndpoint) {
      this.createdEndpoint = false;
      try {
        unlinkSync(this.deps.endpointPath);
      } catch {
        // already gone
      }
    }
  }

  private onConnection(socket: net.Socket): void {
    this.connections.add(socket);
    const abort = new AbortController();
    let buffer = '';
    let bytes = 0;
    let chain: Promise<void> = Promise.resolve();
    socket.setEncoding('utf8');
    socket.setTimeout(IDLE_TIMEOUT_MS);
    socket.on('timeout', () => socket.destroy()); // one handler for the life of the connection
    socket.on('close', () => {
      this.connections.delete(socket);
      abort.abort();
    });
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        bytes = Buffer.byteLength(buffer, 'utf8');
        if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) return this.tooLarge(socket);
        // requests on one connection run in order; the idle timeout is off while one is being served
        socket.setTimeout(0);
        chain = chain.then(async () => {
          const reply = await this.handleLine(line, abort.signal);
          if (!socket.destroyed) socket.write(JSON.stringify(reply) + '\n');
          socket.setTimeout(IDLE_TIMEOUT_MS);
        });
        newline = buffer.indexOf('\n');
      }
      if (bytes > MAX_MESSAGE_BYTES) this.tooLarge(socket);
    });
  }

  // Replies to the CLI are agent-facing: their text is fixed pt-BR whatever the app locale.
  private tooLarge(socket: net.Socket): void {
    const reply = { id: null, ok: false, protocol: AGENT_PROTOCOL, error: { code: 'message_too_large', message: 'A mensagem passa de 1 MB.' } };
    socket.end(JSON.stringify(reply) + '\n');
  }

  private async handleLine(line: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    let id: string | number | null = null;
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new AgentError('A mensagem não é um JSON válido.', 'invalid_json');
      }
      const env = envelope.parse(raw);
      id = env.id;
      const method = env.method as Method;
      if (!Object.hasOwn(schemas, method)) throw new AgentError('Método desconhecido.', 'unknown_method');
      const params = schemas[method].parse(env.params ?? {}) as Record<string, never>;
      const result = await this.dispatch(method, params, signal);
      return { id, ok: true, protocol: AGENT_PROTOCOL, result };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          id,
          ok: false,
          protocol: AGENT_PROTOCOL,
          error: {
            code: 'invalid_params',
            message: 'Os parâmetros do pedido são inválidos.',
            fields: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
        };
      }
      if (error instanceof AgentError) {
        return {
          id,
          ok: false,
          protocol: AGENT_PROTOCOL,
          // the agent reads fixed pt-BR whatever the app locale
          error: { code: error.code, message: agentText(error), ...(error.fields ? { fields: error.fields } : {}) },
        };
      }
      this.deps.log?.(`agent request failed: ${error instanceof Error ? error.message : String(error)}`);
      return { id, ok: false, protocol: AGENT_PROTOCOL, error: { code: 'internal_error', message: 'Erro interno do Cais.' } };
    }
  }

  private async dispatch(method: Method, p: Record<string, any>, signal: AbortSignal): Promise<unknown> {
    const { broker } = this.deps;
    switch (method) {
      case 'hello':
        return { protocol: AGENT_PROTOCOL, app_version: this.deps.appVersion };
      case 'envs':
        return broker.envs();
      case 'schema':
        return broker.schema({ env: p.env, database: p.database, table: p.table, client: p.client });
      case 'query':
        return broker.query({
          env: p.env,
          sql: p.sql,
          write: p.write === true,
          reason: p.reason,
          database: p.database,
          maxRows: p.max_rows,
          wait: p.wait === true,
          timeoutS: p.timeout,
          client: p.client,
          signal,
        });
      case 'status':
        return broker.status({ id: p.id, wait: p.wait === true, timeoutS: p.timeout, signal });
      case 'requests':
        return broker.requests(p.limit ?? 20);
      case 'scripts':
        return broker.scripts(p.project);
      case 'script':
        return broker.script(p.id);
      case 'script_save':
        return broker.scriptSave({ project: p.project, name: p.name, sql: p.sql, database: p.database, client: p.client });
    }
  }
}

/** Where the socket lives: `<userData>/agent.sock`, a short tmp path when that is too long, a named pipe on Windows. */
export function socketPathFor(opts: {
  userData: string;
  platform: NodeJS.Platform;
  uid: number;
  username: string;
  tmpdir: string;
  override?: string;
}): string {
  if (opts.override) return opts.override;
  if (opts.platform === 'win32') return `\\\\.\\pipe\\cais-${opts.username}`;
  const preferred = `${opts.userData}/agent.sock`;
  if (Buffer.byteLength(preferred, 'utf8') <= 100) return preferred;
  return `${opts.tmpdir}/cais-${opts.uid}.sock`;
}
