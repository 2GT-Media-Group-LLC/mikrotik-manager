/**
 * Device operations that can take minutes, answered in a way no proxy can cut
 * short (#417).
 *
 * Switching to API-SSL or WebFig over HTTPS may create and sign a certificate
 * on the device, which on a small or older router takes well over a minute.
 * A reverse proxy in front of the manager (Cloudflare gives up after 100s)
 * then dropped the request and showed its own 502 while the switch carried on
 * unseen. Now the request waits a short while; an operation that finishes in
 * that time is answered as before, and one that doesn't is answered "still
 * running" (202) and carries on, with its outcome kept here for the page to
 * fetch.
 *
 * Kept in memory: the backend is one process, and an outcome only has to
 * outlive the page that is waiting for it. After a restart the page is told
 * the manager has no record and to check the device again.
 */
import type { Response } from 'express';

export type TaskView<T> =
  | { status: 'running'; started_at: string }
  | { status: 'done'; result: T }
  | { status: 'failed'; http_status: number; error: string };

export interface TaskFailure { httpStatus: number; error: string }

interface Entry { view: TaskView<unknown>; settled: Promise<void> }

const tasks = new Map<string, Entry>();

/** How long a finished task's outcome is kept for the page to fetch. */
const KEEP_MS = 15 * 60_000;
/** How long a request waits for the task before answering "still running". */
export const ANSWER_WITHIN_MS = 25_000;

/** What the page sees for `key`, or null when the manager has no record of it. */
export function taskView(key: string): TaskView<unknown> | null {
  return tasks.get(key)?.view ?? null;
}

/**
 * Start `run` under `key` and answer the request: with its outcome if it
 * settles within `waitMs`, otherwise 202 and `stillRunning`. `detach` is
 * called only in the second case, before answering; it returns the function
 * to call once the task has settled (to release the device's lock).
 */
export async function answerWithTask<T>(
  res: Response,
  key: string,
  run: () => Promise<T>,
  opts: {
    failure: (err: unknown) => TaskFailure;
    stillRunning: Record<string, unknown>;
    detach?: () => () => void;
    onSettled?: () => void;
    waitMs?: number;
  },
): Promise<void> {
  const entry: Entry = { view: { status: 'running', started_at: new Date().toISOString() }, settled: Promise.resolve() };
  let afterSettle: (() => void) | undefined;
  let finished = false;
  entry.settled = run().then(
    (result) => { entry.view = { status: 'done', result }; },
    (err) => {
      const f = opts.failure(err);
      entry.view = { status: 'failed', http_status: f.httpStatus, error: f.error };
    },
  ).finally(() => {
    finished = true;
    opts.onSettled?.();
    afterSettle?.();
    setTimeout(() => { if (tasks.get(key) === entry) tasks.delete(key); }, KEEP_MS).unref();
  });
  tasks.set(key, entry);

  let timer: NodeJS.Timeout | undefined;
  const inTime = await Promise.race([
    entry.settled.then(() => true),
    new Promise<false>((r) => { timer = setTimeout(() => r(false), opts.waitMs ?? ANSWER_WITHIN_MS); }),
  ]);
  clearTimeout(timer);

  if (!inTime) {
    // Taken before answering, so the device stays locked while the work goes on.
    afterSettle = opts.detach?.();
    // It may have settled in the moment between the wait ending and the detach.
    if (finished) afterSettle?.();
    res.status(202).json({ status: 'running', ...opts.stillRunning });
    return;
  }
  const view = entry.view;
  if (view.status === 'done') res.json(view.result);
  else if (view.status === 'failed') res.status(view.http_status).json({ error: view.error });
}

/** Answer a status request for `key`: the outcome, "running", or 404 when there is no record. */
export function answerTaskStatus(res: Response, key: string, what: string): void {
  const view = taskView(key);
  if (!view) {
    res.status(404).json({
      error: `The manager has no record of ${what} on this device: it may have restarted. Check the device again.`,
    });
    return;
  }
  res.json(view);
}

/** For tests. */
export function clearTasksForTest(): void {
  tasks.clear();
}
