import { describe, it, expect } from 'vitest';
import { deviceFromJumpHost } from './jumpHostDevice';

const base = {
  name: 'Cambridge Router', host: '203.0.113.10', port: 22, site_id: 4,
  auth: 'password' as const, username: 'mtm', credential_preset_id: null,
};

describe('deviceFromJumpHost', () => {
  it('fills in the name, address, site and password login, reached directly', () => {
    expect(deviceFromJumpHost(base, 's3cret')).toEqual({
      name: 'Cambridge Router', ip_address: '203.0.113.10', site_id: 4,
      jump_host_id: null, api_username: 'mtm', api_password: 's3cret',
    });
  });

  it("carries the SSH port when it isn't 22", () => {
    expect(deviceFromJumpHost({ ...base, port: 2222 }, 'x').ssh_port).toBe(2222);
  });

  it('leaves the site to the form for a fleet-wide jump host', () => {
    expect(deviceFromJumpHost({ ...base, site_id: null }, 'x')).not.toHaveProperty('site_id');
  });

  it('uses the same credential preset', () => {
    const p = deviceFromJumpHost({ ...base, auth: 'preset', username: null, credential_preset_id: 7 }, '');
    expect(p.credential_preset_id).toBe(7);
    expect(p).not.toHaveProperty('api_username');
    expect(p).not.toHaveProperty('api_password');
  });

  it('fills in only the username for a private key', () => {
    const p = deviceFromJumpHost({ ...base, auth: 'key' }, '');
    expect(p.api_username).toBe('mtm');
    expect(p).not.toHaveProperty('api_password');
  });
});
