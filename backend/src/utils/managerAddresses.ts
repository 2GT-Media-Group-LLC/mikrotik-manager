/**
 * The addresses this manager reaches each device from, as that device sees
 * them (S9): learned by the log collector from /user/active during its own
 * session. Shared so the log collector can drop its own login noise and the
 * NetFlow collector can leave the manager's own traffic out of client
 * analytics (#345). In memory, per process; a few kept per device for a
 * manager that reaches it over more than one path.
 */
const byDevice = new Map<number, Set<string>>();
const MAX_PER_DEVICE = 4;

export function rememberManagerAddress(deviceId: number, address: string | null): ReadonlySet<string> {
  let known = byDevice.get(deviceId);
  if (!known) { known = new Set(); byDevice.set(deviceId, known); }
  if (address && !known.has(address)) {
    known.add(address);
    while (known.size > MAX_PER_DEVICE) known.delete(known.values().next().value as string);
  }
  return known;
}

export function managerAddressesFor(deviceId: number): ReadonlySet<string> {
  return byDevice.get(deviceId) ?? new Set();
}
