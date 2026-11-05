import { describe, it, expect } from 'vitest';
import { clientColumnsFor, parseClientColumnPrefs } from './clientColumns';

const ids = (cols: { id: string }[]) => cols.map((c) => c.id);
const none = { hidden: [], widths: {} };

describe('Clients columns (#336)', () => {
  it('shows the columns each view had before', () => {
    expect(ids(clientColumnsFor(none, 'all', false))).toEqual(['host', 'ip', 'type', 'port', 'vlan', 'device', 'data', 'seen']);
    expect(ids(clientColumnsFor(none, 'wireless', false))).toEqual(['host', 'ip', 'ssid', 'signal', 'rate', 'port', 'vlan', 'device', 'data', 'seen']);
    expect(ids(clientColumnsFor(none, 'wired', true))).toEqual(['host', 'ip', 'port', 'vlan', 'device', 'data', 'seen', 'active']);
  });

  it('leaves hidden columns out in every view, but never the host', () => {
    const prefs = parseClientColumnPrefs(JSON.stringify({ hidden: ['vlan', 'data', 'host', 'nonsense'], widths: { ip: 9999, port: 10, bogus: 5 } }));
    expect(prefs).toEqual({ hidden: ['vlan', 'data'], widths: { ip: 800, port: 48 } });
    expect(ids(clientColumnsFor(prefs, 'wireless', false))).toEqual(['host', 'ip', 'ssid', 'signal', 'rate', 'port', 'device', 'seen']);
  });
});
