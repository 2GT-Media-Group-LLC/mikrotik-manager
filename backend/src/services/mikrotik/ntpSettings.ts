/**
 * NTP settings across RouterOS versions (#180).
 *
 * The Network Services page edits a server half and a client half. RouterOS 7
 * has both, and the client takes a `servers` list. RouterOS 6 differs:
 *
 *   - /system/ntp/server exists only with the optional ntp package, so on a
 *     stock device writing to it fails ("no such command prefix")
 *   - its client has no `servers`: up to two IP addresses go in primary-ntp
 *     and secondary-ntp, and names go in server-dns-names
 *   - its client mode is read-only: unicast with servers set, broadcast
 *     without, and nothing else
 *
 * The page sent every field on every save, so saving the client on a stock
 * RouterOS 6 device failed on the server half it hadn't touched. Now only
 * what changed is sent, in the device's own terms.
 */

export interface NtpForm {
  server_enabled?: boolean;
  server_broadcast?: boolean;
  server_manycast?: boolean;
  client_enabled?: boolean;
  client_mode?: string;
  client_servers?: string;
}

export interface NtpState {
  server: Record<string, string>;
  client: Record<string, string>;
}

export interface NtpWrites {
  server: Record<string, string> | null;
  client: Record<string, string> | null;
}

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const NONE = '0.0.0.0';

export const isLegacyClient = (client: Record<string, string>): boolean => 'primary-ntp' in client;

/** RouterOS 6's client servers as one list, the way the page shows them. */
export function legacyServerList(client: Record<string, string>): string {
  return [client['primary-ntp'], client['secondary-ntp'], ...(client['server-dns-names'] || '').split(',')]
    .map((s) => (s || '').trim())
    .filter((s) => s && s !== NONE)
    .join(',');
}

function splitServers(list: string): string[] {
  return list.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

export function planNtpWrites(form: NtpForm, state: NtpState): NtpWrites {
  // Server: only fields whose value changes.
  const server: Record<string, string> = {};
  const flag = (key: string, want: boolean | undefined) => {
    if (want === undefined) return;
    if ((state.server[key] === 'yes') !== want) server[key] = want ? 'yes' : 'no';
  };
  flag('enabled', form.server_enabled);
  flag('broadcast', form.server_broadcast);
  flag('manycast', form.server_manycast);
  const hasServerMenu = 'enabled' in state.server;
  if (Object.keys(server).length && !hasServerMenu) {
    throw new Error(
      'This device has no NTP server to configure. On RouterOS 6 it comes with the optional ntp package; ' +
      'the NTP client works without it.'
    );
  }

  const client: Record<string, string> = {};
  if (form.client_enabled !== undefined && (state.client['enabled'] === 'yes') !== form.client_enabled) {
    client['enabled'] = form.client_enabled ? 'yes' : 'no';
  }
  const legacy = isLegacyClient(state.client);
  if (form.client_mode && form.client_mode !== state.client['mode']) {
    if (legacy) {
      // RouterOS 6 reports the mode but won't take it: it is unicast when
      // servers are set and broadcast when they aren't.
      if (form.client_mode !== 'unicast' && form.client_mode !== 'broadcast') {
        throw new Error(`RouterOS 6's NTP client supports unicast and broadcast, not ${form.client_mode}.`);
      }
    } else {
      client['mode'] = form.client_mode;
    }
  }
  if (form.client_servers !== undefined) {
    const want = splitServers(form.client_servers);
    if (legacy) {
      if (want.join(',') !== splitServers(legacyServerList(state.client)).join(',')) {
        const ips = want.filter((s) => IPV4.test(s));
        const names = [...ips.slice(2), ...want.filter((s) => !IPV4.test(s))];
        client['primary-ntp'] = ips[0] ?? NONE;
        client['secondary-ntp'] = ips[1] ?? NONE;
        client['server-dns-names'] = names.join(',');
      }
    } else if (want.join(',') !== splitServers(state.client['servers'] || '').join(',')) {
      client['servers'] = want.join(',');
    }
  }

  return {
    server: Object.keys(server).length ? server : null,
    client: Object.keys(client).length ? client : null,
  };
}
