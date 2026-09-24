import { renderSnmpTemplate, unknownVariables, fieldToWrite } from '../snmpTemplate';

const dev = {
  identity: 'core-sw-01', name: 'Core Switch 1', ip: '10.0.0.2',
  model: 'CRS326', serial: 'HD0812', site: 'HQ', location: 'Rack A',
};

describe('renderSnmpTemplate', () => {
  it('fills in the request example', () => {
    expect(renderSnmpTemplate('{$SystemIdentity}@example.com', dev)).toBe('core-sw-01@example.com');
  });

  it('supports the short form and several variables at once', () => {
    expect(renderSnmpTemplate('{site} / {location} / {identity}', dev)).toBe('HQ / Rack A / core-sw-01');
  });

  it('is case-insensitive and tolerates spaces inside braces', () => {
    expect(renderSnmpTemplate('{ IDENTITY }-{Ip}', dev)).toBe('core-sw-01-10.0.0.2');
  });

  it('leaves plain text alone', () => {
    expect(renderSnmpTemplate('noc@example.com', dev)).toBe('noc@example.com');
  });

  it('renders a missing value as empty rather than the literal placeholder', () => {
    expect(renderSnmpTemplate('{site}', { ...dev, site: null })).toBe('');
  });
});

describe('unknownVariables', () => {
  it('flags typos so they are caught before anything is written', () => {
    expect(unknownVariables('{identiy}@example.com')).toEqual(['{identiy}']);
  });

  it('accepts every documented variable', () => {
    expect(unknownVariables('{identity}{name}{ip}{model}{serial}{site}{location}{$SystemIdentity}')).toEqual([]);
  });
});

describe('fieldToWrite', () => {
  it('leaves a blank field untouched instead of erasing it on every device', () => {
    expect(fieldToWrite('', dev)).toBeUndefined();
    expect(fieldToWrite('   ', dev)).toBeUndefined();
    expect(fieldToWrite(undefined, dev)).toBeUndefined();
  });

  it('renders a filled field per device', () => {
    expect(fieldToWrite('{identity}@example.com', dev)).toBe('core-sw-01@example.com');
  });
});
