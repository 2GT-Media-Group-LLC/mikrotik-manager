import { ipAddressEdit, hostAddressProblem } from '../ipAddressEdit';

describe('ipAddressEdit', () => {
  it('maps the fields sent to RouterOS names', () => {
    expect(ipAddressEdit({ address: ' 10.0.0.1/24 ', interface: 'ether2', comment: 'lab "a"', disabled: true }))
      .toEqual({ fields: { address: '10.0.0.1/24', interface: 'ether2', comment: 'lab "a"', disabled: 'yes' } });
    expect(ipAddressEdit({ disabled: false })).toEqual({ fields: { disabled: 'no' } });
    expect(ipAddressEdit({ comment: '' })).toEqual({ fields: { comment: '' } });
  });

  it('refuses bad values and empty edits', () => {
    expect(ipAddressEdit({})).toEqual({ error: 'Nothing to change' });
    expect(ipAddressEdit({ address: '10.0.0.1' })).toHaveProperty('error');
    expect(ipAddressEdit({ address: '10.0.0.300/24' })).toHaveProperty('error');
    expect(ipAddressEdit({ address: '10.0.0.1/33' })).toHaveProperty('error');
    expect(ipAddressEdit({ interface: 'ether 1' })).toHaveProperty('error');
    expect(ipAddressEdit({ interface: 'a;b' })).toHaveProperty('error');
    expect(ipAddressEdit({ interface: 'a\\b' })).toHaveProperty('error');
    expect(ipAddressEdit({ interface: 'a"b' })).toHaveProperty('error');
    expect(ipAddressEdit({ disabled: 'yes' })).toHaveProperty('error');
    expect(ipAddressEdit({ comment: 'x'.repeat(256) })).toHaveProperty('error');
  });
});

describe('hostAddressProblem (#505)', () => {
  it('refuses the network and broadcast addresses, suggesting a host', () => {
    expect(hostAddressProblem('192.168.33.0/24')).toMatch(/network address .* such as 192\.168\.33\.1\/24/);
    expect(hostAddressProblem('192.168.33.255/24')).toMatch(/broadcast address of 192\.168\.33\.0\/24.* such as 192\.168\.33\.254\/24/);
    expect(hostAddressProblem('10.0.0.4/30')).toMatch(/network/);
    expect(hostAddressProblem('10.0.0.7/30')).toMatch(/broadcast/);
    expect(hostAddressProblem('172.16.0.0/12')).toMatch(/such as 172\.16\.0\.1\/12/);
    expect(ipAddressEdit({ address: '192.168.33.0/24' })).toHaveProperty('error');
  });

  it('accepts host addresses, /31 and /32, and leaves other input to other checks', () => {
    expect(hostAddressProblem('192.168.33.1/24')).toBeNull();
    expect(hostAddressProblem('192.168.33.254/24')).toBeNull();
    expect(hostAddressProblem('10.0.0.0/31')).toBeNull();
    expect(hostAddressProblem('10.0.0.1/31')).toBeNull();
    expect(hostAddressProblem('10.0.0.0/32')).toBeNull();
    expect(hostAddressProblem('10.0.0.1')).toBeNull();
    expect(hostAddressProblem('nonsense')).toBeNull();
  });
});
