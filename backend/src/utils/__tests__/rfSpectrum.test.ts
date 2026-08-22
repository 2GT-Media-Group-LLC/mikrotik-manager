import {
  spectrumFor, classifyPair, overlapMhz, analyzeSpectrum, summarize, freeSpans,
  widthMhz, channelForFreq, bandForFreq,
} from '../rfSpectrum';

const ch = (n: number) => 2407 + n * 5;          // 2.4 GHz channel → centre MHz
const radio = (frequency: number, channel_width = '20mhz') => ({ frequency, channel_width });

describe('widthMhz', () => {
  it('reads a pinned width', () => {
    expect(widthMhz('20mhz')).toBe(20);
    expect(widthMhz('80mhz')).toBe(80);
  });

  /**
   * RouterOS reports a capability list on a radio allowed to bond opportunistically.
   * The widest entry is the spectrum it may occupy, so that is what a planner must
   * treat as unavailable.
   */
  it('takes the widest entry of a capability list', () => {
    expect(widthMhz('20/40/80mhz')).toBe(80);
    expect(widthMhz('20/40mhz')).toBe(40);
  });

  it('defaults to 20 MHz when unknown', () => {
    expect(widthMhz(undefined)).toBe(20);
    expect(widthMhz(null)).toBe(20);
    expect(widthMhz('auto')).toBe(20);
  });
});

describe('band and channel mapping', () => {
  it('maps 2.4 GHz channels', () => {
    expect(channelForFreq(2412)).toBe(1);
    expect(channelForFreq(2437)).toBe(6);
    expect(channelForFreq(2462)).toBe(11);
    expect(bandForFreq(2437)).toBe('2.4');
  });

  it('maps 5 and 6 GHz', () => {
    expect(channelForFreq(5180)).toBe(36);
    expect(bandForFreq(5180)).toBe('5');
    expect(bandForFreq(6115)).toBe('6');
  });

  it('returns null outside known bands', () => {
    expect(bandForFreq(900)).toBeNull();
    expect(channelForFreq(900)).toBeNull();
  });
});

describe('spectrumFor', () => {
  it('centres the occupied range on the frequency', () => {
    const s = spectrumFor(2412, '20mhz');
    expect(s.lowMhz).toBe(2402);
    expect(s.highMhz).toBe(2422);
    expect(s.channel).toBe(1);
  });

  it('widens the range for a bonded channel', () => {
    const s = spectrumFor(5180, '80mhz');
    expect(s.lowMhz).toBe(5140);
    expect(s.highMhz).toBe(5220);
  });
});

describe('classifyPair — the heart of issue #98', () => {
  /**
   * The case the old channel-index model got wrong. Channels 1 and 3 are 10 MHz
   * apart while each is 20 MHz wide, so they share half their spectrum — yet a
   * model keyed on channel numbers reports them as two separate, fine channels.
   */
  it('calls two adjacent 2.4 GHz channels a partial overlap', () => {
    expect(classifyPair(spectrumFor(ch(1)), spectrumFor(ch(3)))).toBe('partial');
    expect(overlapMhz(spectrumFor(ch(1)), spectrumFor(ch(3)))).toBe(10);
  });

  it('calls the classic 1 / 6 / 11 plan clear', () => {
    expect(classifyPair(spectrumFor(ch(1)), spectrumFor(ch(6)))).toBe('clear');
    expect(classifyPair(spectrumFor(ch(6)), spectrumFor(ch(11)))).toBe('clear');
    expect(classifyPair(spectrumFor(ch(1)), spectrumFor(ch(11)))).toBe('clear');
  });

  /**
   * Channel spacing is 5 MHz, so the arithmetic is unintuitive and worth pinning
   * down: 1 and 4 are 15 MHz apart and share 5 MHz, while 4 and 8 are a full
   * 20 MHz apart and merely abut. A plan of 1/4/8 is therefore *partly* broken —
   * exactly the nuance a channel-number model cannot express.
   */
  it('distinguishes overlap from mere adjacency', () => {
    expect(classifyPair(spectrumFor(ch(1)), spectrumFor(ch(4)))).toBe('partial');
    expect(overlapMhz(spectrumFor(ch(1)), spectrumFor(ch(4)))).toBe(5);

    expect(classifyPair(spectrumFor(ch(4)), spectrumFor(ch(8)))).toBe('clear');
    expect(overlapMhz(spectrumFor(ch(4)), spectrumFor(ch(8)))).toBe(0);
  });

  /**
   * Sharing a channel exactly is the *benign* case: the radios decode each other
   * and take turns. Ranking it below partial overlap is the point of the issue.
   */
  it('calls an identical channel co-channel, not partial', () => {
    expect(classifyPair(spectrumFor(ch(6)), spectrumFor(ch(6)))).toBe('co-channel');
  });

  it('treats a narrow radio nested inside a bonded one as partial', () => {
    // 20 MHz on ch 40 sits entirely inside 80 MHz centred on ch 36.
    expect(classifyPair(spectrumFor(5180, '80mhz'), spectrumFor(5200, '20mhz'))).toBe('partial');
  });

  it('never clashes across bands', () => {
    expect(classifyPair(spectrumFor(2437), spectrumFor(5180))).toBe('clear');
    expect(overlapMhz(spectrumFor(2437), spectrumFor(5180))).toBe(0);
  });

  it('treats touching-but-not-overlapping ranges as clear', () => {
    // 2402–2422 and 2422–2442 share only a boundary.
    expect(classifyPair(spectrumFor(2412), spectrumFor(2432))).toBe('clear');
  });

  it('is symmetric', () => {
    const a = spectrumFor(ch(1)), b = spectrumFor(ch(3));
    expect(classifyPair(a, b)).toBe(classifyPair(b, a));
    expect(overlapMhz(a, b)).toBe(overlapMhz(b, a));
  });
});

describe('analyzeSpectrum', () => {
  it('reports a lone radio as clear, not co-channel with itself', () => {
    const [v] = analyzeSpectrum([radio(ch(6))]);
    expect(v.kind).toBe('clear');
    expect(v.clashes).toHaveLength(0);
  });

  it('gives every radio in a 1 / 6 / 11 deployment a clean bill', () => {
    const v = analyzeSpectrum([radio(ch(1)), radio(ch(6)), radio(ch(11))]);
    expect(v.every((x) => x.kind === 'clear')).toBe(true);
    expect(summarize(v)).toEqual({ radios: 3, clear: 3, coChannel: 0, partial: 0 });
  });

  it('flags the misleading case: three radios spread across 1, 3 and 5', () => {
    const v = analyzeSpectrum([radio(ch(1)), radio(ch(3)), radio(ch(5))]);
    expect(v.every((x) => x.kind === 'partial')).toBe(true);
    expect(summarize(v).partial).toBe(3);
  });

  it('ranks partial above co-channel when a radio has both', () => {
    // ch6 twice (co-channel) plus a ch8 that partially overlaps them.
    const v = analyzeSpectrum([radio(ch(6)), radio(ch(6)), radio(ch(8))]);
    expect(v[0].kind).toBe('partial');
    expect(v[0].clashes[0].kind).toBe('partial');   // worst first
    expect(v[0].clashes.map((c) => c.kind)).toContain('co-channel');
  });

  it('separates radios by band', () => {
    const v = analyzeSpectrum([radio(ch(6)), radio(5180, '80mhz'), radio(6115)]);
    expect(v.every((x) => x.kind === 'clear')).toBe(true);
  });

  it('summarises a mixed deployment', () => {
    const v = analyzeSpectrum([radio(ch(1)), radio(ch(1)), radio(ch(4)), radio(ch(11))]);
    const s = summarize(v);
    expect(s.radios).toBe(4);
    expect(s.partial).toBe(3);   // both ch1s and the ch4 overlap each other
    expect(s.clear).toBe(1);     // ch11 is untouched
  });
});

describe('freeSpans', () => {
  it('finds the room left in 2.4 GHz after channels 1 and 11', () => {
    const v = analyzeSpectrum([radio(ch(1)), radio(ch(11))]);
    const spans = freeSpans(v, '2.4');
    // The gap between them must be able to hold channel 6 (2427–2447).
    expect(spans.some((s) => s.startMhz <= 2427 && s.endMhz >= 2447)).toBe(true);
  });

  it('reports no usable gap when a band is saturated', () => {
    const v = analyzeSpectrum([radio(2450, '160mhz')]);   // swamps 2370–2530
    expect(freeSpans(v, '2.4')).toHaveLength(0);
  });

  it('ignores gaps narrower than a channel', () => {
    // ch1 (2402-2422) and ch5 (2422-2442) leave no gap at all.
    const v = analyzeSpectrum([radio(ch(1)), radio(ch(5))]);
    const spans = freeSpans(v, '2.4');
    expect(spans.every((s) => s.endMhz - s.startMhz >= 20)).toBe(true);
  });

  it('returns the whole band when nothing is deployed', () => {
    expect(freeSpans([], '2.4')).toEqual([{ startMhz: 2400, endMhz: 2500 }]);
  });
});
