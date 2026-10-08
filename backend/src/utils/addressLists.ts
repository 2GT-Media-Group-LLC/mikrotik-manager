/**
 * One client's place in a router's firewall address lists (#145). Pure, so it
 * can be tested without a device.
 */
type Row = Record<string, string>;

export interface ClientListMembership {
  list: string;
  /** The entry's id, to remove it. */
  id: string;
  /** Added by a firewall rule (add-src-to-address-list and the like): read-only. */
  dynamic: boolean;
  disabled: boolean;
  comment: string | null;
  timeout: string | null;
}

export interface ClientAddressListView {
  address: string;
  /** Every list on the router, sorted. */
  lists: string[];
  member: ClientListMembership[];
  /** Lists some firewall rule matches on: changing those can affect access. */
  referenced: string[];
  /** The DHCP lease for the address on this router, when there is one. */
  lease: { static: boolean; host: string | null } | null;
}

const isTrue = (v: string | undefined) => v === 'true' || v === 'yes';

export function clientAddressListView(entries: Row[], rules: Row[], leases: Row[], address: string): ClientAddressListView {
  const lists = [...new Set(entries.map((e) => e['list']).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const member = entries
    .filter((e) => e['address'] === address && e['list'] && e['.id'])
    .map((e) => ({
      list: e['list'], id: e['.id'], dynamic: isTrue(e['dynamic']), disabled: isTrue(e['disabled']),
      comment: e['comment'] || null, timeout: e['timeout'] || null,
    }));
  const referenced = new Set<string>();
  for (const r of rules) {
    if (isTrue(r['disabled'])) continue;
    for (const k of ['src-address-list', 'dst-address-list']) {
      const v = (r[k] || '').replace(/^!/, '');
      if (v) referenced.add(v);
    }
  }
  const lease = leases.find((l) => l['address'] === address || l['active-address'] === address);
  return {
    address,
    lists,
    member,
    referenced: [...referenced].sort((a, b) => a.localeCompare(b)),
    lease: lease ? { static: !isTrue(lease['dynamic']), host: lease['host-name'] || lease['comment'] || null } : null,
  };
}
