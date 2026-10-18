import { _sharedArpScan, _arpScanInProgress, _resetArpScanCache } from '../serverArp';

describe('shared arp-scan (#301)', () => {
  beforeEach(() => _resetArpScanCache());

  it('never waits for a scan: the first call starts one and returns what it has', async () => {
    let finish: (r: Record<string, string>) => void = () => {};
    const scan = jest.fn(() => new Promise<Record<string, string>>((r) => { finish = r; }));
    expect(_sharedArpScan(1_000_000, scan)).toEqual({});
    expect(scan).toHaveBeenCalledTimes(1);
    // A second caller while it runs neither waits nor starts another.
    expect(_sharedArpScan(1_000_001, scan)).toEqual({});
    expect(scan).toHaveBeenCalledTimes(1);
    finish({ 'aa:bb:cc:dd:ee:ff': '10.0.0.9' });
    await _arpScanInProgress();
    expect(_sharedArpScan(1_000_002, scan)).toEqual({ 'aa:bb:cc:dd:ee:ff': '10.0.0.9' });
  });

  it('an expired result is still used while the next scan runs', async () => {
    const scan = jest.fn()
      .mockResolvedValueOnce({ m1: '10.0.0.1' })
      .mockReturnValueOnce(new Promise(() => {}));
    _sharedArpScan(0 + 400_000, scan);
    await _arpScanInProgress();
    expect(_sharedArpScan(400_000 + 6 * 60_000, scan)).toEqual({ m1: '10.0.0.1' });
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('a failed scan keeps the last result', async () => {
    const scan = jest.fn()
      .mockResolvedValueOnce({ m1: '10.0.0.1' })
      .mockRejectedValueOnce(new Error('no NET_RAW'));
    _sharedArpScan(400_000, scan);
    await _arpScanInProgress();
    _sharedArpScan(400_000 + 6 * 60_000, scan);
    await _arpScanInProgress();
    expect(_sharedArpScan(400_000 + 6 * 60_000 + 1, scan)).toEqual({ m1: '10.0.0.1' });
  });
});
