import { parseRoamLine } from '../roaming';
import { parseLteMonitor, splitCarriers } from '../lte';

// Outside review P2-17: device-supplied text must not stall the event loop.
// Before the fix these inputs took over a second (LTE) and ~100 ms per line
// (roaming, read up to 5,000 lines at a time).
describe('device text parsing stays linear', () => {
  const MAC = 'AA:BB:CC:DD:EE:FF';
  const time = (fn: () => void) => { const t = Date.now(); fn(); return Date.now() - t; };

  it('parses a band value padded with a long run of spaces quickly', () => {
    expect(time(() => parseLteMonitor({ 'primary-band': 'B1@20Mhz' + ' '.repeat(40_000) + 'x' }))).toBeLessThan(100);
  });

  it.each([
    `${MAC}@` + 'a'.repeat(20_000) + '(' + ')'.repeat(20_000),
    `${MAC}@` + 'a('.repeat(10_000),
    `${MAC}@wlan1(` + ') roamed to '.repeat(40),
  ])('rejects a hostile roaming line quickly', (line) => {
    expect(time(() => parseRoamLine(line, '2026-01-01T00:00:00Z'))).toBeLessThan(50);
  });

  it('still splits carriers the way the old split did', () => {
    expect(splitCarriers('B1@20Mhz earfcn: 500 B3@20Mhz earfcn: 1800')).toEqual(['B1@20Mhz earfcn: 500', 'B3@20Mhz earfcn: 1800']);
    expect(splitCarriers('  B7@15Mhz  ')).toEqual(['B7@15Mhz']);
    expect(splitCarriers('LTE B20@10Mhz')).toEqual(['LTE', 'B20@10Mhz']);
    expect(splitCarriers('no carriers here')).toEqual(['no carriers here']);
  });

  it('still parses a real roaming line, SSID brackets and all', () => {
    const e = parseRoamLine(`${MAC}@wifi1(Home (5G)) roamed to ${MAC}@wifi2(Home (5G)), signal strength -61`, '2026-01-01T00:00:00Z');
    expect(e).toMatchObject({ kind: 'roamed', interfaceName: 'wifi1', ssid: 'Home (5G)', toInterface: 'wifi2', signal: -61 });
  });
});
