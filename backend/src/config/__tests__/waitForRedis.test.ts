import { waitForRedis } from '../redis';

// A stand-in for the ioredis client: down for the first `downFor` checks, then up.
function fakeClient(downFor: number, pingError?: string) {
  let checks = 0;
  const client = {
    status: 'wait' as string,
    connect: jest.fn(async () => { client.status = 'reconnecting'; throw new Error('Connection is closed.'); }),
    ping: jest.fn(async () => {
      if (pingError) throw new Error(pingError);
      return 'PONG';
    }),
  };
  const tick = () => { checks += 1; if (checks >= downFor) client.status = 'ready'; };
  return { client, tick };
}

describe('waitForRedis (D507)', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); log.mockRestore(); });

  it('returns at once when Redis answers', async () => {
    const { client } = fakeClient(0);
    client.status = 'ready';
    await waitForRedis(client as never, 1, 0);
    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps waiting when the first connect fails, until Redis comes up', async () => {
    const { client, tick } = fakeClient(5);
    const timer = setInterval(tick, 2);
    try {
      await waitForRedis(client as never, 1, 0);
    } finally {
      clearInterval(timer);
    }
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.status).toBe('ready');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Waiting for Redis'));
    expect(log).toHaveBeenCalledWith('Redis is up; starting');
  });

  it('says why when Redis is up but refuses the password', async () => {
    const { client } = fakeClient(0, 'WRONGPASS invalid username-password pair');
    client.status = 'ready';
    const waiting = waitForRedis(client as never, 1, 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WRONGPASS'));
    client.ping.mockResolvedValue('PONG');
    await waiting;
  });
});
