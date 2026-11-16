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

  // GHSA-qm4w-hmcg-7rq9: the worker decrypts these, so the request may not supply them.
  it('drops encrypted passwords the request itself carried', () => {
    const [sealed] = sealItems([{ ip_address: '203.0.113.9', api_password_sealed: 'iv:tag:copied', ssh_password_sealed: 'iv:tag:x' } as never]);
    expect(sealed).toEqual({ ip_address: '203.0.113.9' });
    const [own] = sealItems([{ api_password: 'pw', api_password_sealed: 'iv:tag:copied' } as never]);
    expect(openItem(own)).toEqual({ api_password: 'pw' });
  });

  it('passes through an item queued before sealing existed', () => {
    expect(openItem({ api_password: 'old-plain' })).toEqual({ api_password: 'old-plain' });
  });
});
