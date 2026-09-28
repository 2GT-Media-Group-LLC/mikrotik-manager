import { sealItems, openItem } from '../bulkAddSecrets';

describe('bulk add passwords', () => {
  it('keeps plain-text passwords out of the queued payload', () => {
    const [sealed] = sealItems([{ ip_address: '10.0.0.1', api_password: 'hunter22', ssh_password: 'ssh-pw', name: 'sw1' }]);
    const json = JSON.stringify(sealed);
    expect(json).not.toContain('hunter22');
    expect(json).not.toContain('ssh-pw');
    expect(sealed).toMatchObject({ ip_address: '10.0.0.1', name: 'sw1' });
  });

  it('gives the worker the original passwords back', () => {
    const [sealed] = sealItems([{ api_password: 'hunter22', ssh_password: null }]);
    expect(openItem(sealed)).toEqual({ api_password: 'hunter22', ssh_password: null });
  });

  it('passes through an item queued before sealing existed', () => {
    expect(openItem({ api_password: 'old-plain' })).toEqual({ api_password: 'old-plain' });
  });
});
