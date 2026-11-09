import { arpSighting } from '../arpPresence';

const mac = 'DA:41:00:11:22:33';

describe('arpSighting (#363)', () => {
  it('counts entries the router is talking to now, and static ones', () => {
    for (const status of ['reachable', 'delay', 'probe', 'permanent']) {
      expect(arpSighting({ 'mac-address': mac, status })).toBe('live');
    }
  });

  it('holds a stale entry apart: it can keep a client online, not bring one online', () => {
    expect(arpSighting({ 'mac-address': mac, status: 'stale', complete: 'true' })).toBe('stale');
  });

  it('never counts failed or incomplete entries', () => {
    expect(arpSighting({ 'mac-address': mac, status: 'failed' })).toBe('none');
    expect(arpSighting({ 'mac-address': mac, status: 'incomplete' })).toBe('none');
    expect(arpSighting({ 'mac-address': mac, incomplete: 'true' })).toBe('none');
    expect(arpSighting({ status: 'reachable' })).toBe('none');
  });

  it('keeps RouterOS 6 entries, which have no status, as before', () => {
    expect(arpSighting({ 'mac-address': mac, complete: 'true' })).toBe('live');
  });
});
