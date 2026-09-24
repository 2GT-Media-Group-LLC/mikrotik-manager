/**
 * For text that ends up inside Leaflet popup/tooltip HTML. Device names, site
 * names and addresses are operator-entered, and Leaflet renders popup strings
 * as HTML.
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
