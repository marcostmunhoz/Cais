import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs, UsageError, MAX_SQL_BYTES, type Command, type SqlSource } from './args';
import { send, type Reply } from './client';
import { discoverEndpoint, PROTOCOL_MISMATCH_MESSAGE, UNAVAILABLE_MESSAGE } from './endpoint';
import { EXIT, exitForError, exitForResult } from './exit';
import { GUIDE } from './guide';
import { finalExitCode, guardPipe, writeTo } from './output';

// a reader that closes the pipe early (`| head`) is not an error: no stack trace, the computed exit code stands
guardPipe(process.stdout);
guardPipe(process.stderr);

function print(value: unknown): void {
  writeTo(process.stdout, JSON.stringify(value) + '\n');
}

function fail(message: string, code: string, exit: number, fields?: unknown): number {
  print({ error: message, code, ...(fields !== undefined ? { fields } : {}) });
  return exit;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > MAX_SQL_BYTES * 2) reject(new UsageError('The SQL is over 100 KB.', 'sql_too_large'));
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function loadSql(source: SqlSource): Promise<string> {
  let sql: string;
  if (source.kind === 'inline') sql = source.sql;
  else if (source.kind === 'stdin') sql = await readStdin();
  else {
    try {
      sql = readFileSync(source.path, 'utf8');
    } catch {
      throw new UsageError(`Could not read the file ${source.path}.`, 'file_unreadable');
    }
  }
  if (!sql.trim()) throw new UsageError('The SQL is empty.');
  if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) throw new UsageError('The SQL is over 100 KB.', 'sql_too_large');
  return sql;
}

async function toRequest(command: Command, client: string): Promise<{ method: string; params: Record<string, unknown> } | null> {
  switch (command.name) {
    case 'guide':
      return null;
    case 'envs':
      return { method: 'envs', params: {} };
    case 'schema':
      return {
        method: 'schema',
        params: { env: command.env, client, ...(command.database ? { database: command.database } : {}), ...(command.table ? { table: command.table } : {}) },
      };
    case 'query':
      return {
        method: 'query',
        params: {
          env: command.env,
          sql: await loadSql(command.sql),
          client,
          ...(command.write ? { write: true } : {}),
          ...(command.reason ? { reason: command.reason } : {}),
          ...(command.database ? { database: command.database } : {}),
          ...(command.maxRows ? { max_rows: command.maxRows } : {}),
          ...(command.wait ? { wait: true, timeout: command.timeout } : {}),
        },
      };
    case 'status':
      return { method: 'status', params: { id: command.id, ...(command.wait ? { wait: true, timeout: command.timeout } : {}) } };
    case 'requests':
      return { method: 'requests', params: { limit: command.limit } };
    case 'scripts':
      return { method: 'scripts', params: command.project ? { project: command.project } : {} };
    case 'script':
      return { method: 'script', params: { id: command.id } };
    case 'script-save':
      return {
        method: 'script_save',
        params: {
          project: command.project,
          name: command.scriptName,
          sql: await loadSql(command.sql),
          client,
          ...(command.database ? { database: command.database } : {}),
        },
      };
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv, process.env);
  } catch (error) {
    if (error instanceof UsageError) return fail(error.message, error.code, EXIT.usage);
    throw error;
  }
  if (parsed.command.name === 'guide') {
    writeTo(process.stdout, GUIDE);
    return EXIT.ok;
  }

  let request;
  try {
    request = await toRequest(parsed.command, parsed.client);
  } catch (error) {
    if (error instanceof UsageError) return fail(error.message, error.code, EXIT.usage);
    throw error;
  }
  if (!request) return EXIT.ok;

  const found = discoverEndpoint({ env: process.env, platform: process.platform, home: homedir(), readFile: readIfExists, pidAlive });
  if ('protocolMismatch' in found) {
    return fail(PROTOCOL_MISMATCH_MESSAGE, 'protocol_mismatch', EXIT.usage);
  }
  if ('unavailable' in found) return fail(UNAVAILABLE_MESSAGE, 'cais_unavailable', EXIT.unavailable);

  // a server that does not answer hello within 10 s counts as unavailable (the real request may then wait as long as it needs)
  const hello = await send(found.socket, 'hello', {}, 10_000);
  if (hello.kind === 'unavailable') return fail(UNAVAILABLE_MESSAGE, 'cais_unavailable', EXIT.unavailable);
  if (hello.kind === 'protocol') return fail(PROTOCOL_MISMATCH_MESSAGE, 'protocol_mismatch', EXIT.usage);

  const reply: Reply = await send(found.socket, request.method, request.params);
  switch (reply.kind) {
    case 'unavailable':
      return fail(UNAVAILABLE_MESSAGE, 'cais_unavailable', EXIT.unavailable);
    case 'protocol':
      return fail(PROTOCOL_MISMATCH_MESSAGE, 'protocol_mismatch', EXIT.usage);
    case 'error':
      return fail(reply.message, reply.code, exitForError(reply.code), reply.fields);
    case 'ok':
      print(reply.result);
      return request.method === 'query' || request.method === 'status' ? exitForResult(reply.result) : EXIT.ok;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = finalExitCode(code, process.stdout, process.stderr);
  },
  (error: unknown) => {
    process.exitCode = finalExitCode(fail(error instanceof Error ? error.message : String(error), 'internal_error', EXIT.failed), process.stdout, process.stderr);
  },
);
