/**
 * The request-scoped switch behind "Review changes" (#255). While a preview
 * runs, RouterOS writes are recorded instead of sent and database writes are
 * skipped; see utils/changePreview.ts. Kept free of imports so the database
 * and RouterOS client modules can both read it without a cycle.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PreviewStep } from './changePreview';

export interface PreviewContext {
  steps: PreviewStep[];
  /** Change Guard's lockout prediction, when the route runs one. */
  verdict?: unknown;
  /** Database writes the request would have made; skipped. */
  skippedDbWrites: number;
}

const store = new AsyncLocalStorage<PreviewContext>();

/** The active preview, or undefined for an ordinary request. */
export function previewContext(): PreviewContext | undefined {
  return store.getStore();
}

export function runInPreview<T>(ctx: PreviewContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/** Run `fn` as an ordinary request, e.g. to write the audit log for a preview. */
export function outsidePreview<T>(fn: () => T): T {
  return store.exit(fn);
}
