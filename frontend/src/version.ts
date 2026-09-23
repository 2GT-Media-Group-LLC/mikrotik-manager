export const APP_VERSION = 'v0.24.22 Beta';

/**
 * Documentation for *this* build.
 *
 * The site is published per release series with mike, so a reader running
 * 0.24.x gets pages describing 0.24.x rather than whatever is newest. Deriving
 * the series from APP_VERSION keeps the in-app link honest as the product moves
 * on; falling back to `latest` covers a development build whose series has not
 * been published yet.
 */
const DOCS_BASE = 'https://2gt-media-group-llc.github.io/mikrotik-manager';

export function docsUrl(path = ''): string {
  const series = /v?(\d+\.\d+)/.exec(APP_VERSION)?.[1];
  const suffix = path.replace(/^\//, '');
  return `${DOCS_BASE}/${series ?? 'latest'}/${suffix}`;
}
