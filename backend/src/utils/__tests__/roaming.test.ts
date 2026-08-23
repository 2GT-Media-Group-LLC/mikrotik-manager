import { parseRoamLine, buildSessions, flappingSessions } from '../roaming';

const T = (s: number) => new Date(Date.UTC(2026, 7, 22, 12, 0, s)).toISOString();

describe('parseRoamLine', () => {
  // Verbatim from a live wAP ax.
  it('parses a connect', () => {
    const e = parseRoamLine('0C:DC:7E:E4:14:80@wifi3(popoladuper) connected, signal strength -52', T(0))!;
    expect(e.kind).toBe('connected');
    expect(e.mac).toBe('0C:DC:7E:E4:14:80');
    expect(e.interfaceName).toBe('wifi3');
    expect(e.ssid).toBe('popoladuper');
    expect(e.signal).toBe(-52);
  });

  it('parses a disconnect and keeps the stated reason', () => {
    const e = parseRoamLine('B0:BE:76:BC:B3:D7@wifi3(popoladuper) disconnected, connection lost, signal strength -69', T(0))!;
    expect(e.kind).toBe('disconnected');
    expect(e.reason).toBe('connection lost');
    expect(e.signal).toBe(-69);
  });

  // Verbatim from issue #105.
  it('parses a roam, capturing both ends', () => {
    const e = parseRoamLine(
      'D6:E0:17:43:FF:14@wifi-legacy-left-ap-001-main-5g(MySSIDName) roamed to D6:E0:17:43:FF:14@wifi-legacy-left-ap-001-main-2g(MySSIDName), signal strength -60',
      T(0))!;
    expect(e.kind).toBe('roamed');
    expect(e.interfaceName).toBe('wifi-legacy-left-ap-001-main-5g');
    expect(e.toInterface).toBe('wifi-legacy-left-ap-001-main-2g');
    expect(e.signal).toBe(-60);
  });

  it('parses DHCP assignment and release', () => {
    const a = parseRoamLine('public_wifi_dhcp assigned 10.120.205.125 for D6:E0:17:43:FF:14 Redmi-Note-11-Pro', T(0))!;
    expect(a.kind).toBe('dhcp-assigned');
    expect(a.ip).toBe('10.120.205.125');
    expect(a.hostname).toBe('Redmi-Note-11-Pro');

    const d = parseRoamLine('public_wifi_dhcp deassigned 10.120.205.125 for D6:E0:17:43:FF:14 Redmi-Note-11-Pro', T(0))!;
    expect(d.kind).toBe('dhcp-released');
  });

  /**
   * Observed in real logs: `signal strength 91`. dBm is negative, so a positive
   * reading is not a plausible measurement — recording it would draw a client with
   * an impossibly perfect signal.
   */
  it('rejects an implausible positive signal rather than trusting it', () => {
    const e = parseRoamLine('D6:FC:E1:03:CD:F5@wifi4(popoladuper) disconnected, connection lost, signal strength 91', T(0))!;
    expect(e.kind).toBe('disconnected');
    expect(e.signal).toBeNull();
  });

  it('copes with an SSID containing brackets', () => {
    const e = parseRoamLine('AA:BB:CC:DD:EE:FF@wifi1(Guest (2.4)) connected, signal strength -40', T(0))!;
    expect(e.ssid).toBe('Guest (2.4)');
    expect(e.signal).toBe(-40);
  });

  it('ignores unrelated log lines', () => {
    expect(parseRoamLine('system,info,account user admin logged in', T(0))).toBeNull();
    expect(parseRoamLine('', T(0))).toBeNull();
  });
});

describe('buildSessions', () => {
  const line = (m: string, s: number) => parseRoamLine(m, T(s))!;
  const MAC = 'D6:E0:17:43:FF:14';

  /** The full trace from issue #105 — a textbook ping-pong between bands. */
  const reported = () => [
    line(`${MAC}@left-5g(SSID) connected, signal strength -75`, 0),
    line(`public_wifi_dhcp assigned 10.120.205.125 for ${MAC} Redmi-Note-11-Pro`, 5),
    line(`${MAC}@left-5g(SSID) roamed to ${MAC}@left-2g(SSID), signal strength -60`, 60),
    line(`${MAC}@left-2g(SSID) roamed to ${MAC}@left-5g(SSID), signal strength -72`, 120),
    line(`${MAC}@left-5g(SSID) roamed to ${MAC}@left-2g(SSID), signal strength -59`, 180),
    line(`${MAC}@left-2g(SSID) roamed to ${MAC}@left-5g(SSID), signal strength -73`, 240),
    line(`${MAC}@left-5g(SSID) roamed to ${MAC}@left-2g(SSID), signal strength -64`, 300),
    line(`${MAC}@left-2g(SSID) roamed to ${MAC}@left-5g(SSID), signal strength -70`, 360),
    line(`${MAC}@left-5g(SSID) disconnected, connection lost, signal strength -70`, 420),
    line(`public_wifi_dhcp deassigned 10.120.205.125 for ${MAC} Redmi-Note-11-Pro`, 425),
  ];

  it('reconstructs one session with the full path', () => {
    const [s] = buildSessions(reported());
    expect(s.path).toEqual([
      'left-5g', 'left-2g', 'left-5g', 'left-2g', 'left-5g', 'left-2g', 'left-5g',
    ]);
    expect(s.hops).toHaveLength(6);
    expect(s.durationSec).toBe(420);
    expect(s.disconnectReason).toBe('connection lost');
  });

  it('picks up the DHCP lease for the session', () => {
    const [s] = buildSessions(reported());
    expect(s.ip).toBe('10.120.205.125');
    expect(s.hostname).toBe('Redmi-Note-11-Pro');
  });

  it('records the signal range seen across the session', () => {
    const [s] = buildSessions(reported());
    expect(s.signalMin).toBe(-75);
    expect(s.signalMax).toBe(-59);
  });

  it('flags the reported trace as flapping', () => {
    const sessions = buildSessions(reported());
    // Six roams in seven minutes.
    expect(sessions[0].roamsPerHour).toBeGreaterThan(6);
    expect(flappingSessions(sessions)).toHaveLength(1);
  });

  it('does not flag a client that settles', () => {
    const sessions = buildSessions([
      line(`${MAC}@left-5g(SSID) connected, signal strength -55`, 0),
      line(`${MAC}@left-5g(SSID) roamed to ${MAC}@hall-5g(SSID), signal strength -70`, 1800),
      line(`${MAC}@hall-5g(SSID) disconnected, connection lost, signal strength -58`, 3600),
    ]);
    expect(flappingSessions(sessions)).toHaveLength(0);
  });

  it('splits consecutive connects into separate sessions', () => {
    const sessions = buildSessions([
      line(`${MAC}@a(S) connected, signal strength -50`, 0),
      line(`${MAC}@a(S) disconnected, connection lost, signal strength -60`, 60),
      line(`${MAC}@b(S) connected, signal strength -55`, 120),
      line(`${MAC}@b(S) disconnected, connection lost, signal strength -65`, 180),
    ]);
    expect(sessions).toHaveLength(2);
  });

  /**
   * Logs are lossy — rotation, a reboot, or simply querying a window that starts
   * mid-session. Evidence of a roam matters more than a tidy session boundary.
   */
  it('opens a session retroactively when the connect was never seen', () => {
    const sessions = buildSessions([
      line(`${MAC}@a(S) roamed to ${MAC}@b(S), signal strength -70`, 0),
      line(`${MAC}@b(S) disconnected, connection lost, signal strength -72`, 60),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].hops).toHaveLength(1);
  });

  it('leaves an unterminated session open rather than inventing an end', () => {
    const [s] = buildSessions([line(`${MAC}@a(S) connected, signal strength -50`, 0)]);
    expect(s.endedAt).toBeNull();
    expect(s.durationSec).toBeNull();
  });

  it('sorts out-of-order events before reconstructing', () => {
    const [s] = buildSessions([
      line(`${MAC}@a(S) disconnected, connection lost, signal strength -60`, 60),
      line(`${MAC}@a(S) connected, signal strength -50`, 0),
    ]);
    expect(s.durationSec).toBe(60);
  });

  it('returns nothing for a client with no wireless history', () => {
    expect(buildSessions([])).toEqual([]);
  });
});

/**
 * RouterOS log timestamps are second-granular, so a disconnect and the reconnect
 * that follows land on the same instant and arrive in arbitrary order. Observed on
 * a live AP: an IoT client reassociating every 15 minutes produced pairs recorded
 * at an identical time. Without an ordering rule every reassociation reconstructed
 * as a 0-second session and the real 15-minute one vanished.
 */
describe('buildSessions — same-instant disconnect and reconnect', () => {
  const MAC = '28:37:2F:C8:31:DC';
  const at = (m: number) => new Date(Date.UTC(2026, 7, 18, 19, m, 0)).toISOString();
  const conn = (t: string) => parseRoamLine(`${MAC}@wifi5(IoT) connected, signal strength -60`, t)!;
  const disc = (t: string) => parseRoamLine(`${MAC}@wifi5(IoT) disconnected, connection lost, signal strength -61`, t)!;

  it('closes the old session rather than opening a zero-length one', () => {
    const sessions = buildSessions([conn(at(0)), conn(at(15)), disc(at(15))]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].durationSec).toBe(900);       // the real 15-minute session
    expect(sessions[0].disconnectReason).toBe('connection lost');
    expect(sessions[1].endedAt).toBeNull();          // the reconnect is still open
  });

  it('gives the same answer whichever order the pair arrives in', () => {
    const a = buildSessions([conn(at(0)), disc(at(15)), conn(at(15))]);
    const b = buildSessions([conn(at(0)), conn(at(15)), disc(at(15))]);
    expect(a.map(s => s.durationSec)).toEqual(b.map(s => s.durationSec));
  });
});

/**
 * The same pair, one millisecond apart with the connect first — the shape actually
 * seen in collected logs (`20:06:17.096 connected`, `20:06:17.097 disconnected`).
 * Sub-second ordering is a collection artefact, so it must not decide which session
 * the disconnect belongs to.
 */
describe('buildSessions — sub-second jitter within one logged second', () => {
  const MAC = '28:37:2F:C8:31:DC';
  const conn = (t: string) => parseRoamLine(`${MAC}@wifi5(IoT) connected, signal strength -60`, t)!;
  const disc = (t: string) => parseRoamLine(`${MAC}@wifi5(IoT) disconnected, connection lost, signal strength -61`, t)!;

  it('attributes the disconnect to the earlier session despite arriving later', () => {
    const sessions = buildSessions([
      conn('2026-08-18T19:51:16.849Z'),
      conn('2026-08-18T20:06:17.096Z'),   // 1 ms before its own disconnect
      disc('2026-08-18T20:06:17.097Z'),
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].durationSec).toBe(900);   // the real ~15-minute session
    expect(sessions[1].durationSec).toBeNull();  // reconnect still open
  });

  it('produces no zero-length session from a reassociation', () => {
    const sessions = buildSessions([
      conn('2026-08-18T19:00:00.100Z'),
      conn('2026-08-18T19:15:00.100Z'),
      disc('2026-08-18T19:15:00.200Z'),
      conn('2026-08-18T19:30:00.300Z'),
      disc('2026-08-18T19:30:00.100Z'),
    ]);
    expect(sessions.filter(s => s.durationSec === 0)).toHaveLength(0);
  });
});
