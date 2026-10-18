import { mergeSiteRoles } from '../siteRoles';

describe('site roles through groups (#306)', () => {
  it('a site reached directly and through its group gets the higher role', () => {
    expect(mergeSiteRoles([
      { site_id: 1, role: 'viewer' }, { site_id: 1, role: 'operator' },
      { site_id: 2, role: 'admin' }, { site_id: 2, role: 'viewer' },
    ])).toEqual({ 1: 'operator', 2: 'admin' });
  });

  it('no rows is no sites', () => {
    expect(mergeSiteRoles([])).toEqual({});
  });
});
