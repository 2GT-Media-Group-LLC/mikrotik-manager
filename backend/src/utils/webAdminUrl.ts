/**
 * Where the device's web interface (WebFig) answers (#335). The button used to
 * open http://<address>/ regardless, which goes nowhere once plain www is
 * turned off in favour of www-ssl (as the Security page recommends) or moved
 * to another port. HTTPS wins when it's on. Pure, so it can be tested.
 */
type Row = Record<string, string>;
const isTrue = (v: string | undefined) => v === 'true' || v === 'yes';

export interface WebAdmin {
  /** null when neither www nor www-ssl is enabled. */
  url: string | null;
  /** Says why there's no URL, or that HTTPS uses a certificate the browser may not trust. */
  note: string | null;
}

function serviceRow(services: Row[], name: string): Row | undefined {
  // Some builds list a service twice; the enabled row is the one that answers.
  const rows = services.filter((s) => s['name'] === name);
  return rows.find((s) => !isTrue(s['disabled'])) ?? rows[0];
}

export function webAdminUrl(host: string, services: Row[]): WebAdmin {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const ssl = serviceRow(services, 'www-ssl');
  const plain = serviceRow(services, 'www');
  if (ssl && !isTrue(ssl['disabled'])) {
    const port = parseInt(ssl['port'] || '443', 10) || 443;
    return {
      url: `https://${h}${port === 443 ? '' : `:${port}`}/`,
      note: ssl['certificate'] && ssl['certificate'] !== 'none' ? null : 'www-ssl is on but has no certificate, so HTTPS may not answer. The Security tab’s Switch to HTTPS sets one up.',
    };
  }
  if (plain && !isTrue(plain['disabled'])) {
    const port = parseInt(plain['port'] || '80', 10) || 80;
    return { url: `http://${h}${port === 80 ? '' : `:${port}`}/`, note: null };
  }
  return { url: null, note: 'The web interface (www and www-ssl) is turned off on this device.' };
}
