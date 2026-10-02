import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';

const execFileAsync = promisify(execFile);

/**
 * Read the backend server's kernel ARP cache from /proc/net/arp.
 * Returns a MAC → IPv4 map of all currently cached entries.
 * Works on Linux; on macOS Docker Desktop the container is NATted so
 * this will only show Docker-internal bridge entries.
 */
async function readKernelArpCache(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  try {
    const content = await readFile('/proc/net/arp', 'utf8');
    for (const line of content.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      // Format: IP  HW-type  Flags  HW-address  Mask  Device
      if (parts.length >= 4) {
        const ip = parts[0];
        const mac = parts[3].toLowerCase();
        if (ip && mac && mac !== '00:00:00:00:00:00' && ip !== '0.0.0.0') {
          map[mac] = ip;
        }
      }
    }
  } catch {
    // /proc/net/arp not available (non-Linux or permission denied)
  }
  return map;
}

/**
 * Run arp-scan on all local network interfaces to actively discover
 * MAC → IPv4 mappings on the same subnet as the backend container.
 *
 * Requires: arp-scan installed + NET_RAW capability (set via docker-compose
 * cap_add / setcap on the binary). Fails gracefully if unavailable.
 *
 * Note: On macOS Docker Desktop the container is NATted inside a Linux VM,
 * so arp-scan will only see other Docker containers, NOT physical network hosts.
 * On a Linux host with bridge or macvlan Docker networking this WILL find
 * devices on the same physical subnet.
 */
async function runArpScan(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  try {
    const { stdout } = await execFileAsync(
      'arp-scan',
      ['--localnet', '--quiet', '--retry=2'],
      { timeout: 12000 }
    );
    for (const line of stdout.split('\n')) {
      // Output lines: "<IP>\t<MAC>\t<description>"
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && /^\d+\.\d+\.\d+\.\d+$/.test(parts[0])) {
        const ip = parts[0];
        const mac = parts[1].toLowerCase();
        if (ip && mac) map[mac] = ip;
      }
    }
  } catch {
    // arp-scan not installed, lacks permissions, or timed out
  }
  return map;
}

/**
 * Build a combined MAC → IPv4 map using the server's own ARP data.
 * Called once per collectNeighbors() run to avoid re-scanning per neighbour.
 */
export async function buildServerArpMap(): Promise<Record<string, string>> {
  const [passive, active] = await Promise.all([
    readKernelArpCache(),
    sharedArpScan(),
  ]);
  // Passive cache takes precedence over scan (it's live kernel state)
  return { ...active, ...passive };
}

/**
 * One arp-scan shared by every device's neighbour poll for a few minutes
 * (outside review J13). Each slow poll of each device used to start its own,
 * so a large fleet ran several 12-second scans a second over the same subnet,
 * for a result that doesn't change between them. Concurrent callers share the
 * scan in progress.
 */
const ARP_SCAN_TTL_MS = 5 * 60_000;
let arpScanCache: { at: number; result: Promise<Record<string, string>> } | null = null;

function sharedArpScan(now = Date.now()): Promise<Record<string, string>> {
  if (!arpScanCache || now - arpScanCache.at > ARP_SCAN_TTL_MS) {
    arpScanCache = { at: now, result: runArpScan() };
  }
  return arpScanCache.result;
}

/** For tests. */
export function _resetArpScanCache(): void {
  arpScanCache = null;
}
