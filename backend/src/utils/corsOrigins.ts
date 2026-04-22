import type { CorsOptions } from 'cors';

/** Browser dev servers and typical local access through nginx. */
const DEFAULT_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost',
  'http://127.0.0.1',
  'https://localhost',
  'https://127.0.0.1',
];

type Resolved =
  | { kind: 'wildcard' }
  | { kind: 'list'; allowed: string[] };

function parseList(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function resolveCors(): Resolved {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const raw = process.env.CORS_ORIGIN?.trim();

  if (raw === '*') {
    if (nodeEnv === 'production') {
      console.error(
        'CORS_ORIGIN=* is not allowed in production. Set a comma-separated list of browser origins (e.g. https://manager.example.com).',
      );
      process.exit(1);
    }
    return { kind: 'wildcard' };
  }

  if (!raw) {
    if (nodeEnv === 'production') {
      console.error(
        'CORS_ORIGIN is required in production (comma-separated origins, e.g. https://manager.example.com).',
      );
      process.exit(1);
    }
    if (nodeEnv === 'test') {
      return { kind: 'wildcard' };
    }
    return { kind: 'list', allowed: DEFAULT_DEV_ORIGINS };
  }

  return { kind: 'list', allowed: parseList(raw) };
}

let resolvedCache: Resolved | null = null;

function getResolved(): Resolved {
  if (!resolvedCache) resolvedCache = resolveCors();
  return resolvedCache;
}

/** Clears memoized CORS resolution (for Jest when env changes between cases). */
export function resetCorsResolvedCacheForTests(): void {
  resolvedCache = null;
}

/** Express `cors` middleware options (no `origin: *` with `credentials: true`). */
export function corsMiddlewareOptions(): CorsOptions {
  const resolved = getResolved();
  if (resolved.kind === 'wildcard') {
    return { origin: '*', credentials: false };
  }
  const allowed = resolved.allowed;
  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowed.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  };
}

/** Socket.IO server `cors` field — must align with HTTP CORS. */
export function socketIoCorsOptions(): {
  origin: string | string[];
  methods: string[];
  credentials: boolean;
} {
  const resolved = getResolved();
  if (resolved.kind === 'wildcard') {
    return { origin: '*', methods: ['GET', 'POST'], credentials: false };
  }
  return {
    origin: resolved.allowed,
    methods: ['GET', 'POST'],
    credentials: true,
  };
}
