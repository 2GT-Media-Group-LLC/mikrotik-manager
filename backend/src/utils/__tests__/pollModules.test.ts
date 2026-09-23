import { resolveModules, describeDisabled, ALL_MODULES } from '../pollModules';

describe('resolveModules', () => {
  it('defaults everything on for an install that has never set them', () => {
    expect(resolveModules({})).toEqual(ALL_MODULES);
  });

  it('turns off only what is explicitly false', () => {
    const m = resolveModules({ poll_clients_enabled: false });
    expect(m.clients).toBe(false);
    expect(m.neighbors).toBe(true);
    expect(m.logs).toBe(true);
    expect(m.certificates).toBe(true);
  });

  it('treats an unreadable value as enabled rather than silently collecting nothing', () => {
    // Failing towards more polling is recoverable; failing towards less means an
    // operator believes data is being gathered when it is not.
    for (const v of [undefined, null, 'no', 0, '', 'false']) {
      expect(resolveModules({ poll_clients_enabled: v }).clients).toBe(true);
    }
  });

  it('handles all four off', () => {
    expect(resolveModules({
      poll_clients_enabled: false, poll_neighbors_enabled: false,
      poll_logs_enabled: false, poll_certificates_enabled: false,
    })).toEqual({ clients: false, neighbors: false, logs: false, certificates: false });
  });
});

describe('describeDisabled', () => {
  it('says nothing when everything is on', () => {
    expect(describeDisabled(ALL_MODULES)).toBeNull();
  });

  it('names what is off', () => {
    expect(describeDisabled({ ...ALL_MODULES, clients: false, logs: false }))
      .toBe('clients, logs');
  });
});
