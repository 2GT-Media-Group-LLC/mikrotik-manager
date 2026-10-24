/**
 * Escape text for HTML element content and quoted attributes. Alert and report
 * emails carry device names, log lines and client hostnames, which come from
 * devices and from anyone on the network (a DHCP hostname), so they must be
 * text, never markup (GHSA-28hr-v457-cc6g).
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
