import {
  netinstallSupport, normalizeMac, ipRangeError, packageListCheck, checkEntry, isOpenEntry, checkInstall,
  cacheStorage, cacheEstimate, cacheSpaceProblem, packageSpaceProblem, cacheDirectoryError,
} from '../netinstall';

const MiB = 1024 * 1024;
const ctx = { interfaces: ['ether1', 'bridge', 'sfp-sfpplus1'], knownPackages: ['routeros', 'netinstall', 'my-new-pkg'] };

describe('netinstallSupport', () => {
  const d = (ros_version: string | null, architecture: string | null, installed_packages: string[] | null = ['routeros']) =>
    netinstallSupport({ ros_version, architecture, installed_packages });
  it('sorts devices by what they can do', () => {
    expect(d('7.25', 'arm', ['netinstall', 'routeros'])).toBe('installed');
    // Removed: still on flash, disabled.
    expect(netinstallSupport({ ros_version: '7.25', architecture: 'arm', installed_packages: ['netinstall', 'routeros'], disabled_packages: ['netinstall'] })).toBe('available');
    expect(d('7.25', 'arm')).toBe('available');
    expect(d('7.24beta1', 'arm64')).toBe('available');
    expect(d('7.23.1', 'arm')).toBe('too-old');
    expect(d('7.25', 'smips')).toBe('unsupported');
    expect(d(null, 'arm')).toBe('unknown');
    expect(d('banana', 'arm')).toBe('unknown');
    expect(d('7.25', null)).toBe('unknown');
  });
});

describe('values', () => {
  it('normalises MAC addresses', () => {
    expect(normalizeMac('01-23-45-67-89-ab')).toBe('01:23:45:67:89:AB');
    expect(normalizeMac('zz')).toBeNull();
    expect(normalizeMac('')).toBeNull();
  });
  it('checks BOOTP ranges', () => {
    expect(ipRangeError('192.168.88.10-192.168.88.20')).toBeNull();
    expect(ipRangeError('192.168.88.20-192.168.88.10')).toMatch(/lower/);
    expect(ipRangeError('10.0.0.0-10.0.4.0')).toMatch(/256/);
    expect(ipRangeError('nonsense')).toMatch(/range like/);
    expect(ipRangeError('1.2.3.4-1.2.3.400')).toMatch(/IPv4/);
  });
  it('accepts only real package names, and drops routeros', () => {
    expect(packageListCheck('wifi-qcom, container,wifi-qcom', [])).toEqual({ value: 'wifi-qcom,container', error: null });
    expect(packageListCheck('routeros,container', []).value).toBe('container');
    expect(packageListCheck('notapkg', []).error).toMatch(/notapkg/);
    expect(packageListCheck('my-new-pkg', ['my-new-pkg']).error).toBeNull();
    expect(packageListCheck('', []).value).toBe('');
  });
});

describe('checkEntry', () => {
  it('builds a safe new entry', () => {
    const r = checkEntry({ interface: 'ether1', 'mac-address': '01-23-45-67-89-aa'.replace(/^01/, '02'), 'ip-range': '192.168.88.10 - 192.168.88.20',
      version: '7.25', 'extra-packages': 'wifi-qcom', 'auto-reboot': 'reboot', comment: 'spare hAP' }, ctx);
    expect(r.errors).toEqual({});
    expect(r.params).toEqual({
      interface: 'ether1', 'mac-address': '02:23:45:67:89:AA', 'ip-range': '192.168.88.10-192.168.88.20', version: '7.25',
      'extra-packages': 'wifi-qcom', 'auto-reboot': 'reboot', comment: 'spare hAP', 'allow-flashfig': 'no',
    });
  });

  it('refuses an entry that would install any device that etherboots', () => {
    const r = checkEntry({ interface: 'ether1' }, ctx);
    expect(r.errors['mac-address']).toMatch(/any device on this segment/);
    expect(r.params).toEqual({});
    // Wait makes each install a deliberate step.
    expect(checkEntry({ interface: 'ether1', wait: true }, ctx).errors).toEqual({});
    // So does leaving it disabled, or answering neither etherboot nor FlashFig.
    expect(checkEntry({ interface: 'ether1', disabled: true }, ctx).errors).toEqual({});
    expect(checkEntry({ interface: 'ether1', 'allow-etherboot': false }, ctx).errors).toEqual({});
    expect(checkEntry({ interface: 'ether1', 'allow-etherboot': false, 'allow-flashfig': true }, ctx).errors['mac-address']).toBeDefined();
  });

  it('applies the rule to an edit as the entry would be after it', () => {
    const open = { '.id': '*1', interface: 'ether1', wait: 'false', 'allow-etherboot': 'true', 'allow-flashfig': 'false', disabled: 'true', 'keep-old-configuration': 'true' };
    // Enabling a disabled entry with no MAC and no wait is the same as adding one.
    expect(checkEntry({ disabled: false }, { ...ctx, existing: open }).errors['mac-address']).toBeDefined();
    expect(checkEntry({ disabled: false, wait: true }, { ...ctx, existing: open }).params).toEqual({ disabled: 'no', wait: 'yes' });
    const withMac = { ...open, 'mac-address': '02:00:00:00:00:01' };
    expect(checkEntry({ disabled: false }, { ...ctx, existing: withMac }).params).toEqual({ disabled: 'no' });
    // Turning wait off on an entry without a MAC is refused.
    expect(checkEntry({ wait: false }, { ...ctx, existing: { ...open, disabled: 'false', wait: 'true' } }).errors['mac-address']).toBeDefined();
  });

  it('says RouterOS can\'t clear a MAC once set', () => {
    const ex = { '.id': '*1', interface: 'ether1', 'mac-address': '02:00:00:00:00:01', wait: 'false', disabled: 'false' };
    expect(checkEntry({ 'mac-address': '' }, { ...ctx, existing: ex }).errors['mac-address']).toMatch(/Delete the entry/);
  });

  it('checks every field', () => {
    const r = checkEntry({ interface: 'ether9', 'mac-address': 'ff:ff:ff:ff:ff:ff', 'ip-range': 'x', version: 'banana', 'extra-packages': 'notapkg',
      'auto-reboot': 'explode', wait: 'maybe', comment: 'a\nb' }, ctx);
    expect(Object.keys(r.errors).sort()).toEqual(['auto-reboot', 'comment', 'extra-packages', 'interface', 'ip-range', 'mac-address', 'version', 'wait']);
    expect(r.errors['mac-address']).toMatch(/multicast/);
    expect(checkEntry({ interface: 'ether1', wait: true, version: '6.49' }, ctx).errors.version).toMatch(/RouterOS 7/);
  });

  it('won\'t keep the old configuration and apply the default one', () => {
    expect(checkEntry({ interface: 'ether1', wait: true, 'apply-default-configuration': true }, ctx).errors['apply-default-configuration']).toBeDefined();
    expect(checkEntry({ interface: 'ether1', wait: true, 'apply-default-configuration': true, 'keep-old-configuration': false }, ctx).errors).toEqual({});
  });
});

describe('isOpenEntry', () => {
  it('finds entries already on a device that would install anything', () => {
    expect(isOpenEntry({ interface: 'ether1', wait: 'false', disabled: 'false', 'allow-etherboot': 'true' })).toBe(true);
    expect(isOpenEntry({ interface: 'ether1', wait: 'true', disabled: 'false' })).toBe(false);
    expect(isOpenEntry({ interface: 'ether1', 'mac-address': '02:00:00:00:00:01', disabled: 'false' })).toBe(false);
    expect(isOpenEntry({ interface: 'ether1', disabled: 'true' })).toBe(false);
  });
});

describe('checkInstall', () => {
  const target = { '.id': '*3', 'mac-address': '02:23:45:67:89:BB', state: 'waiting' };
  it('needs the MAC typed back', () => {
    expect(checkInstall({ confirm_mac: '02:23:45:67:89:bb', version: '7.25', 'auto-reboot': 'reboot' }, target, []))
      .toEqual({ params: { numbers: '*3', version: '7.25', 'auto-reboot': 'reboot' }, errors: {} });
    expect(checkInstall({}, target, []).errors.confirm_mac).toMatch(/02:23:45:67:89:BB/);
    expect(checkInstall({ confirm_mac: '02:23:45:67:89:BB' }, undefined, []).errors.device).toBeDefined();
  });
});

describe('cache storage', () => {
  const resource = { 'free-hdd-space': String(3 * MiB), 'total-hdd-space': String(16 * MiB), 'free-memory': String(450 * MiB), 'total-memory': String(512 * MiB) };
  it('finds RAM, flash and disks', () => {
    // A device with a flash folder keeps its root in RAM (a CRS309).
    expect(cacheStorage('NetinstallCache/', [{ name: 'flash', type: 'disk' }], [], resource)).toMatchObject({ kind: 'ram', free: 450 * MiB });
    expect(cacheStorage('NetinstallCache/', [], [], resource)).toMatchObject({ kind: 'flash', free: 3 * MiB });
    expect(cacheStorage('flash/NetinstallCache/', [{ name: 'flash', type: 'disk' }], [], resource)).toMatchObject({ kind: 'flash' });
    expect(cacheStorage('usb1/NetinstallCache/', [], [{ slot: 'usb1', 'mount-point': 'usb1', type: 'ext4', free: String(900 * MiB), size: String(1000 * MiB) }], resource))
      .toMatchObject({ kind: 'disk', disk: 'usb1', free: 900 * MiB });
    expect(cacheStorage('tmp1/NetinstallCache/', [], [{ slot: 'tmp1', 'mount-point': 'tmp1', type: 'tmpfs', free: String(200 * MiB), size: String(200 * MiB) }], resource))
      .toMatchObject({ kind: 'ram' });
  });

  it('estimates what an install downloads', () => {
    const sizes = { routeros: 12 * MiB, 'wifi-qcom': 10 * MiB };
    expect(cacheEstimate({ arch: 'arm', serverArch: 'arm', sizes, extras: ['wifi-qcom'] })).toBe(26 * MiB);
    // Another architecture: conservative sizes.
    expect(cacheEstimate({ arch: 'arm64', serverArch: 'arm', sizes, extras: ['wifi-qcom'] })).toBe(32 * MiB);
    expect(cacheEstimate({ arch: null, serverArch: 'arm', sizes, extras: [] })).toBe(20 * MiB);
  });

  it('refuses to fill flash or RAM', () => {
    expect(cacheSpaceProblem({ kind: 'flash', disk: null, free: 3 * MiB, total: 16 * MiB }, 20 * MiB)).toMatch(/in flash, with 3.0 MB free/);
    expect(cacheSpaceProblem({ kind: 'ram', disk: null, free: 450 * MiB, total: 512 * MiB }, 20 * MiB)).toBeNull();
    // RAM keeps at least 32 MB for the device itself.
    expect(cacheSpaceProblem({ kind: 'ram', disk: null, free: 40 * MiB, total: 64 * MiB }, 20 * MiB)).toMatch(/in RAM/);
    expect(cacheSpaceProblem({ kind: 'disk', disk: 'usb1', free: null, total: null }, 20 * MiB)).toBeNull();
  });

  it('checks flash for the package itself', () => {
    expect(packageSpaceProblem(73873, 2_945_024, 16 * MiB)).toBeNull();
    expect(packageSpaceProblem(73873, 500_000, 16 * MiB)).toMatch(/flash free/);
  });

  it('checks the cache folder', () => {
    const disks = [{ slot: 'usb1', 'mount-point': 'usb1' }];
    expect(cacheDirectoryError('NetinstallCache/', disks)).toBeNull();
    expect(cacheDirectoryError('usb1/NetinstallCache/', disks)).toBeNull();
    expect(cacheDirectoryError('usb2/NetinstallCache/', disks)).toMatch(/usb2/);
    expect(cacheDirectoryError('../etc', disks)).toMatch(/letters/);
    expect(cacheDirectoryError('', disks)).toMatch(/Enter/);
  });
});
