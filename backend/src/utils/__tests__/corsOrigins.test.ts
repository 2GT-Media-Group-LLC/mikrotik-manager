import {
  corsMiddlewareOptions,
  resetCorsResolvedCacheForTests,
  socketIoCorsOptions,
} from '../corsOrigins';

describe('corsOrigins', () => {
  const prev = { ...process.env };

  afterEach(() => {
    process.env = { ...prev };
    resetCorsResolvedCacheForTests();
  });

  it('uses wildcard in test when CORS_ORIGIN is unset', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.CORS_ORIGIN;
    expect(corsMiddlewareOptions()).toMatchObject({
      origin: '*',
      credentials: false,
    });
    expect(socketIoCorsOptions()).toMatchObject({
      origin: '*',
      credentials: false,
    });
  });

  it('parses comma-separated CORS_ORIGIN in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGIN = 'https://a.example.com, https://b.example.com ';
    const cors = corsMiddlewareOptions();
    expect(cors.credentials).toBe(true);
    expect(typeof cors.origin).toBe('function');
    const originFn = cors.origin as (
      o: string | undefined,
      fn: (e: Error | null, ok?: boolean) => void,
    ) => void;
    originFn(undefined, (err, ok) => {
      expect(err).toBeNull();
      expect(ok).toBe(true);
    });
    originFn('https://a.example.com', (err, ok) => {
      expect(err).toBeNull();
      expect(ok).toBe(true);
    });
    originFn('https://evil.com', (err, ok) => {
      expect(err).toBeNull();
      expect(ok).toBe(false);
    });
    expect(socketIoCorsOptions()).toEqual({
      origin: ['https://a.example.com', 'https://b.example.com'],
      methods: ['GET', 'POST'],
      credentials: true,
    });
  });
});
