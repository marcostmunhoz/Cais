import { EXIT } from './exit';

/** The part of a writable stream the guard needs (process.stdout, process.stderr, or a fake in tests). */
export interface GuardedStream {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  write(chunk: string): unknown;
  readonly destroyed?: boolean;
}

/** What the guard saw on one stream. */
export interface PipeState {
  /** The reader went away (or the stream broke): nothing more is written to it. */
  closed: boolean;
  /** An error other than a closed pipe: the run ends with EXIT.failed. */
  failed: boolean;
}

/** The reader closed the pipe early (`cais llm schema … | head`), or a write came after that. */
const CLOSED_PIPE = new Set(['EPIPE', 'ERR_STREAM_DESTROYED']);

const states = new WeakMap<object, PipeState>();

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Handles 'error' on an output stream so a closed pipe never crashes the CLI with Node's stack trace.
 * EPIPE and ERR_STREAM_DESTROYED are ignored and the exit code the command computed stands. Any other error marks
 * the run as failed (exit 1) without writing anything. Never calls process.exit(), so a large reply still flushes.
 */
export function guardPipe(
  stream: GuardedStream,
  onFailure: () => void = () => {
    process.exitCode = EXIT.failed;
  },
): PipeState {
  const existing = states.get(stream);
  if (existing) return existing;
  const state: PipeState = { closed: false, failed: false };
  states.set(stream, state);
  stream.on('error', (error) => {
    state.closed = true;
    if (CLOSED_PIPE.has(errorCode(error) ?? '')) return;
    state.failed = true;
    onFailure();
  });
  return state;
}

/** Writes to a guarded stream, unless the pipe is already closed. */
export function writeTo(stream: GuardedStream, text: string): void {
  if (states.get(stream)?.closed || stream.destroyed) return;
  stream.write(text);
}

/** The exit code to keep: the command's own, unless an output stream broke with something other than a closed pipe. */
export function finalExitCode(code: number, ...streams: GuardedStream[]): number {
  return streams.some((s) => states.get(s)?.failed) ? EXIT.failed : code;
}
