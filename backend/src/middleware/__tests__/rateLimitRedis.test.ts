const mockEval = jest.fn();
jest.mock('../../config/redis', () => ({ limiterRedis: () => ({ eval: mockEval }) }));
jest.mock('../../config/database', () => ({ query: jest.fn().mockResolvedValue([]) }));

import type { Request, Response } from 'express';
import { rateLimitRedis, memoryLimitExceeded } from '../rateLimitRedis';

// Outside review S5.
describe('rateLimitRedis', () => {
  const res = () => {
    const r = { headers: new Map<string, string>(), statusCode: 200, setHeader(k: string, v: string) { this.headers.set(k, v); }, status(c: number) { this.statusCode = c; return this; }, json() { return this; } };
    return r as unknown as Response & { statusCode: number; headers: Map<string, string> };
  };
  const req = { method: 'POST', ip: '10.0.0.9' } as Request;
  const limiter = rateLimitRedis({ windowSec: 60, max: 2, keyPrefix: 't' });

  beforeEach(() => mockEval.mockReset());

  it('counts and expires in one atomic script call', async () => {
    mockEval.mockResolvedValue([1, 60_000]);
    const next = jest.fn();
    await limiter(req, res(), next);
    expect(next).toHaveBeenCalled();
    expect(mockEval).toHaveBeenCalledTimes(1);
    const [script, nKeys, key, windowMs] = mockEval.mock.calls[0];
    expect(script).toMatch(/INCR[\s\S]*PEXPIRE/);
    expect([nKeys, key, windowMs]).toEqual([1, 'rl:t:ip:10.0.0.9', '60000']);
  });

  it('refuses over the limit with the time left', async () => {
    mockEval.mockResolvedValue([3, 12_400]);
    const r = res();
    const next = jest.fn();
    await limiter(req, r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(429);
    expect(r.headers.get('Retry-After')).toBe('13');
  });

  it('falls back to memory when Redis fails', async () => {
    mockEval.mockRejectedValue(new Error("Stream isn't writeable"));
    const fallbackReq = { method: 'POST', ip: '10.0.0.77' } as Request;
    const next = jest.fn();
    for (let i = 0; i < 3; i++) await limiter(fallbackReq, res(), next);
    expect(next).toHaveBeenCalledTimes(2); // the third is refused
  });
});

describe('memoryLimitExceeded', () => {
  it("keeps each bucket's own window", () => {
    const t0 = 1_000_000_000;
    // A 900-second login bucket with two hits.
    memoryLimitExceeded('login', 900, 2, t0);
    memoryLimitExceeded('login', 900, 2, t0 + 1_000);
    // Two minutes later a 60-second bucket is used, past the sweep interval.
    memoryLimitExceeded('other', 60, 5, t0 + 120_000);
    // The login hits are still inside their 15 minutes, so a third goes over.
    expect(memoryLimitExceeded('login', 900, 2, t0 + 121_000)).toBe(true);
  });
});
