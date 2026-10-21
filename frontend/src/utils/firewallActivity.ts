export type FirewallCounterRule = Record<string, string> & { '.id': string };

export const FIREWALL_ACTIVITY_SAMPLE_MS = 5_000;
export const HIGH_VOLUME_PACKETS_PER_MINUTE = 1_000;

export interface FirewallRuleActivity {
  packetsPerMinute: number;
  highVolume: boolean;
}

export function firewallPacketCount(
  rule: Record<string, string>
): number | null {
  const raw = rule.packets?.trim();

  if (!raw || !/^\d+$/.test(raw)) return null;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;

  return value;
}

export function estimateFirewallActivity(
  before: FirewallCounterRule[],
  after: FirewallCounterRule[],
  elapsedMs: number
): Record<string, FirewallRuleActivity> {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return {};

  const beforeCounts = new Map<string, number>();

  for (const rule of before) {
    const count = firewallPacketCount(rule);
    if (count !== null) beforeCounts.set(rule['.id'], count);
  }

  const activity: Record<string, FirewallRuleActivity> = {};

  for (const rule of after) {
    const previous = beforeCounts.get(rule['.id']);
    const current = firewallPacketCount(rule);

    if (previous === undefined || current === null || current < previous) {
      continue;
    }

    const packetsPerMinute =
      ((current - previous) * 60_000) / elapsedMs;

    activity[rule['.id']] = {
      packetsPerMinute,
      highVolume:
        packetsPerMinute >= HIGH_VOLUME_PACKETS_PER_MINUTE,
    };
  }

  return activity;
}
