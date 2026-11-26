// Argument parsing for `cais llm ...`. No dependencies: the bundled CLI only needs Node's own modules.

export class UsageError extends Error {
  constructor(
    message: string,
    public readonly code = 'usage',
  ) {
    super(message);
    this.name = 'UsageError';
  }
}

export const MAX_SQL_BYTES = 100 * 1024;

export type Command =
  | { name: 'guide' }
  | { name: 'envs' }
  | { name: 'schema'; env: string; database?: string; table?: string }
  | {
      name: 'query';
      env: string;
      sql: SqlSource;
      write: boolean;
      reason?: string;
      database?: string;
      maxRows?: number;
      wait: boolean;
      timeout: number;
    }
  | { name: 'status'; id: string; wait: boolean; timeout: number }
  | { name: 'requests'; limit: number }
  | { name: 'scripts'; project?: string }
  | { name: 'script'; id: string }
  | { name: 'script-save'; project: string; scriptName: string; sql: SqlSource; database?: string };

export type SqlSource = { kind: 'inline'; sql: string } | { kind: 'file'; path: string } | { kind: 'stdin' };

export interface Parsed {
  command: Command;
  client: string;
}

const VALUE_FLAGS = new Set([
  '--sql', '--file', '--reason', '--database', '--max-rows', '--timeout', '--client', '--limit', '--project', '--name', '--table',
]);
const BOOL_FLAGS = new Set(['--write', '--wait']);

const ALLOWED: Record<string, { flags: string[]; positionals: number }> = {
  guide: { flags: ['--client'], positionals: 0 },
  envs: { flags: ['--client'], positionals: 0 },
  schema: { flags: ['--database', '--table', '--client'], positionals: 1 },
  query: { flags: ['--sql', '--file', '--write', '--reason', '--database', '--max-rows', '--wait', '--timeout', '--client'], positionals: 1 },
  status: { flags: ['--wait', '--timeout', '--client'], positionals: 1 },
  requests: { flags: ['--limit', '--client'], positionals: 0 },
  scripts: { flags: ['--project', '--client'], positionals: 0 },
  script: { flags: ['--client'], positionals: 1 },
  'script-save': { flags: ['--project', '--name', '--sql', '--file', '--database', '--client'], positionals: 0 },
};

function integer(flag: string, raw: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new UsageError(`${flag} needs a whole number.`);
  const n = Number(raw);
  if (n < min || n > max) throw new UsageError(`${flag} must be between ${min} and ${max}.`);
  return n;
}

/** `argv` is what comes after the script name: `["llm", "query", "loja/dev", "--sql", "SELECT 1"]`. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = {}): Parsed {
  if (argv[0] !== 'llm') throw new UsageError('Usage: cais llm <command>. Run "cais llm guide" to see the flow.');
  const sub = argv[1];
  if (!sub || !Object.hasOwn(ALLOWED, sub)) {
    throw new UsageError(`Unknown command${sub ? `: ${sub}` : ''}. Run "cais llm guide" to see the commands.`);
  }
  const spec = ALLOWED[sub]!;
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let stdin = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-') {
      stdin = true;
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const flag = eq === -1 ? arg : arg.slice(0, eq);
      if (!spec.flags.includes(flag)) throw new UsageError(`Unknown option for ${sub}: ${flag}`);
      if (BOOL_FLAGS.has(flag)) {
        if (eq !== -1) throw new UsageError(`${flag} takes no value.`);
        flags.set(flag, true);
      } else if (VALUE_FLAGS.has(flag)) {
        let value: string | undefined;
        if (eq !== -1) value = arg.slice(eq + 1);
        else {
          value = argv[++i];
          if (value === undefined) throw new UsageError(`${flag} needs a value.`);
        }
        if (flags.has(flag)) throw new UsageError(`${flag} was given twice.`);
        flags.set(flag, value);
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== spec.positionals) {
    throw new UsageError(
      spec.positionals === 0 ? `${sub} takes no arguments.` : `${sub} needs ${spec.positionals} argument${spec.positionals > 1 ? 's' : ''}.`,
    );
  }
  const str = (flag: string): string | undefined => {
    const v = flags.get(flag);
    return typeof v === 'string' ? v : undefined;
  };
  const bool = (flag: string): boolean => flags.get(flag) === true;
  const client = (str('--client') ?? env.CAIS_CLIENT ?? '').trim() || 'agente';

  const sqlSource = (): SqlSource => {
    const sources = [flags.has('--sql'), flags.has('--file'), stdin].filter(Boolean).length;
    if (sources !== 1) throw new UsageError('Give the SQL with exactly one option: --sql, --file or - (standard input).');
    if (stdin) return { kind: 'stdin' };
    if (flags.has('--file')) return { kind: 'file', path: str('--file')! };
    const sql = str('--sql')!;
    if (!sql.trim()) throw new UsageError('The SQL is empty.');
    return { kind: 'inline', sql };
  };
  if (stdin && !(sub === 'query' || sub === 'script-save')) throw new UsageError('Standard input (-) only works with query and script-save.');
  const required = (flag: string): string => {
    const v = str(flag);
    if (!v?.trim()) throw new UsageError(`${flag} is required.`);
    return v;
  };
  const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [key]: value } as { [P in K]: V }));

  let command: Command;
  switch (sub) {
    case 'guide':
      command = { name: 'guide' };
      break;
    case 'envs':
      command = { name: 'envs' };
      break;
    case 'schema':
      command = { name: 'schema', env: positionals[0]!, ...opt('database', str('--database')), ...opt('table', str('--table')) };
      break;
    case 'query':
      command = {
        name: 'query',
        env: positionals[0]!,
        sql: sqlSource(),
        write: bool('--write'),
        wait: bool('--wait'),
        timeout: str('--timeout') ? integer('--timeout', str('--timeout')!, 1, 3600) : 600,
        ...opt('reason', str('--reason')),
        ...opt('database', str('--database')),
        ...opt('maxRows', str('--max-rows') ? integer('--max-rows', str('--max-rows')!, 1, 1000) : undefined),
      };
      break;
    case 'status':
      command = {
        name: 'status',
        id: positionals[0]!,
        wait: bool('--wait'),
        timeout: str('--timeout') ? integer('--timeout', str('--timeout')!, 1, 3600) : 600,
      };
      break;
    case 'requests':
      command = { name: 'requests', limit: str('--limit') ? integer('--limit', str('--limit')!, 1, 100) : 20 };
      break;
    case 'scripts':
      command = { name: 'scripts', ...opt('project', str('--project')) };
      break;
    case 'script':
      command = { name: 'script', id: positionals[0]! };
      break;
    default:
      command = {
        name: 'script-save',
        project: required('--project'),
        scriptName: required('--name'),
        sql: sqlSource(),
        ...opt('database', str('--database')),
      };
  }
  return { command, client };
}
