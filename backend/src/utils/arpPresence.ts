/**
 * What one ARP entry says about whether a client is here now (#363).
 *
 * RouterOS 7 reports each entry's Linux neighbour state in `status`. `stale`
 * and `failed` entries keep their MAC (stale ones even keep the complete flag)
 * until garbage collection removes them, which on a quiet VLAN takes days. So
 * counting every entry kept phones "online" all weekend after they'd left:
 * aziz measured 131 of 138 on one site.
 *
 * - `live`: reachable, delay or probe (the router is talking to it now), or
 *   permanent (a static entry). Also any entry without a status, as RouterOS 6
 *   gives, and states this doesn't know, so nothing new goes missing.
 * - `stale`: may still be here. It keeps an already-online client online for a
 *   short grace period (see ARP_STALE_GRACE_MINUTES) but never brings one online.
 * - `none`: failed or incomplete, or no MAC. Not a sighting.
 */
export type ArpSighting = 'live' | 'stale' | 'none';

/**
 * How long a stale ARP entry alone keeps a client online after its last live
 * sighting. An entry goes stale about 30 seconds after the router last
 * confirmed it, so a printer or a phone on standby that's still here spends
 * most of its time stale; clients are read every fast poll, which only now and
 * then catches it live. Fifteen minutes covers those gaps without flicker, and
 * a phone that has left still goes offline within that time.
 */
export const ARP_STALE_GRACE_MINUTES = 15;

export function arpSighting(entry: Record<string, string | undefined>): ArpSighting {
  if (!entry['mac-address']) return 'none';
  if (entry['incomplete'] === 'true') return 'none';
  const status = (entry['status'] || '').trim().toLowerCase();
  if (status === 'failed' || status === 'incomplete') return 'none';
  if (status === 'stale') return 'stale';
  return 'live';
}
