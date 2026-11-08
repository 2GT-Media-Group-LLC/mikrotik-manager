import { describe, it, expect } from 'vitest';
import type { ZonesData } from '../services/api';
import { initialDraft, draftErrors, policySummary, addZone, removeZone, setPolicy, zoneNameError, portsError, pairKey, ROUTER } from './zones';

const data = (over: Partial<ZonesData> = {}): ZonesData => ({
  enabled: false, config: null, applied_at: null, applied_by: null, eligible: true, foreign_rules: 0,
  lists: [
    { name: 'LAN', members: [{ interface: 'bridge', dynamic: false }] },
    { name: 'WAN', members: [{ interface: 'ether1', dynamic: false }, { interface: 'lte1', dynamic: true }] },
  ],
  interfaces: [], manager_ip: null, drift: null, services: { forward: [], router: [] }, ...over,
});

describe('zone editor (#369)', () => {
  it('starts from the device\'s LAN and WAN with the defaults\' rules', () => {
    const d = initialDraft(data());
    expect(d.config.zones).toEqual(['LAN', 'WAN']);
    expect(d.members).toEqual({ LAN: ['bridge'], WAN: ['ether1'] });
    expect(Object.keys(d.config.policies).sort()).toEqual(['LAN>@router', 'LAN>WAN', 'WAN>@router']);
    expect(d.config.policies['WAN>@router']).toEqual({ action: 'services', services: ['ping'], custom: [] });
  });

  it('starts from the saved setup when zones are on', () => {
    const config = { zones: ['WAN'], intra: { WAN: false }, policies: {}, fasttrack: false, logDrops: true };
    expect(initialDraft(data({ enabled: true, config }))).toEqual({ config, members: { WAN: ['ether1'] } });
  });

  it('adds and removes zones, taking their cells with them', () => {
    let d = initialDraft(data());
    d = addZone(d, ' DMZ ', ['ether3', 'bridge']);
    expect(d.members.DMZ).toEqual(['ether3']);
    d = setPolicy(d, pairKey('LAN', 'DMZ'), { action: 'allow', services: [], custom: [] });
    d = removeZone(d, 'DMZ');
    expect(d.config.zones).toEqual(['LAN', 'WAN']);
    expect(Object.keys(d.config.policies)).not.toContain('LAN>DMZ');
    expect(setPolicy(d, 'LAN>WAN', { action: 'deny', services: [], custom: [] }).config.policies['LAN>WAN']).toBeUndefined();
  });

  it('catches what the server would refuse', () => {
    const d = initialDraft(data());
    expect(draftErrors(d)).toEqual({});
    expect(draftErrors({ ...d, members: { LAN: ['bridge'], WAN: ['bridge'] } }).members).toMatch(/both LAN and WAN/);
    expect(draftErrors(setPolicy(d, 'LAN>WAN', { action: 'services', services: [], custom: [] }))['pair:LAN>WAN']).toMatch(/at least one/);
    expect(draftErrors(setPolicy(d, 'LAN>WAN', { action: 'services', services: [], custom: [{ protocol: 'tcp', ports: '8080-80' }] }))['pair:LAN>WAN']).toMatch(/valid/);
    expect(zoneNameError('all', [])).toMatch(/own lists/);
    expect(zoneNameError('router', [])).toMatch(/kept/);
    expect(zoneNameError('lan', ['LAN'])).toMatch(/already/);
    expect(portsError('80,443,5000-5010')).toBeNull();
    expect(portsError('http')).toMatch(/Numbers/);
  });

  it('sums up a cell', () => {
    const labels = { ping: 'Ping', ssh: 'SSH', dns: 'DNS' };
    expect(policySummary(undefined, labels)).toBe('Deny');
    expect(policySummary({ action: 'allow', services: [], custom: [] }, labels)).toBe('Allow all');
    expect(policySummary({ action: 'services', services: ['ping', 'ssh'], custom: [] }, labels)).toBe('Ping, SSH');
    expect(policySummary({ action: 'services', services: ['ping', 'ssh', 'dns'], custom: [{ protocol: 'udp', ports: '500' }] }, labels)).toBe('Ping, SSH +2');
    expect(ROUTER).toBe('@router');
  });
});
