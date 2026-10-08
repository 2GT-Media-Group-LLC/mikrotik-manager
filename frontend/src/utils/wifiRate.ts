/**
 * A Wi-Fi link rate for display (#252). The API sends bits per second (BIGINT
 * can arrive as a string).
 */
export function formatRate(bps: number | string | null | undefined): string | null {
  const n = Number(bps);
  if (bps == null || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} Gbps`;
  const mbps = n / 1e6;
  return `${mbps >= 100 ? Math.round(mbps) : Math.round(mbps * 10) / 10} Mbps`;
}

/** "TX 577 / RX 721 Mbps", or null when neither is known. */
export function formatRatePair(tx: number | string | null | undefined, rx: number | string | null | undefined): string | null {
  const t = formatRate(tx);
  const r = formatRate(rx);
  if (!t && !r) return null;
  return `TX ${t ?? '—'} / RX ${r ?? '—'}`;
}
