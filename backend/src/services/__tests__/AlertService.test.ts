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
