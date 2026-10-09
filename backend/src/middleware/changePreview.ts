import type { Request, Response, NextFunction } from 'express';
import { runInPreview, type PreviewContext } from '../utils/previewContext';
import { isPreviewableRoute } from '../utils/changePreview';

/** Header the "Review changes" button sends (#255). */
export const PREVIEW_HEADER = 'x-preview-changes';

export function isPreviewRequest(req: Request): boolean {
  return req.method !== 'GET' && req.get(PREVIEW_HEADER) === '1';
}

/**
 * "Review changes" (#255): run an edit request without applying it.
 *
 * The request runs through its normal route, so validation, lookups and
 * Change Guard's prediction all happen as they would for real, but every
 * RouterOS write is recorded instead of sent and database writes are skipped.
 * The route's reply is replaced with what was recorded. An error reply (bad
 * input, device unreachable) passes through unchanged.
 */
export function changePreview(req: Request, res: Response, next: NextFunction): void {
  if (!isPreviewRequest(req)) { next(); return; }
  if (!isPreviewableRoute(req.method, req.originalUrl)) {
    res.status(400).json({ error: 'This action can\'t be previewed', code: 'preview_unsupported' });
    return;
  }
  const ctx: PreviewContext = { steps: [], skippedDbWrites: 0 };
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode >= 400) return json(body);
    res.status(200);
    return json({
      preview: {
        steps: ctx.steps,
        verdict: ctx.verdict ?? null,
        // The route's own message ("VLAN added") would read as if it had happened.
      },
    });
  };
  runInPreview(ctx, next);
}
