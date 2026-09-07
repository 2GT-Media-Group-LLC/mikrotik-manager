import {
  resolveSiteId,
  siteScopeDevices,
  siteScopeByDevice,
  siteScopeByNullableDevice,
  andSite,
  clientSeriesTag,
} from '../siteScope';

describe('resolveSiteId', () => {
  it('accepts positive integers', () => {
    expect(resolveSiteId('3')).toBe(3);
    expect(resolveSiteId(7)).toBe(7);
    expect(resolveSiteId(' 12 ')).toBe(12);
  });

  // Unscoped is the compatibility path: anything that isn't a real site id must
  // behave exactly as the API did before sites existed, never as an error.
  it('treats absent, empty and "all" as unscoped', () => {
    expect(resolveSiteId(undefined)).toBeNull();
    expect(resolveSiteId(null)).toBeNull();
    expect(resolveSiteId('')).toBeNull();
    expect(resolveSiteId('   ')).toBeNull();
    expect(resolveSiteId('all')).toBeNull();
    expect(resolveSiteId('ALL')).toBeNull();
  });

  it('rejects zero and negatives', () => {
    expect(resolveSiteId('0')).toBeNull();
    expect(resolveSiteId('-4')).toBeNull();
  });

  // The id is inlined into SQL, so this is the boundary that makes that safe.
  // Every one of these must come back null rather than reaching a query.
  it('rejects anything that is not a plain integer', () => {
    const hostile = [
      '1; DROP TABLE devices',
      '1 OR 1=1',
      "1'",
      '1.5',
      '1e3',
      'abc',
      '0x1',
      '١٢',
      {},
      [],
    ];
    for (const raw of hostile) expect(resolveSiteId(raw)).toBeNull();
  });

  // Surrounding whitespace is stripped, not rejected -- '\n3' is the number 3
  // with padding, which is what a header or query string may legitimately carry.
  it('trims surrounding whitespace rather than rejecting it', () => {
    expect(resolveSiteId('\n3')).toBe(3);
    expect(resolveSiteId('\t9 ')).toBe(9);
  });

  it('never returns a value whose string form contains non-digits', () => {
    for (const raw of ['5', '  5  ', 5]) {
      const id = resolveSiteId(raw);
      expect(id).not.toBeNull();
      expect(String(id)).toMatch(/^\d+$/);
    }
  });
});

describe('siteScopeDevices', () => {
  it('returns null when unscoped so callers can skip the filter', () => {
    expect(siteScopeDevices(null)).toBeNull();
    expect(siteScopeDevices(null, 'd')).toBeNull();
  });

  it('filters on site_id, qualified when an alias is given', () => {
    expect(siteScopeDevices(3)).toBe('site_id = 3');
    expect(siteScopeDevices(3, 'd')).toBe('d.site_id = 3');
  });
});

describe('siteScopeByDevice', () => {
  it('returns null when unscoped', () => {
    expect(siteScopeByDevice(null)).toBeNull();
  });

  it('scopes any device_id column through the devices table', () => {
    expect(siteScopeByDevice(4)).toBe('device_id IN (SELECT id FROM devices WHERE site_id = 4)');
    expect(siteScopeByDevice(4, 'c.device_id'))
      .toBe('c.device_id IN (SELECT id FROM devices WHERE site_id = 4)');
  });
});

describe('siteScopeByNullableDevice', () => {
  it('returns null when unscoped, so fleet-wide rows still appear', () => {
    expect(siteScopeByNullableDevice(null, 'e.device_id')).toBeNull();
  });

  // A row with no device belongs to no site. Showing it in every site would
  // misrepresent it as that site's own, so it is hidden while one is selected.
  it('excludes rows with no device when a site is selected', () => {
    const sql = siteScopeByNullableDevice(2, 'e.device_id');
    expect(sql).toContain('e.device_id IS NOT NULL');
    expect(sql).toContain('site_id = 2');
  });
});

describe('andSite', () => {
  it('returns the base untouched when unscoped', () => {
    expect(andSite('WHERE a = 1', null)).toBe('WHERE a = 1');
    expect(andSite('', null)).toBe('');
  });

  it('starts a WHERE clause when the base is empty', () => {
    expect(andSite('', 'site_id = 1')).toBe('WHERE site_id = 1');
    expect(andSite('   ', 'site_id = 1')).toBe('WHERE site_id = 1');
  });

  it('appends with AND when the base already has a clause', () => {
    expect(andSite('WHERE a = 1', 'site_id = 1')).toBe('WHERE a = 1 AND site_id = 1');
  });
});

describe('clientSeriesTag', () => {
  it('uses the global series when unscoped', () => {
    expect(clientSeriesTag(null, 0, 4)).toBe('_global');
  });

  // The case that matters for every existing single-site install: the site
  // holds the whole fleet, so the global series is exactly right and keeps the
  // chart's history instead of restarting it at the upgrade.
  it('uses the global series when the site holds every device', () => {
    expect(clientSeriesTag(1, 4, 4)).toBe('_global');
  });

  it('uses the per-site series once the fleet is actually split', () => {
    expect(clientSeriesTag(1, 3, 4)).toBe('_site_1');
    expect(clientSeriesTag(2, 1, 4)).toBe('_site_2');
  });

  // An empty site must read a series nothing writes, so the chart is empty
  // rather than showing the fleet's.
  it('uses the per-site series for an empty site', () => {
    expect(clientSeriesTag(3, 0, 4)).toBe('_site_3');
  });

  // No devices at all: nothing to be equal to, so don't claim the global total.
  it('does not treat an empty install as a full site', () => {
    expect(clientSeriesTag(1, 0, 0)).toBe('_site_1');
  });
});
