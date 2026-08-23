/**
 * Reconstructing a wireless client's session from RouterOS log lines.
 *
 * RouterOS narrates the whole life of a association in its log — association,
 * every band or AP change, and the disconnect — each line carrying the signal
 * strength at that moment:
 *
 *   D6:E0:...@wifi-left-5g(Guest) connected, signal strength -75
 *   D6:E0:...@wifi-left-5g(Guest) roamed to D6:E0:...@wifi-left-2g(Guest), signal strength -60
 *   D6:E0:...@wifi-left-5g(Guest) disconnected, connection lost, signal strength -70
 *
 * That is enough to answer the question people actually have about a flaky client:
 * *where was it, how well was it hearing us, and why did it move?* Nothing else in
 * the platform can answer that, because a poll only ever sees the current state and
 * roaming happens between polls.
 *
 * Everything here is pure over already-collected `events` rows — no new collection,
 * no new storage, and it works retroactively over whatever log history exists.
 */

export type RoamEventKind =
  | 'connected'
  | 'roamed'
  | 'disconnected'
  | 'dhcp-assigned'
  | 'dhcp-released';

export interface RoamEvent {
  kind: RoamEventKind;
  at: string;
  mac: string;
  /** Interface the client was on when the line was written. */
  interfaceName: string | null;
  ssid: string | null;
  signal: number | null;
  /** Where it moved to — `roamed` only. */
  toInterface: string | null;
  toSsid: string | null;
  /** RouterOS's stated reason, e.g. "connection lost". */
  reason: string | null;
  /** DHCP lines only. */
  ip: string | null;
  hostname: string | null;
  /** The managed device whose log carried the line. */
  deviceName: string | null;
}

const MAC = '[0-9A-Fa-f:]{17}';

// Lazy SSID capture with a required suffix: correct even for an SSID containing
// a bracket, because the match must still end at the literal that follows.
const RE_ROAMED = new RegExp(
  `^(${MAC})@(\\S+?)\\((.*?)\\) roamed to (${MAC})@(\\S+?)\\((.*?)\\), signal strength (-?\\d+)`
);
const RE_CONNECTED = new RegExp(
  `^(${MAC})@(\\S+?)\\((.*?)\\) connected, signal strength (-?\\d+)`
);
const RE_DISCONNECTED = new RegExp(
  `^(${MAC})@(\\S+?)\\((.*?)\\) disconnected, (.+?), signal strength (-?\\d+)`
);
const RE_DHCP = new RegExp(
  `^(\\S+) (assigned|deassigned) (\\S+) for (${MAC})(?:\\s+(.*))?$`
);

/**
 * Signal strengths are dBm and therefore negative. RouterOS occasionally emits a
 * positive value — `signal strength 91` appears in real logs — which is not a
 * plausible reading. Treated as unknown rather than plotted as an excellent signal.
 */
function parseSignal(raw: string): number | null {
  const n = parseInt(raw, 10);
  if (isNaN(n)) return null;
  return n <= 0 && n >= -120 ? n : null;
}

const base = (at: string, deviceName: string | null): Omit<RoamEvent, 'kind' | 'mac'> => ({
  at, deviceName,
  interfaceName: null, ssid: null, signal: null,
  toInterface: null, toSsid: null, reason: null, ip: null, hostname: null,
});

/** Parse one log line, or null when it is not part of a wireless session. */
export function parseRoamLine(
  message: string,
  at: string,
  deviceName: string | null = null
): RoamEvent | null {
  const roamed = RE_ROAMED.exec(message);
  if (roamed) {
    return {
      ...base(at, deviceName), kind: 'roamed',
      mac: roamed[1].toUpperCase(),
      interfaceName: roamed[2], ssid: roamed[3] || null,
      toInterface: roamed[5], toSsid: roamed[6] || null,
      signal: parseSignal(roamed[7]),
    };
  }

  const connected = RE_CONNECTED.exec(message);
  if (connected) {
    return {
      ...base(at, deviceName), kind: 'connected',
      mac: connected[1].toUpperCase(),
      interfaceName: connected[2], ssid: connected[3] || null,
      signal: parseSignal(connected[4]),
    };
  }

  const disconnected = RE_DISCONNECTED.exec(message);
  if (disconnected) {
    return {
      ...base(at, deviceName), kind: 'disconnected',
      mac: disconnected[1].toUpperCase(),
      interfaceName: disconnected[2], ssid: disconnected[3] || null,
      reason: disconnected[4],
      signal: parseSignal(disconnected[5]),
    };
  }

  const dhcp = RE_DHCP.exec(message);
  if (dhcp) {
    return {
      ...base(at, deviceName),
      kind: dhcp[2] === 'assigned' ? 'dhcp-assigned' : 'dhcp-released',
      mac: dhcp[4].toUpperCase(),
      ip: dhcp[3],
      hostname: dhcp[5]?.trim() || null,
    };
  }

  return null;
}

export interface RoamHop {
  at: string;
  from: string | null;
  to: string;
  signalBefore: number | null;
  signalAfter: number | null;
}

export interface RoamSession {
  startedAt: string;
  endedAt: string | null;
  /** Null while the session is still open. */
  durationSec: number | null;
  ssid: string | null;
  ip: string | null;
  hostname: string | null;
  /** Interfaces held, in order. */
  path: string[];
  hops: RoamHop[];
  disconnectReason: string | null;
  signalMin: number | null;
  signalMax: number | null;
  /**
   * Roams per hour. High values mean the client is ping-ponging between radios
   * rather than settling — usually a roaming-threshold problem, not a client fault.
   */
  roamsPerHour: number | null;
  events: RoamEvent[];
}

const secondsBetween = (a: string, b: string) =>
  Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));

/**
 * Group a client's events into sessions.
 *
 * A session runs from a `connected` to the matching `disconnected`. Logs are
 * lossy — a device reboots, log rotation drops the start, a disconnect never
 * arrives — so a roam or disconnect seen with no open session opens one
 * retroactively rather than being discarded. Losing the beginning of a session is
 * normal; losing the evidence of a roam is not.
 */
export function buildSessions(events: RoamEvent[]): RoamSession[] {
  // RouterOS log timestamps are second-granular. A reassociation therefore emits
  // its disconnect and reconnect inside the same logged second, and collection
  // assigns them sub-second values in whichever order they were read — observed on
  // a live AP as both `.849/.849` and `.096/.097` for the same kind of pair.
  //
  // Those sub-second differences are an artefact of collection, not evidence of
  // ordering, so events are ordered by whole second and ties broken by meaning: a
  // disconnect closes what came before, a connect opens what comes after. Sorting
  // on the raw timestamp instead attaches the disconnect to the session the connect
  // just opened, and every reassociation reconstructs as a 0-second session while
  // the real one disappears.
  const RANK: Record<RoamEventKind, number> = {
    'dhcp-released': 0, disconnected: 1, connected: 2, roamed: 3, 'dhcp-assigned': 4,
  };
  const second = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
  const ordered = [...events].sort((a, b) => {
    const t = second(a.at) - second(b.at);
    if (t !== 0) return t;
    const r = RANK[a.kind] - RANK[b.kind];
    return r !== 0 ? r : new Date(a.at).getTime() - new Date(b.at).getTime();
  });
  const sessions: RoamSession[] = [];
  let current: RoamSession | null = null;

  const open = (e: RoamEvent, iface: string | null): RoamSession => ({
    startedAt: e.at, endedAt: null, durationSec: null,
    ssid: e.ssid, ip: null, hostname: null,
    path: iface ? [iface] : [],
    hops: [], disconnectReason: null,
    signalMin: null, signalMax: null, roamsPerHour: null,
    events: [],
  });

  const note = (s: RoamSession, e: RoamEvent) => {
    s.events.push(e);
    if (e.signal != null) {
      s.signalMin = s.signalMin == null ? e.signal : Math.min(s.signalMin, e.signal);
      s.signalMax = s.signalMax == null ? e.signal : Math.max(s.signalMax, e.signal);
    }
  };

  for (const e of ordered) {
    switch (e.kind) {
      case 'connected':
        if (current) { current.endedAt = e.at; sessions.push(current); }
        current = open(e, e.interfaceName);
        note(current, e);
        break;

      case 'roamed': {
        if (!current) current = open(e, e.interfaceName);
        note(current, e);
        const prev = current.path[current.path.length - 1] ?? e.interfaceName;
        if (e.toInterface) {
          current.path.push(e.toInterface);
          current.hops.push({
            at: e.at, from: prev, to: e.toInterface,
            signalBefore: e.signal, signalAfter: null,
          });
        }
        if (e.ssid && !current.ssid) current.ssid = e.ssid;
        break;
      }

      case 'disconnected':
        if (!current) current = open(e, e.interfaceName);
        note(current, e);
        current.disconnectReason = e.reason;
        current.endedAt = e.at;
        sessions.push(current);
        current = null;
        break;

      case 'dhcp-assigned':
        if (current) { note(current, e); current.ip = e.ip; current.hostname = e.hostname; }
        break;

      case 'dhcp-released':
        if (current) note(current, e);
        break;
    }
  }
  if (current) sessions.push(current);

  for (const s of sessions) {
    s.durationSec = s.endedAt ? secondsBetween(s.startedAt, s.endedAt) : null;
    // Rate needs a meaningful window; over a few seconds it is noise, not a rate.
    if (s.durationSec != null && s.durationSec >= 60) {
      s.roamsPerHour = Math.round((s.hops.length / s.durationSec) * 3600 * 10) / 10;
    }
    // Fill in the signal recorded when the client landed on the new radio.
    for (const hop of s.hops) {
      const after = s.events.find(
        (e) => e.at > hop.at && e.signal != null && (e.interfaceName === hop.to || e.kind === 'roamed')
      );
      hop.signalAfter = after?.signal ?? null;
    }
  }
  return sessions;
}

/** Sessions where the client never settled on one radio. */
export function flappingSessions(sessions: RoamSession[], threshold = 6): RoamSession[] {
  return sessions.filter((s) => (s.roamsPerHour ?? 0) >= threshold);
}
