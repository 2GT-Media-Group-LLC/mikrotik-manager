import { AsyncLocalStorage } from 'async_hooks';

/**
 * Cancelling a poll that ran past its time limit (P2-15).
 *
 * The poller races each job against a timeout, but losing the race used to
 * stop nothing: the job was marked failed (device offline, alert, outage row)
 * while its work carried on, and when it finished it marked the device online
 * again, leaving an outage that was never closed.
 *
 * Every device session opened while a job runs registers here, so the timeout
 * can abort all of them. An aborted collector disconnects and refuses to
 * record the device as online.
 */

export interface Abortable {
  abort(): void;
}

interface JobContext {
  sessions: Set<Abortable>;
  aborted: boolean;
}

const storage = new AsyncLocalStorage<JobContext>();

/** Run `fn` as a poll job whose sessions `abortJob` can cancel. */
export function runPollJob<T>(fn: () => Promise<T>): { promise: Promise<T>; abortJob: () => void } {
  const ctx: JobContext = { sessions: new Set(), aborted: false };
  const promise = storage.run(ctx, fn);
  return {
    promise,
    abortJob: () => {
      ctx.aborted = true;
      for (const s of ctx.sessions) {
        try { s.abort(); } catch { /* already closed */ }
      }
    },
  };
}

/** Called by each device session as it is created. A no-op outside a poll job. */
export function registerPollSession(session: Abortable): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  ctx.sessions.add(session);
  // A session opened after the timeout fired is cancelled straight away.
  if (ctx.aborted) session.abort();
}

/** True inside a poll job that has been cancelled for running out of time. */
export function pollJobAborted(): boolean {
  return storage.getStore()?.aborted ?? false;
}
