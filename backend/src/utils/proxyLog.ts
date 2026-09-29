/**
 * Parse proxy access-log lines that a RouterOS container writes to the device log.
 *
 * A line is a candidate when its topics are exactly container,info,debug (what the
 * proxy containers log under). The container name is operator-chosen ("3proxy-18",
 * "myproxy", ...), so it is not matched: an optional "<name>: " prefix becomes the
 * source, and the remainder must be a JSON object carrying at least client.ip.
 */

/** Topics the proxy containers log under; order and extra topics are irrelevant. */
const REQUIRED_TOPICS = ['container', 'info', 'debug'];

export type ProxyStatus = 'ok' | 'denied' | 'error';

export interface ProxyConnection {
  source: string;
  eventTime: Date;
  proxyType: string;
  proxyPort: number | null;
  clientIp: string;
  clientPort: number | null;
  serverIp: string | null;
  serverPort: number | null;
  authUser: string | null;
  hostname: string | null;
  method: string | null;
  bytesSent: number;
  bytesReceived: number;
  errorCode: string | null;
  status: ProxyStatus;
}

/** Drop per-worker suffixes so "3proxy-17" and "3proxy-b-32" both become "3proxy". */
const normaliseSource = (name: string): string =>
  name.replace(/(-[a-z])?-\d+$/i, '') || 'proxy';

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

export function parseProxyLog(
  topics: string | null | undefined,
  message: string | null | undefined,
): ProxyConnection | null {
  if (!message || !topics) return null;
  const tokens = topics.split(',').map((t) => t.trim());
  if (!REQUIRED_TOPICS.every((t) => tokens.includes(t))) return null;

  // "<name>: {json}" or bare "{json}".
  let name = '';
  let rest = message.trimStart();
  if (rest[0] !== '{') {
    const colon = message.indexOf(': ');
    if (colon < 1 || colon > 64) return null;
    name = message.slice(0, colon).trim();
    rest = message.slice(colon + 2).trimStart();
    if (rest[0] !== '{') return null;
  }

  let j: Record<string, any>;
  try {
    j = JSON.parse(rest);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;

  const clientIp = str(j.client?.ip);
  if (!clientIp) return null;
  const proxyType = str(j.proxy?.type) ?? 'UNKNOWN';

  const unix = num(j.time_unix);
  if (unix === null || unix <= 0) return null;

  const serverPort = num(j.server?.port);
  const serverIpRaw = str(j.server?.ip);
  const noServer = !serverIpRaw || serverIpRaw === '0.0.0.0' || serverPort === 0;
  const errorCode = str(j.error?.code);
  const user = str(j.auth?.user);
  const reqMsg = str(j.message);

  let status: ProxyStatus = 'ok';
  if (errorCode && !/^0+$/.test(errorCode)) status = noServer ? 'denied' : 'error';

  return {
    source: normaliseSource(name),
    eventTime: new Date(unix * 1000),
    proxyType,
    proxyPort: num(j.proxy?.port),
    clientIp,
    clientPort: num(j.client?.port),
    serverIp: noServer ? null : serverIpRaw,
    serverPort: noServer ? null : serverPort,
    authUser: user && user !== '-' ? user : null,
    hostname: (() => {
      const h = str(j.request?.hostname);
      return h && h !== '[0.0.0.0]' ? h : null;
    })(),
    method: reqMsg ? reqMsg.split(/\s+/)[0].toUpperCase().slice(0, 16) : null,
    bytesSent: Math.max(0, num(j.bytes?.sent) ?? 0),
    bytesReceived: Math.max(0, num(j.bytes?.received) ?? 0),
    errorCode,
    status,
  };
}
