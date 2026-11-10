/**
 * MTU checks for the port and bridge edit forms. RouterOS clamps a port's MTU
 * to what its hardware takes (max-l2mtu: 2028 on a CRS510's management port)
 * without saying so, and refuses a bridge MTU above its ports' L2 MTU with
 * only "could not set mtu". The server checks the same things.
 */
import type { BridgeView } from '../services/api';

/** What's wrong with `value` as a port's MTU, given its hardware maximum (max-l2mtu), or null. */
export function portMtuError(value: string, max: number | null): string | null {
  const v = value.trim();
  const top = max && max > 0 ? max : 65535;
  if (!/^\d+$/.test(v) || Number(v) < 576) return `576 to ${top}`;
  if (Number(v) > top) return max ? `${max} is the most this port's hardware takes.` : 'At most 65535.';
  return null;
}

/** A port's max-l2mtu from its stored RouterOS row, if known. */
export function portMtuMax(configJson: Record<string, unknown> | null | undefined): number | null {
  const n = Number(configJson?.['max-l2mtu']);
  return Number.isFinite(n) && n > 0 ? n : null;
}

type Ports = Pick<BridgeView, 'ports'>;

/** The most the bridge's MTU can be now, from its ports' L2 MTUs. Null when unknown. */
export function bridgeMtuCeiling(b: Ports): number | null {
  const sizes = b.ports.map((p) => p.l2mtu).filter((n): n is number => typeof n === 'number');
  return sizes.length ? Math.min(...sizes) : null;
}

const names = (ps: { name: string }[], n: (p: Ports['ports'][number]) => number | null | undefined) =>
  ps.slice(0, 3).map((p) => `${p.name} (${n(p as Ports['ports'][number])})`).join(', ') + (ps.length > 3 ? ` and ${ps.length - 3} more` : '');

/** What's wrong with `value` as this bridge's MTU, or null. */
export function bridgeMtuError(value: string, b: Ports): string | null {
  const v = value.trim().toLowerCase();
  if (v === 'auto' || v === '') return null;
  if (!/^\d+$/.test(v) || Number(v) < 576 || Number(v) > 65535) return 'auto, or a number from 576 to 65535';
  const n = Number(v);
  const small = b.ports.filter((p) => typeof p.l2mtu === 'number' && p.l2mtu < n);
  if (!small.length) return null;
  const capped = small.filter((p) => typeof p.maxL2mtu === 'number' && p.maxL2mtu < n);
  const raisable = small.filter((p) => !capped.includes(p));
  const out: string[] = [];
  if (raisable.length) out.push(`Raise the MTU of ${names(raisable, (p) => p.l2mtu)} on the Ports tab first.`);
  if (capped.length) {
    out.push(`${names(capped, (p) => p.maxL2mtu)} can't go that high; take ${capped.length === 1 ? 'it' : 'them'} out of the bridge, `
      + `or keep it at ${Math.min(...capped.map((p) => p.maxL2mtu as number))} or less.`);
  } else {
    out.push(`Or keep it at ${bridgeMtuCeiling(b)} or less.`);
  }
  return out.join(' ');
}
