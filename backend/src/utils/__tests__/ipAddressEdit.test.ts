import { ipAddressEdit } from '../ipAddressEdit';

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
