jest.mock('../../config/database');
jest.mock('nodemailer');

import { AlertService } from '../AlertService';
import { query } from '../../config/database';

const mockedQuery = jest.mocked(query);

// Minimal rule and channel fixtures
const enabledRule = { event_type: 'device_offline', enabled: true, threshold: null, cooldown_min: 15 };
const disabledRule = { event_type: 'device_online', enabled: false, threshold: null, cooldown_min: 15 };
const slackChannel = { id: 1, name: 'slack-test', type: 'slack' as const, enabled: true, config: { webhook_url: 'https://hooks.example.com/test' } };

beforeEach(() => {
  jest.clearAllMocks();
});

// ── dispatch ─────────────────────────────────────────────────────────────────

describe('dispatch', () => {
  it('does nothing when the rule is disabled', async () => {
    mockedQuery.mockResolvedValueOnce([disabledRule]);
    const service = new AlertService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendSpy = jest.spyOn(service as any, 'sendToChannel').mockResolvedValue(undefined);
    await service.dispatch('device_online', 'came back', { cooldownKey: 'test-disabled' });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('calls sendToChannel when the rule is enabled', async () => {
    mockedQuery
      .mockResolvedValueOnce([enabledRule])
      .mockResolvedValueOnce([slackChannel])
      .mockResolvedValueOnce([]);
    const service = new AlertService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendSpy = jest.spyOn(service as any, 'sendToChannel').mockResolvedValue(undefined);
    await service.dispatch('device_offline', 'went down', { cooldownKey: 'test-enabled' });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(slackChannel, 'device_offline', 'went down', expect.any(Object));
  });

  it('does nothing when no channels are configured', async () => {
    mockedQuery
      .mockResolvedValueOnce([enabledRule])
      .mockResolvedValueOnce([]);
    const service = new AlertService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendSpy = jest.spyOn(service as any, 'sendToChannel').mockResolvedValue(undefined);
    await service.dispatch('device_offline', 'msg', { cooldownKey: 'test-no-channels' });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('blocks a second dispatch during the cooldown window', async () => {
    jest.useFakeTimers();
    mockedQuery
      .mockResolvedValueOnce([enabledRule])   // rule for first dispatch
      .mockResolvedValueOnce([slackChannel])  // channels for first dispatch
      .mockResolvedValueOnce([]);             // history insert
    const service = new AlertService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendSpy = jest.spyOn(service as any, 'sendToChannel').mockResolvedValue(undefined);

    // First dispatch sets the cooldown
    await service.dispatch('high_cpu', 'cpu spike', { cooldownKey: 'cooldown-test-key' });
    expect(sendSpy).toHaveBeenCalledTimes(1);

    sendSpy.mockClear();
    // Second dispatch immediately — cooldown not yet expired
    mockedQuery.mockResolvedValueOnce([enabledRule]);
    await service.dispatch('high_cpu', 'cpu spike again', { cooldownKey: 'cooldown-test-key' });
    expect(sendSpy).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  it('allows dispatch again after the cooldown expires', async () => {
    jest.useFakeTimers();
    const shortCooldownRule = { ...enabledRule, cooldown_min: 1 };
    mockedQuery
      .mockResolvedValueOnce([shortCooldownRule])
      .mockResolvedValueOnce([slackChannel])
      .mockResolvedValueOnce([]);
    const service = new AlertService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendSpy = jest.spyOn(service as any, 'sendToChannel').mockResolvedValue(undefined);

    await service.dispatch('log_error', 'first', { cooldownKey: 'cooldown-expire-test' });
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Advance past 1-minute cooldown
    jest.advanceTimersByTime(61 * 1000);
    sendSpy.mockClear();

    mockedQuery
      .mockResolvedValueOnce([shortCooldownRule])
      .mockResolvedValueOnce([slackChannel])
      .mockResolvedValueOnce([]);
    await service.dispatch('log_error', 'second', { cooldownKey: 'cooldown-expire-test' });
    expect(sendSpy).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });
});

// ── slackColor ────────────────────────────────────────────────────────────────

describe('slackColor', () => {
  const service = new AlertService();
  const slackColor = (et: string) => (service as never as Record<string, (s: string) => string>).slackColor(et);

  it('returns "good" for device_online', () => {
    expect(slackColor('device_online')).toBe('good');
  });

  it('returns "danger" for device_offline', () => {
    expect(slackColor('device_offline')).toBe('danger');
  });

  it('returns "danger" for high_cpu', () => {
    expect(slackColor('high_cpu')).toBe('danger');
  });

  it('returns "warning" for cert_expiry', () => {
    expect(slackColor('cert_expiry')).toBe('warning');
  });
});

// ── discordColor ─────────────────────────────────────────────────────────────

describe('discordColor', () => {
  const service = new AlertService();
  const discordColor = (et: string) => (service as never as Record<string, (s: string) => number>).discordColor(et);

  it('returns green (0x22c55e) for device_online', () => {
    expect(discordColor('device_online')).toBe(0x22c55e);
  });

  it('returns amber (0xf59e0b) for log_warning', () => {
    expect(discordColor('log_warning')).toBe(0xf59e0b);
  });

  it('returns amber (0xf59e0b) for cert_expiry', () => {
    expect(discordColor('cert_expiry')).toBe(0xf59e0b);
  });

  it('returns red (0xef4444) for device_offline', () => {
    expect(discordColor('device_offline')).toBe(0xef4444);
  });
});

// ── ntfy (issue #93) ─────────────────────────────────────────────────────────

type NtfyService = {
  ntfyPriority(eventType: string): number;
  ntfyAuthHeaders(cfg: Record<string, unknown>): Record<string, string>;
  sendNtfy(
    cfg: Record<string, unknown>,
    eventType: string,
    message: string,
    ctx: { deviceId?: number; deviceName?: string; details?: string }
  ): Promise<void>;
  postJson(url: string, body: string, headers?: Record<string, string>): Promise<void>;
};

const asNtfy = (s: AlertService) => s as unknown as NtfyService;

describe('ntfyPriority', () => {
  const p = (et: string) => asNtfy(new AlertService()).ntfyPriority(et);

  it('raises priority above do-not-disturb only for things that are down', () => {
    expect(p('device_offline')).toBe(4);
    expect(p('log_error')).toBe(4);
    expect(p('high_cpu')).toBe(4);
  });

  it('keeps recovery and discovery quiet', () => {
    expect(p('device_online')).toBe(2);
    expect(p('device_discovered')).toBe(2);
  });

  it('leaves everything else at the default', () => {
    expect(p('cert_expiry')).toBe(3);
    expect(p('config_drift')).toBe(3);
    expect(p('something_new')).toBe(3);
  });
});

describe('ntfyAuthHeaders', () => {
  const h = (cfg: Record<string, unknown>) => asNtfy(new AlertService()).ntfyAuthHeaders(cfg);

  it('prefers an access token over basic auth', () => {
    expect(h({ token: 'tk_abc', username: 'u', password: 'p' }))
      .toEqual({ Authorization: 'Bearer tk_abc' });
  });

  it('falls back to basic auth', () => {
    expect(h({ username: 'alice', password: 'secret' }))
      .toEqual({ Authorization: `Basic ${Buffer.from('alice:secret').toString('base64')}` });
  });

  it('sends no auth for an unprotected topic', () => {
    expect(h({})).toEqual({});
  });

  it('ignores whitespace-only credentials rather than sending an empty bearer', () => {
    expect(h({ token: '   ' })).toEqual({});
  });
});

describe('sendNtfy', () => {
  function capture() {
    const service = new AlertService();
    const calls: { url: string; body: Record<string, unknown>; headers?: Record<string, string> }[] = [];
    asNtfy(service).postJson = async (url, body, headers) => {
      calls.push({ url, body: JSON.parse(body), headers });
    };
    return { service, calls };
  }

  it('posts to the public server by default with topic, title, priority and tag', async () => {
    const { service, calls } = capture();
    await asNtfy(service).sendNtfy({ topic: 'mt' }, 'device_offline', 'sw1 is unreachable', {});

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://ntfy.sh');
    expect(calls[0].body.topic).toBe('mt');
    expect(calls[0].body.priority).toBe(4);
    expect(calls[0].body.tags).toEqual(['device_offline']);
    expect(String(calls[0].body.title)).toContain('Device Offline');
  });

  it('honours a self-hosted server and strips a trailing slash', async () => {
    const { service, calls } = capture();
    await asNtfy(service).sendNtfy(
      { topic: 'mt', server_url: 'https://ntfy.internal.example.com/' },
      'device_online', 'back', {}
    );
    expect(calls[0].url).toBe('https://ntfy.internal.example.com');
  });

  it('includes the device name and details in the body', async () => {
    const { service, calls } = capture();
    await asNtfy(service).sendNtfy({ topic: 'mt' }, 'log_error', 'errors seen', {
      deviceName: 'sw1', details: 'login failure',
    });
    const msg = String(calls[0].body.message);
    expect(msg).toContain('errors seen');
    expect(msg).toContain('Device: sw1');
    expect(msg).toContain('login failure');
  });

  it('deep-links to the device when a manager URL is configured', async () => {
    const { service, calls } = capture();
    await asNtfy(service).sendNtfy(
      { topic: 'mt', click_url: 'https://mgr.example.com/' },
      'device_offline', 'down', { deviceId: 42 }
    );
    expect(calls[0].body.click).toBe('https://mgr.example.com/devices/42');
  });

  it('omits the click link entirely when no manager URL is set', async () => {
    const { service, calls } = capture();
    await asNtfy(service).sendNtfy({ topic: 'mt' }, 'device_offline', 'down', { deviceId: 42 });
    expect(calls[0].body.click).toBeUndefined();
  });

  it('rejects a missing topic rather than posting somewhere unintended', async () => {
    const { service, calls } = capture();
    await expect(asNtfy(service).sendNtfy({}, 'device_offline', 'x', {}))
      .rejects.toThrow(/missing topic/);
    expect(calls).toHaveLength(0);
  });

  it('rejects a non-http server URL', async () => {
    const { service } = capture();
    await expect(
      asNtfy(service).sendNtfy({ topic: 'mt', server_url: 'file:///etc/passwd' }, 'device_offline', 'x', {})
    ).rejects.toThrow(/must be http/);
  });

  it('rejects an unparseable server URL', async () => {
    const { service } = capture();
    await expect(
      asNtfy(service).sendNtfy({ topic: 'mt', server_url: 'not a url' }, 'device_offline', 'x', {})
    ).rejects.toThrow(/invalid server_url/);
  });

  it('passes the auth header through to the request', async () => {
    const { service, calls } = capture();
    await asNtfy(service).sendNtfy({ topic: 'mt', token: 'tk_1' }, 'device_offline', 'x', {});
    expect(calls[0].headers).toEqual({ Authorization: 'Bearer tk_1' });
  });
});
