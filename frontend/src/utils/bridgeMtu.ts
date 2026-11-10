/**
 * A bridge's MTU in the Bridges tab's edit form: "auto" (RouterOS's default,
 * the lowest of its ports') or a number no bigger than the smallest L2 MTU of
 * its ports. The server checks the same; RouterOS itself only says "could not
 * set mtu".
 */
import type { BridgeView } from '../services/api';

/** The most the bridge's MTU can be, from its ports' L2 MTUs. Null when unknown. */
export function bridgeMtuCeiling(b: Pick<BridgeView, 'ports'>): number | null {
  const sizes = b.ports.map((p) => p.l2mtu).filter((n): n is number => typeof n === 'number');
  return sizes.length ? Math.min(...sizes) : null;
}

/** What's wrong with `value` as this bridge's MTU, or null. */
export function bridgeMtuError(value: string, b: Pick<BridgeView, 'ports'>): string | null {
  const v = value.trim().toLowerCase();
  if (v === 'auto' || v === '') return null;
  if (!/^\d+$/.test(v) || Number(v) < 576 || Number(v) > 65535) return 'auto, or a number from 576 to 65535';
  const n = Number(v);
  const small = b.ports.filter((p) => typeof p.l2mtu === 'number' && p.l2mtu < n);
  if (!small.length) return null;
  const names = small.slice(0, 3).map((p) => `${p.name} (${p.l2mtu})`).join(', ') + (small.length > 3 ? ` and ${small.length - 3} more` : '');
  return `More than the L2 MTU of ${names}. Raise ${small.length === 1 ? 'its' : 'their'} MTU on the Ports tab first, or keep it at ${bridgeMtuCeiling(b)} or less.`;
}
