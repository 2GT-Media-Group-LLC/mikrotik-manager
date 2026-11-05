import { describe, it, expect } from 'vitest';
import { entryErrors, entryForm, entryBody, ipRangeError, versionError, packagesError, cacheDirectoryError, OPEN_ENTRY_MESSAGE } from './netinstall';

const ctx = { interfaces: ['ether1', 'bridge'], packages: ['routeros'] };

describe('netinstall entry form', () => {
  it('a new entry waits by default, so it can be saved with just an interface', () => {
    const f = { ...entryForm(), interface: 'ether1' };
    expect(f.wait).toBe(true);
    expect(f.allowFlashfig).toBe(false);
    expect(entryErrors(f, ctx)).toEqual({});
  });

  it('needs a MAC or wait, as the server does', () => {
    const f = { ...entryForm(), interface: 'ether1', wait: false };
    expect(entryErrors(f, ctx).mac).toBe(OPEN_ENTRY_MESSAGE);
    expect(entryErrors({ ...f, mac: '02:00:00:00:00:01' }, ctx)).toEqual({});
    expect(entryErrors({ ...f, disabled: true }, ctx)).toEqual({});
    expect(entryErrors({ ...f, mac: 'ff:ff:ff:ff:ff:ff' }, ctx).mac).toMatch(/multicast/);
    expect(entryErrors({ ...f, mac: '', wait: true }, { ...ctx, hadMac: true }).mac).toMatch(/Delete the entry/);
  });

  it('checks the rest of the fields', () => {
    const e = entryErrors({ ...entryForm(), interface: 'ether9', ipRange: 'x', version: 'banana', extraPackages: ['notapkg'], applyDefault: true, comment: 'a\nb' }, ctx);
    expect(Object.keys(e).sort()).toEqual(['applyDefault', 'comment', 'extraPackages', 'interface', 'ipRange', 'version']);
  });

  it('round-trips an entry as RouterOS prints it', () => {
    const row = { '.id': '*1', interface: 'bridge', 'mac-address': '02:00:00:00:00:01', 'extra-packages': 'wifi-qcom', 'keep-old-configuration': 'true',
      'apply-default-configuration': 'false', 'install-once': 'false', 'remove-branding': 'false', 'auto-reboot': 'shutdown', wait: 'false',
      'allow-etherboot': 'true', 'allow-flashfig': 'false', disabled: 'false' };
    const f = entryForm(row);
    expect(f).toMatchObject({ interface: 'bridge', mac: '02:00:00:00:00:01', extraPackages: ['wifi-qcom'], autoReboot: 'shutdown', wait: false, installOnce: false });
    const b = entryBody(f);
    expect(b).toMatchObject({ interface: 'bridge', 'mac-address': '02:00:00:00:00:01', 'extra-packages': 'wifi-qcom', wait: false });
    expect('ip-range' in b).toBe(false);
    expect('comment' in entryBody({ ...f, comment: '' })).toBe(false);
    expect(entryBody({ ...f, comment: '' }, true).comment).toBe('');
  });
});

describe('netinstall values', () => {
  it('match the server', () => {
    expect(ipRangeError('192.168.88.10 - 192.168.88.20')).toBeNull();
    expect(ipRangeError('10.0.0.1-10.0.2.1')).toMatch(/256/);
    expect(versionError('')).toBeNull();
    expect(versionError('7.26beta2')).toBeNull();
    expect(versionError('6.49')).toMatch(/RouterOS 7/);
    expect(packagesError(['container', 'routeros'], [])).toBeNull();
    expect(packagesError(['shiny'], ['shiny'])).toBeNull();
    expect(cacheDirectoryError('usb1/NetinstallCache/', ['usb1'])).toBeNull();
    expect(cacheDirectoryError('usb2/x', ['usb1'])).toMatch(/usb2/);
  });
});
