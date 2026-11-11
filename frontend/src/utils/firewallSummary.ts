// Pure helpers for the firewall UI: byte formatting and plain-English rule
// summaries ("Allow TCP from LAN to any on 443"). Kept separate so they're
// unit-testable without rendering.

export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
}

const ACTION_VERB: Record<string, string> = {
  accept: 'Allow', drop: 'Drop', reject: 'Reject', tarpit: 'Tarpit',
  log: 'Log', jump: 'Jump to', return: 'Return', passthrough: 'Pass through',
  masquerade: 'Masquerade', 'src-nat': 'Source-NAT', 'dst-nat': 'Forward',
  netmap: '1:1 NAT', redirect: 'Redirect',
};

type Ruleish = Record<string, string | undefined>;

function endpoint(addr?: string, list?: string, iface?: string): string {
  if (list) return `list:${list}`;
  if (addr) return addr;
  if (iface) return `if:${iface}`;
  return 'any';
}

// Build a readable one-liner for a firewall filter rule. Accepts RouterOS
// dashed keys (e.g. 'src-address') as returned by the API.
export function ruleSummary(r: Ruleish): string {
  const action = (r.action ?? '').toLowerCase();
  const verb = ACTION_VERB[action] ?? action ?? 'rule';
  const proto = r.protocol ? r.protocol.toUpperCase() : 'any';
  const src = endpoint(r['src-address'], r['src-address-list'], r['in-interface']);
  const dst = endpoint(r['dst-address'], r['dst-address-list'], r['out-interface']);
  const port = r['dst-port'] ? ` on ${r['dst-port']}` : '';
  const state = r['connection-state'] ? ` [${r['connection-state']}]` : '';
  const tgt = action === 'jump' && r['jump-target'] ? ` ${r['jump-target']}` : '';
  return `${verb}${tgt} ${proto} from ${src} to ${dst}${port}${state}`;
}

// Readable one-liner for a NAT rule.
export function natSummary(r: Ruleish): string {
  const action = (r.action ?? '').toLowerCase();
  if (action === 'masquerade') {
    return `Masquerade ${endpoint(r['src-address'])} out ${r['out-interface'] || 'any'}`;
  }
  if (action === 'dst-nat') {
    const proto = r.protocol ? r.protocol.toUpperCase() : '';
    const ext = r['dst-port'] ? `:${r['dst-port']}` : '';
    const to = [r['to-addresses'], r['to-ports'] && `:${r['to-ports']}`].filter(Boolean).join('');
    return `Forward ${proto} ${endpoint(r['dst-address'], undefined, r['in-interface'])}${ext} → ${to || 'target'}`;
  }
  // The WAN a source translation leaves by, or a destination one arrives on (#440).
  const out = r['out-interface'] ? ` out ${r['out-interface']}` : '';
  const via = r['in-interface'] ? ` in ${r['in-interface']}` : '';
  if (action === 'src-nat') {
    return `Source-NAT ${endpoint(r['src-address'])} → ${r['to-addresses'] || 'target'}${out}`;
  }
  if (action === 'netmap') {
    if ((r.chain ?? '').toLowerCase() === 'srcnat') {
      return `Netmap ${endpoint(r['src-address'])} → ${r['to-addresses'] || 'target'}${out}`;
    }
    return `1:1 NAT ${endpoint(r['dst-address'])} ↔ ${r['to-addresses'] || 'target'}${via}`;
  }
  if (action === 'redirect') {
    return `Redirect ${r.protocol?.toUpperCase() || ''} ${r['dst-port'] || ''} → router:${r['to-ports'] || ''}`;
  }
  return `${ACTION_VERB[action] ?? action} (${r.chain})`;
}
