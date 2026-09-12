/**
 * Reading RouterOS's `/system/package/update` status field.
 *
 * This exists because of a substring match that rebooted devices mid-upgrade.
 * The orchestrator tested completion with `/downloaded/i`, and RouterOS reports
 * progress as:
 *
 *     Downloaded 0% (0.1MiB)
 *     Downloaded 86% (11.6MiB)
 *
 * both of which match. Captured on hardware, a poll six seconds into a download
 * returned "Downloaded 86% (11.6MiB)" — enough for the orchestrator to call the
 * download finished and restart the device with an incomplete image. It then
 * came back on the old firmware and was reported as "rebooted but still reports
 * X — the update did not apply", which was true, and was our doing.
 *
 * Completion is one specific string; progress merely starts with the same word.
 * Every literal below was observed on a real device rather than guessed.
 */

export type UpdateState =
  /** Actively fetching: percentages, "calculating download size...", "getting changelog...". */
  | 'downloading'
  /** The image is on the device and it is waiting to be restarted. */
  | 'downloaded'
  /** An update exists but has not been fetched. */
  | 'available'
  | 'up-to-date'
  /** The device reported a failure; `message` carries its wording. */
  | 'error'
  /** Nothing usable — an empty status, or one this does not recognise. */
  | 'unknown';

export interface UpdateStatus {
  state: UpdateState;
  /** Download percentage where the device reported one. */
  percent: number | null;
  /** Megabytes fetched so far, where reported. */
  mib: number | null;
  /** The raw status, for logs and error messages. */
  message: string;
}

/**
 * Order matters. "Downloaded 86% (11.6MiB)" and "Downloaded, please reboot
 * router to upgrade it" both begin with the same word, so progress is matched
 * first and completion is required to name the reboot.
 */
export function parseUpdateStatus(raw: string | null | undefined): UpdateStatus {
  const message = (raw || '').trim();
  const none = { percent: null, mib: null, message };

  if (!message) return { state: 'unknown', ...none };

  // "Downloaded 86% (11.6MiB)" — in progress, despite the leading word.
  const progress = /^downloaded\s+(\d+(?:\.\d+)?)\s*%(?:\s*\(([\d.]+)\s*MiB\))?/i.exec(message);
  if (progress) {
    return {
      state: 'downloading',
      percent: Number(progress[1]),
      mib: progress[2] !== undefined ? Number(progress[2]) : null,
      message,
    };
  }

  // Completion has to say so. Requiring the reboot wording keeps it from ever
  // matching a percentage line.
  if (/^downloaded\b/i.test(message) && /reboot/i.test(message)) {
    return { state: 'downloaded', ...none };
  }

  if (/\b(error|failed|failure)\b/i.test(message)) return { state: 'error', ...none };

  if (/calculating|getting changelog|downloading|connecting/i.test(message)) {
    return { state: 'downloading', ...none };
  }

  if (/already up to date|no updates? available/i.test(message)) {
    return { state: 'up-to-date', ...none };
  }

  if (/new version is available|update is available/i.test(message)) {
    return { state: 'available', ...none };
  }

  return { state: 'unknown', ...none };
}

/**
 * A short, human phrase for a status, for logs and the rollout row.
 *
 * The operator's complaint was that a stuck download is indistinguishable from a
 * working one. A percentage that stops moving is the difference.
 */
export function describeUpdateStatus(s: UpdateStatus): string {
  switch (s.state) {
    case 'downloading':
      return s.percent != null
        ? `downloading ${s.percent}%${s.mib != null ? ` (${s.mib} MiB)` : ''}`
        : `downloading — ${s.message}`;
    case 'downloaded': return 'downloaded, awaiting reboot';
    case 'available': return 'update available, not yet downloaded';
    case 'up-to-date': return 'already up to date';
    case 'error': return `device reported: ${s.message}`;
    default: return s.message ? `unrecognised status: ${s.message}` : 'no status reported';
  }
}

/**
 * The most advanced status from the sentences a long-running command streamed.
 *
 * `/system/package/update/download` returns one row per progress update — around
 * seventy for a full image — and the last is the outcome. Reading them removes
 * the need to guess from polling afterwards, and gives the progress the UI never
 * had.
 */
export function latestFromStream(rows: Record<string, string>[]): UpdateStatus {
  if (!rows.length) return parseUpdateStatus('');
  for (let i = rows.length - 1; i >= 0; i--) {
    const s = parseUpdateStatus(rows[i]['status']);
    if (s.state !== 'unknown') return s;
  }
  return parseUpdateStatus(rows[rows.length - 1]['status']);
}

/** Peak percentage seen in a stream, so a partial download can say how far it got. */
export function peakPercent(rows: Record<string, string>[]): number | null {
  let peak: number | null = null;
  for (const r of rows) {
    const s = parseUpdateStatus(r['status']);
    if (s.percent != null && (peak == null || s.percent > peak)) peak = s.percent;
  }
  return peak;
}
