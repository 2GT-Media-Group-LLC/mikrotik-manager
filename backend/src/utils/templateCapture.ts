/**
 * A command template captured from a configured device (Manuel, Discussion #85):
 * "make this switch the reference, then apply it to the others". Reads a few
 * fleet-wide settings off the device and writes them as the RouterOS commands
 * that set them, for Bulk Commands to run elsewhere.
 *
 * Only settings that mean the same on every device are offered, and nothing
 * secret: no SNMP communities, passwords or keys. The identity, addresses and
 * interfaces are the device's own and are never captured.
 */

export const CAPTURE_SECTIONS = ['dns', 'ntp', 'services', 'snmp', 'syslog', 'clock'] as const;
export type CaptureSection = typeof CAPTURE_SECTIONS[number];

export const CAPTURE_LABELS: Record<CaptureSection, string> = {
  dns: 'DNS servers',
  ntp: 'NTP client',
  services: 'IP services (on/off, port, allowed addresses)',
  snmp: 'SNMP (on/off, contact, location; not communities)',
  syslog: 'Remote syslog target',
  clock: 'Time zone',
};

type Row = Record<string, string | undefined>;

export interface CaptureInput {
  rosMajor: number;
  dns?: Row;
  ntp?: Row;
  services?: Row[];
  snmp?: Row;
  loggingActions?: Row[];
  clock?: Row;
}

const BOOL = (v: string | undefined) => (v === 'true' || v === 'yes' ? 'yes' : 'no');

/**
 * A value as the RouterOS CLI reads it: bare when it's plain, otherwise in
 * double quotes with `"`, `\` and `$` escaped, so a contact like
 * `NOC "west" $1` arrives as typed and can't run anything.
 */
export function rosValue(v: string): string {
  if (/^[A-Za-z0-9._:/,@+-]+$/.test(v)) return v;
  return `"${v.replace(/[\\"$]/g, (c) => `\\${c}`)}"`;
}

const set = (path: string, params: [string, string | undefined][]) => {
  const parts = params.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${rosValue(v!)}`);
  return parts.length ? `${path} set ${parts.join(' ')}` : null;
};

/** The commands, one per line, in the order given, and what each section came to. */
export function captureCommands(input: CaptureInput, sections: CaptureSection[]): { lines: string[]; skipped: string[] } {
  const lines: string[] = [];
  const skipped: string[] = [];
  const push = (l: string | null, why: string) => { if (l) lines.push(l); else skipped.push(why); };

  for (const s of sections) {
    if (s === 'dns') {
      const d = input.dns;
      push(d ? set('/ip dns', [['servers', d['servers'] ?? ''], ['allow-remote-requests', BOOL(d['allow-remote-requests'])]]) : null,
        'DNS: not read');
    } else if (s === 'ntp') {
      const n = input.ntp;
      if (!n) { skipped.push('NTP: not read'); continue; }
      // RouterOS 7 takes a list of servers; 6 has a primary and secondary address.
      push(input.rosMajor >= 7
        ? set('/system ntp client', [['enabled', BOOL(n['enabled'])], ['servers', n['servers'] ?? '']])
        : set('/system ntp client', [['enabled', BOOL(n['enabled'])], ['primary-ntp', n['primary-ntp']], ['secondary-ntp', n['secondary-ntp']],
          ['server-dns-names', n['server-dns-names']]]),
      'NTP: nothing to set');
    } else if (s === 'services') {
      const rows = (input.services ?? []).filter((r) => r['name'] && r['dynamic'] !== 'true');
      if (!rows.length) { skipped.push('IP services: not read'); continue; }
      for (const r of rows) {
        // v7.x renamed address to available-from on some builds; write what it reads.
        const allowedKey = r['available-from'] !== undefined ? 'available-from' : 'address';
        lines.push(`/ip service set [ find name=${rosValue(r['name']!)} ] ${[
          `disabled=${BOOL(r['disabled'])}`,
          r['port'] ? `port=${rosValue(r['port'])}` : null,
          `${allowedKey}=${rosValue(r[allowedKey] ?? '')}`,
        ].filter(Boolean).join(' ')}`);
      }
    } else if (s === 'snmp') {
      const n = input.snmp;
      push(n ? set('/snmp', [['enabled', BOOL(n['enabled'])], ['contact', n['contact'] ?? ''], ['location', n['location'] ?? '']]) : null,
        'SNMP: not read');
    } else if (s === 'syslog') {
      const remote = (input.loggingActions ?? []).find((a) => a['target'] === 'remote' && a['remote'] && a['remote'] !== '0.0.0.0');
      if (!remote) { skipped.push('Remote syslog: none set on this device'); continue; }
      lines.push(`/system logging action set [ find name=${rosValue(remote['name'] ?? 'remote')} ] ${[
        `remote=${rosValue(remote['remote']!)}`,
        remote['remote-port'] ? `remote-port=${rosValue(remote['remote-port'])}` : null,
      ].filter(Boolean).join(' ')}`);
    } else if (s === 'clock') {
      const c = input.clock;
      push(c?.['time-zone-name'] ? set('/system clock', [['time-zone-autodetect', BOOL(c['time-zone-autodetect'])], ['time-zone-name', c['time-zone-name']]]) : null,
        'Time zone: not read');
    }
  }
  return { lines, skipped };
}
