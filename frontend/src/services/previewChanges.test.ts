import { describe, it, expect, beforeEach } from 'vitest';
import type { InternalAxiosRequestConfig } from 'axios';
import api, { previewChanges, devicesApi, networkServicesApi } from './api';

const sent: InternalAxiosRequestConfig[] = [];

beforeEach(() => {
  sent.length = 0;
  api.defaults.adapter = async (config) => {
    sent.push(config);
    const preview = config.headers['X-Preview-Changes'] === '1';
    return { data: preview ? { preview: { steps: [], verdict: null } } : { message: 'applied' }, status: 200, statusText: 'OK', headers: {}, config };
  };
});

describe('previewChanges', () => {
  it('marks the request it wraps as a preview', async () => {
    const p = await previewChanges(() => devicesApi.updateInterface(8, 'ether1', { comment: 'x' } as never));
    expect(p).toEqual({ steps: [], verdict: null });
    expect(sent).toHaveLength(1);
    expect(sent[0].headers['X-Preview-Changes']).toBe('1');
  });

  it('works for a query-string device too', async () => {
    await previewChanges(() => networkServicesApi.setNtp(8, { enabled: true, servers: ['pool.ntp.org'] } as never));
    expect(sent[0].headers['X-Preview-Changes']).toBe('1');
  });

  it('leaves later requests alone', async () => {
    await previewChanges(() => devicesApi.updateInterface(8, 'ether1', { comment: 'x' } as never));
    await devicesApi.updateInterface(8, 'ether1', { comment: 'x' } as never);
    expect(sent[1].headers['X-Preview-Changes']).toBeUndefined();
  });

  it('refuses a call that does not send straight away, rather than letting it apply unmarked', async () => {
    await expect(previewChanges(async () => {
      await Promise.resolve();
      return { data: {} };
    })).rejects.toThrow("can't be previewed");
  });
});

describe('previewChanges with a form that rejects its own input', () => {
  it('passes the form\'s reason through', async () => {
    await expect(previewChanges(() => Promise.reject(new Error('SSID name is required')))).rejects.toThrow('SSID name is required');
    expect(sent).toHaveLength(0);
  });
});
