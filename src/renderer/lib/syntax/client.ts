// The page's side of the syntax check: sends statements to the worker one at a time, answers from a cache when it has
// seen the text, drops what a newer pass made stale, and restarts a worker that stops answering.
import type { SyntaxIssue } from './mysql';

export interface SyntaxRequest {
  id: number;
  text: string;
}
export interface SyntaxReply {
  id: number;
  issues: SyntaxIssue[];
}

/** What the client needs of a Worker (a test passes a fake). */
export interface SyntaxWorkerLike {
  postMessage(message: SyntaxRequest): void;
  onmessage: ((e: { data: SyntaxReply }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  terminate(): void;
}

/**
 * The issues of one statement. A `signal` that aborts says the answer is no longer wanted: a text still waiting for the
 * worker is then dropped (and answered with "no issue", which the caller ignores).
 */
export type SyntaxCheck = (text: string, signal?: AbortSignal) => Promise<SyntaxIssue[]>;

const CACHE_SIZE = 300;
/** A statement the worker takes longer than this to read is given up on: the worker is restarted and the statement is not asked again. */
const TIMEOUT_MS = 10_000;

interface Job {
  id: number;
  text: string;
  resolve: (issues: SyntaxIssue[]) => void;
  /** Who is waiting for the answer; the job is dropped from the queue when every one of them has aborted. */
  signals: (AbortSignal | undefined)[];
  sent: boolean;
}

/**
 * The check of one engine's statements. The worker starts with the first statement; if it cannot start, or fails, the
 * client answers "no issue" from then on (the lint is a convenience, never a reason for an error on the page).
 * One text is checked once: the answer is kept for the most recent statements, so a script's untouched statements cost
 * nothing on the next keystroke. The worker reads one statement at a time and the time limit counts from the moment it
 * starts on it; one that overruns is restarted, and its statement is remembered as "no issue" so it does not hang the
 * worker again at the next pass.
 */
export function createSyntaxCheck(make: () => SyntaxWorkerLike, timeoutMs = TIMEOUT_MS): SyntaxCheck {
  let worker: SyntaxWorkerLike | null = null;
  let broken = false;
  let sequence = 0;
  const queue: Job[] = [];
  let inFlight: { job: Job; timer: ReturnType<typeof setTimeout> } | null = null;
  const cache = new Map<string, { answer: Promise<SyntaxIssue[]>; job: Job }>();

  const fail = (): void => {
    broken = true;
    worker?.terminate();
    worker = null;
    if (inFlight) {
      clearTimeout(inFlight.timer);
      inFlight.job.resolve([]);
      inFlight = null;
    }
    for (const job of queue.splice(0)) job.resolve([]);
    cache.clear();
  };

  const start = (): SyntaxWorkerLike | null => {
    if (broken) return null;
    if (worker) return worker;
    try {
      const w = make();
      w.onmessage = (e) => {
        if (!inFlight || e.data.id !== inFlight.job.id) return;
        clearTimeout(inFlight.timer);
        const { job } = inFlight;
        inFlight = null;
        job.resolve(e.data.issues);
        pump();
      };
      w.onerror = fail;
      worker = w;
    } catch {
      broken = true;
    }
    return worker;
  };

  const forget = (job: Job): void => {
    if (cache.get(job.text)?.job === job) cache.delete(job.text);
  };

  /** Drops the queued texts nobody waits for any more. */
  const sweep = (): void => {
    for (let i = queue.length - 1; i >= 0; i--) {
      const job = queue[i]!;
      if (job.signals.every((s) => s?.aborted)) {
        queue.splice(i, 1);
        forget(job);
        job.resolve([]);
      }
    }
  };

  const timedOut = (job: Job): void => {
    inFlight = null;
    job.resolve([]);
    worker?.terminate();
    worker = null;
    pump();
  };

  function pump(): void {
    if (inFlight) return;
    sweep();
    const job = queue.shift();
    if (!job) return;
    const w = start();
    if (!w) {
      fail();
      job.resolve([]);
      return;
    }
    job.sent = true;
    inFlight = { job, timer: setTimeout(() => timedOut(job), timeoutMs) };
    try {
      w.postMessage({ id: job.id, text: job.text });
    } catch {
      fail();
    }
  }

  return (text, signal) => {
    if (broken) return Promise.resolve([]);
    const hit = cache.get(text);
    if (hit) {
      // most recent last
      cache.delete(text);
      cache.set(text, hit);
      if (!hit.job.sent) hit.job.signals.push(signal);
      signal?.addEventListener('abort', sweep, { once: true });
      return hit.answer;
    }
    let job!: Job;
    const answer = new Promise<SyntaxIssue[]>((resolve) => {
      job = { id: ++sequence, text, resolve, signals: [signal], sent: false };
    });
    cache.set(text, { answer, job });
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    queue.push(job);
    signal?.addEventListener('abort', sweep, { once: true });
    pump();
    return answer;
  };
}
