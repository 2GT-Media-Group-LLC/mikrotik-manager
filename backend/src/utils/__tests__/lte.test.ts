import {
  parseSignalValue, parseIntField, parseDurationSeconds, parseBandList, formatBandList,
  parseBandSpec, parseBandSpecs, parseLteMonitor, isConnected,
  classifyRsrp, classifyRsrq, classifySinr, overallQuality, describeQuality,
  detectChanges, observedBands, unprovenBands, totalBandwidthMhz, uplinkAnchor,
  REPEATED_KEY, LteStatus,
} from '../lte';

/**
 * Verbatim from a MikroTik ATL 18 (Quectel EG18-EA, Cat-18) on VIVACOM,
 * RouterOS 7.24 — see fixtures/lte-atl18.md. Identifiers redacted at source.
 */
const ATL18: Record<string, string> = {
  'status': 'running',
  'model': 'EG18-EA',
  'revision': 'EG18EAPAR01A14M4G',
  'current-operator': 'VIVACOM',
  'current-cellid': '123456',
  'enb-id': '1234',
  'sector-id': '12',
  'phy-cellid': '190',
  'data-class': 'LTE',
  'session-uptime': '3d7h17m59s',
  'primary-band': 'B1@20Mhz earfcn: 500 phy-cellid: 190',
  'ca-band': 'B3@20Mhz earfcn: 1800 phy-cellid: 190',
  'dl-modulation': '256qam',
  'cqi': '15',
  'ri': '2',
  'mcs': '20',
  'rssi': '-69dBm',
  'rsrp': '-97dBm',
  'rsrq': '-9dB',
  'sinr': '17dB',
};

/**
 * The same device carrying four aggregated carriers, from a WinBox capture in
 * discussion #85. Primary B3 with three CA rows — the shape that proves repeated
 * attributes must survive parsing, since the *last* of them is the narrowest.
 */
const FOUR_CARRIER: Record<string, string> = {
  'status': 'running',
  'data-class': 'LTE',
  'current-operator': 'VIVACOM',
  'primary-band': 'B3@20Mhz earfcn: 1800 phy-cellid: 36',
  'ca-band': 'B20@10Mhz earfcn: 6300 phy-cellid: 36',
  [REPEATED_KEY]: JSON.stringify({
    'ca-band': [
      'B1@20Mhz earfcn: 500 phy-cellid: 36',
      'B7@20Mhz earfcn: 3150 phy-cellid: 36',
      'B20@10Mhz earfcn: 6300 phy-cellid: 36',
    ],
  }),
  'rssi': '-40dBm', 'rsrp': '-70dBm', 'rsrq': '-9.0dB', 'sinr': '13dB',
  'cqi': '14', 'ri': '2', 'mcs': '0',
  'session-uptime': '00:02:51',
};

// ── scalars ───────────────────────────────────────────────────────────────────

describe('parseSignalValue', () => {
  it('strips the unit glued to the value', () => {
    expect(parseSignalValue('-97dBm')).toBe(-97);
    expect(parseSignalValue('-9dB')).toBe(-9);
    expect(parseSignalValue('17dB')).toBe(17);
  });

  it('accepts a bare number and decimals', () => {
    expect(parseSignalValue('-69')).toBe(-69);
    expect(parseSignalValue('17.5dB')).toBe(17.5);
  });

  it('returns null rather than 0 for what an idle modem reports', () => {
    // Zero would draw a signal stronger than any transmitter produces.
    for (const junk of ['', '   ', '-', 'unknown', 'n/a', undefined, null]) {
      expect(parseSignalValue(junk as string)).toBeNull();
    }
  });
});

describe('parseIntField', () => {
  it('reads plain integers', () => {
    expect(parseIntField('15')).toBe(15);
    expect(parseIntField('0')).toBe(0);
  });
  it('rejects blanks and non-numerics', () => {
    expect(parseIntField('')).toBeNull();
    expect(parseIntField('none')).toBeNull();
    expect(parseIntField(undefined)).toBeNull();
  });
});

describe('parseDurationSeconds', () => {
  it('parses the captured session uptime', () => {
    // 3d7h17m59s
    expect(parseDurationSeconds('3d7h17m59s')).toBe(3 * 86400 + 7 * 3600 + 17 * 60 + 59);
  });
  it('handles weeks and partial forms', () => {
    expect(parseDurationSeconds('1w2d')).toBe(604800 + 172800);
    expect(parseDurationSeconds('45s')).toBe(45);
  });
  it('accepts the clock form WinBox renders', () => {
    expect(parseDurationSeconds('00:02:51')).toBe(171);
    expect(parseDurationSeconds('13:45:00')).toBe(49500);
  });

  it('rejects junk', () => {
    expect(parseDurationSeconds('soon')).toBeNull();
    expect(parseDurationSeconds('')).toBeNull();
    expect(parseDurationSeconds('99:99:99')).toBeNull();
  });
});

describe('parseBandList / formatBandList', () => {
  it('parses the configured allow-list', () => {
    expect(parseBandList('1,3,7')).toEqual([1, 3, 7]);
  });
  it('tolerates spacing and B prefixes', () => {
    expect(parseBandList(' B1 , b3 ,7 ')).toEqual([1, 3, 7]);
  });
  it('is empty when unset — meaning auto, not none', () => {
    expect(parseBandList('')).toEqual([]);
    expect(parseBandList(undefined)).toEqual([]);
  });
  it('round-trips sorted and deduplicated', () => {
    expect(formatBandList([7, 1, 3, 1])).toBe('1,3,7');
  });
});

// ── bands ─────────────────────────────────────────────────────────────────────

describe('parseBandSpec', () => {
  it('parses the captured primary band', () => {
    expect(parseBandSpec('B1@20Mhz earfcn: 500 phy-cellid: 190')).toEqual({
      band: 1, bandwidthMhz: 20, earfcn: 500, phyCellId: 190,
      raw: 'B1@20Mhz earfcn: 500 phy-cellid: 190',
    });
  });

  it('parses a bare band number, since only that is universal', () => {
    const b = parseBandSpec('B7')!;
    expect(b.band).toBe(7);
    expect(b.bandwidthMhz).toBeNull();
    expect(b.earfcn).toBeNull();
  });

  it('returns null when there is no band at all', () => {
    expect(parseBandSpec('')).toBeNull();
    expect(parseBandSpec('unknown')).toBeNull();
    expect(parseBandSpec(undefined)).toBeNull();
  });
});

describe('parseBandSpecs — carrier aggregation', () => {
  it('reads the single CA carrier in the capture', () => {
    const ca = parseBandSpecs(ATL18, 'ca-band');
    expect(ca).toHaveLength(1);
    expect(ca[0].band).toBe(3);
    expect(ca[0].earfcn).toBe(1800);
  });

  it('recovers every carrier from repeated attributes', () => {
    // A Cat-18 modem aggregating three carriers: the API client preserves the
    // repeats, which a plain object would otherwise collapse to the last one.
    const row: Record<string, string> = {
      'ca-band': 'B7@20Mhz earfcn: 3350 phy-cellid: 191',
      [REPEATED_KEY]: JSON.stringify({
        'ca-band': [
          'B3@20Mhz earfcn: 1800 phy-cellid: 190',
          'B7@20Mhz earfcn: 3350 phy-cellid: 191',
        ],
      }),
    };
    expect(parseBandSpecs(row, 'ca-band').map(b => b.band)).toEqual([3, 7]);
  });

  it('recovers carriers concatenated into one value', () => {
    const row = { 'ca-band': 'B3@20Mhz earfcn: 1800 B7@10Mhz earfcn: 3350' };
    const ca = parseBandSpecs(row, 'ca-band');
    expect(ca.map(b => b.band)).toEqual([3, 7]);
    expect(ca[1].bandwidthMhz).toBe(10);
  });

  it('deduplicates a carrier reported through both channels', () => {
    const row: Record<string, string> = {
      'ca-band': 'B3@20Mhz earfcn: 1800 phy-cellid: 190',
      [REPEATED_KEY]: JSON.stringify({ 'ca-band': ['B3@20Mhz earfcn: 1800 phy-cellid: 190'] }),
    };
    expect(parseBandSpecs(row, 'ca-band')).toHaveLength(1);
  });

  it('falls back to the plain value when the side-channel is malformed', () => {
    const row: Record<string, string> = { 'ca-band': 'B3@20Mhz', [REPEATED_KEY]: '{not json' };
    expect(parseBandSpecs(row, 'ca-band').map(b => b.band)).toEqual([3]);
  });

  it('is empty when the modem reports no aggregation', () => {
    expect(parseBandSpecs({ 'primary-band': 'B1@20Mhz' }, 'ca-band')).toEqual([]);
  });
});

// ── monitor ───────────────────────────────────────────────────────────────────

describe('parseLteMonitor', () => {
  const s = parseLteMonitor(ATL18);

  it('reads the capture end to end', () => {
    expect(s.status).toBe('running');
    expect(s.modemModel).toBe('EG18-EA');
    expect(s.operator).toBe('VIVACOM');
    expect(s.rsrp).toBe(-97);
    expect(s.rsrq).toBe(-9);
    expect(s.sinr).toBe(17);
    expect(s.rssi).toBe(-69);
    expect(s.cqi).toBe(15);
    expect(s.ri).toBe(2);
    expect(s.mcs).toBe(20);
    expect(s.dlModulation).toBe('256qam');
    expect(s.primaryBand!.band).toBe(1);
    expect(s.caBands.map(b => b.band)).toEqual([3]);
    expect(s.sessionUptimeSeconds).toBe(285479);
  });

  it('takes the access technology from data-class, not the documented name', () => {
    expect(s.dataClass).toBe('LTE');
  });

  it('still accepts access-technology from modems that use it', () => {
    expect(parseLteMonitor({ 'access-technology': 'Evolved 3G' }).dataClass).toBe('Evolved 3G');
  });

  it('survives a reply with nothing in it', () => {
    const empty = parseLteMonitor({});
    expect(empty.rsrp).toBeNull();
    expect(empty.primaryBand).toBeNull();
    expect(empty.caBands).toEqual([]);
    expect(empty.status).toBeNull();
  });

  it('survives a modem that is registering — keys present, values blank', () => {
    const registering = parseLteMonitor({
      'status': 'searching', 'rsrp': '', 'rsrq': '', 'sinr': '',
      'primary-band': '', 'session-uptime': '',
    });
    expect(registering.status).toBe('searching');
    expect(registering.rsrp).toBeNull();
    expect(registering.primaryBand).toBeNull();
    expect(isConnected(registering)).toBe(false);
  });
});

describe('isConnected', () => {
  it('accepts running, which is what this modem family reports', () => {
    expect(isConnected(parseLteMonitor(ATL18))).toBe(true);
  });
  it('accepts connected, which others report', () => {
    expect(isConnected(parseLteMonitor({ status: 'connected' }))).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isConnected(parseLteMonitor({ status: 'searching' }))).toBe(false);
    expect(isConnected(parseLteMonitor({}))).toBe(false);
  });
});

// ── quality ───────────────────────────────────────────────────────────────────

describe('signal classification', () => {
  it('places RSRP on the standard operating bands', () => {
    expect(classifyRsrp(-75)).toBe('excellent');
    expect(classifyRsrp(-85)).toBe('good');
    expect(classifyRsrp(-97)).toBe('fair');
    expect(classifyRsrp(-110)).toBe('poor');
    expect(classifyRsrp(null)).toBe('unknown');
  });

  it('places RSRQ and SINR likewise', () => {
    expect(classifyRsrq(-9)).toBe('excellent');
    expect(classifyRsrq(-18)).toBe('fair');
    expect(classifySinr(25)).toBe('excellent');
    expect(classifySinr(17)).toBe('good');
    expect(classifySinr(5)).toBe('fair');
    expect(classifySinr(-3)).toBe('poor');
  });
});

describe('overallQuality', () => {
  it('does not let a quiet cell alone condemn a clean link', () => {
    // The captured device: RSRP -97 ("fair") but SINR 17 with CQI 15, RI 2 and
    // 256QAM — the modem at its ceiling. Reporting "fair" would misinform.
    expect(overallQuality(parseLteMonitor(ATL18))).toBe('good');
  });

  it('still reports poorly when the signal really is poor', () => {
    expect(overallQuality(parseLteMonitor({ rsrp: '-115dBm', sinr: '-2dB' }))).toBe('poor');
  });

  it('falls back to whichever measure exists', () => {
    expect(overallQuality(parseLteMonitor({ rsrp: '-85dBm' }))).toBe('good');
    expect(overallQuality(parseLteMonitor({ sinr: '25dB' }))).toBe('excellent');
    expect(overallQuality(parseLteMonitor({}))).toBe('unknown');
  });

  it('is dragged down by a genuinely weak cell', () => {
    // A clean channel with almost no signal has no fading margin, so however
    // good the SINR, this cannot be graded above one step over the RSRP.
    expect(overallQuality(parseLteMonitor({ rsrp: '-112dBm', sinr: '22dB' }))).toBe('fair');
  });
});

describe('describeQuality', () => {
  it('counts the primary carrier in the aggregation total', () => {
    expect(describeQuality(parseLteMonitor(ATL18))).toContain('Aggregating 2 carriers');
  });
  it('says so plainly when the modem is not attached', () => {
    expect(describeQuality(parseLteMonitor({ status: 'searching' }))).toBe('Not connected');
  });
});

// ── change detection ──────────────────────────────────────────────────────────

const at = (over: Partial<Record<string, string>>): LteStatus =>
  parseLteMonitor({ ...ATL18, ...over } as Record<string, string>);

describe('detectChanges', () => {
  it('reports nothing on the first poll', () => {
    expect(detectChanges(null, at({}))).toEqual([]);
  });

  it('reports nothing when the link is steady', () => {
    expect(detectChanges(at({}), at({ 'session-uptime': '3d7h18m29s' }))).toEqual([]);
  });

  it('sees a re-registration when uptime runs backwards', () => {
    const changes = detectChanges(at({}), at({ 'session-uptime': '45s' }));
    expect(changes.map(c => c.kind)).toContain('session-reset');
  });

  it('sees a handover when the cell id changes', () => {
    const changes = detectChanges(at({}), at({ 'current-cellid': '999999' }));
    expect(changes.map(c => c.kind)).toContain('handover');
  });

  it('sees a band change, including one that only drops a CA carrier', () => {
    const dropped = parseLteMonitor(
      Object.fromEntries(Object.entries(ATL18).filter(([k]) => k !== 'ca-band')),
    );
    const changes = detectChanges(at({}), dropped);
    expect(changes.map(c => c.kind)).toEqual(['band-change']);
    expect(changes[0].detail).toContain('from 1,3 to 1');
  });

  it('reports a reset and a handover together when the modem moves tower', () => {
    const kinds = detectChanges(at({}), at({ 'session-uptime': '10s', 'current-cellid': '888888' }))
      .map(c => c.kind);
    expect(kinds).toEqual(['session-reset', 'handover']);
  });
});

// ── observed bands ────────────────────────────────────────────────────────────

describe('observedBands / unprovenBands', () => {
  it('collects every band seen, primary and aggregated', () => {
    const history = [at({}), at({ 'primary-band': 'B7@10Mhz earfcn: 3350' })];
    expect(observedBands(history)).toEqual([1, 3, 7]);
  });

  it('passes a lock that history supports', () => {
    expect(unprovenBands([1, 3], [1, 3, 7])).toEqual([]);
  });

  it('flags a band never once seen serving this device', () => {
    // Locking to B20 here strands a device that has only ever used 1, 3 and 7.
    expect(unprovenBands([1, 20], [1, 3, 7])).toEqual([20]);
  });
});


// ── four-carrier aggregation ──────────────────────────────────────────────────

describe('four-carrier capture', () => {
  const s = parseLteMonitor(FOUR_CARRIER);

  it('recovers every aggregated carrier, not just the last reported', () => {
    expect(s.primaryBand!.band).toBe(3);
    expect(s.caBands.map(b => b.band)).toEqual([1, 7, 20]);
  });

  it('reports the true aggregate bandwidth', () => {
    // 20 + 20 + 20 + 10. Keeping only the final `ca-band` would show 30 MHz —
    // and it is the narrowest carrier that arrives last, so the error is severe.
    expect(totalBandwidthMhz(s)).toBe(70);
  });

  it('keeps MCS 0, which is a reading rather than a blank', () => {
    expect(s.mcs).toBe(0);
    expect(s.cqi).toBe(14);
  });

  it('parses the clock-form session uptime', () => {
    expect(s.sessionUptimeSeconds).toBe(171);
  });

  it('grades a loud but noisy cell on its SINR', () => {
    // RSRP -70 is excellent, SINR 13 only good; the weaker measure must lead.
    expect(overallQuality(s)).toBe('good');
  });

  it('counts all four carriers in the description', () => {
    expect(describeQuality(s)).toContain('Aggregating 4 carriers');
  });
});

describe('uplinkAnchor', () => {
  it('says nothing when the anchor is already the widest carrier', () => {
    // The primary here is B3@20 and no aggregated carrier beats it.
    expect(uplinkAnchor(parseLteMonitor(FOUR_CARRIER))).toBeNull();
    expect(uplinkAnchor(parseLteMonitor(ATL18))).toBeNull();
  });

  it('flags an anchor narrower than what is being aggregated', () => {
    // Left on auto this modem anchors to the loudest band — often a 10 MHz one —
    // and uplink rides the primary alone, so upload is capped at 10 MHz.
    const anchored = parseLteMonitor({
      'primary-band': 'B20@10Mhz earfcn: 6300',
      'ca-band': 'B3@20Mhz earfcn: 1800',
      [REPEATED_KEY]: JSON.stringify({
        'ca-band': ['B1@20Mhz earfcn: 500', 'B3@20Mhz earfcn: 1800'],
      }),
    });
    expect(uplinkAnchor(anchored)).toEqual({
      primaryMhz: 10, primaryBand: 20, widestMhz: 20, widestBand: 1,
    });
  });

  it('says nothing when bandwidth is unreported', () => {
    expect(uplinkAnchor(parseLteMonitor({ 'primary-band': 'B3', 'ca-band': 'B1' }))).toBeNull();
  });

  it('says nothing when there is no aggregation at all', () => {
    expect(uplinkAnchor(parseLteMonitor({ 'primary-band': 'B3@20Mhz' }))).toBeNull();
  });
});

describe('totalBandwidthMhz', () => {
  it('sums primary and aggregated carriers', () => {
    expect(totalBandwidthMhz(parseLteMonitor(ATL18))).toBe(40);
  });
  it('is zero when no bandwidth is reported', () => {
    expect(totalBandwidthMhz(parseLteMonitor({}))).toBe(0);
  });
});
