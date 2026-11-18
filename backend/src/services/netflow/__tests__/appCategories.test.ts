import { classifyApp, isKnownServicePort, setSavedPortNames } from '../appCategories';

const TCP = 6;
const UDP = 17;

describe('classifyApp with saved port names (Settings → Firewall Logs)', () => {
  afterEach(() => setSavedPortNames([]));

  it('names a port the built-in table leaves as Other', () => {
    expect(classifyApp(UDP, 55950, 1198)).toBe('Other UDP');
    setSavedPortNames([{ port: 1198, protocol: 'udp', name: 'OpenVPN' }]);
    expect(classifyApp(UDP, 55950, 1198)).toBe('OpenVPN');
    // The protocol counts: TCP 1198 stays Other.
    expect(classifyApp(TCP, 55950, 1198)).toBe('Other TCP');
  });

  it('takes both protocols for "both"', () => {
    setSavedPortNames([{ port: 9443, protocol: 'both', name: 'Portal' }]);
    expect(classifyApp(TCP, 50000, 9443)).toBe('Portal');
    expect(classifyApp(UDP, 50000, 9443)).toBe('Portal');
  });

  it('never renames a port the table already names', () => {
    setSavedPortNames([{ port: 443, protocol: 'tcp', name: 'MY-HTTPS' }, { port: 8291, protocol: 'tcp', name: 'WINBOX' }]);
    expect(classifyApp(TCP, 50000, 443)).toBe('HTTPS');
    expect(classifyApp(TCP, 50000, 8291)).toBe('Management');
  });

  it('prefers the remote port, built in or saved, over the local one', () => {
    setSavedPortNames([{ port: 1198, protocol: 'udp', name: 'OpenVPN' }]);
    // A client on 5353 talking to a saved 1198: the service is the remote end.
    expect(classifyApp(UDP, 5353, 1198)).toBe('OpenVPN');
    // A host serving 1198 to a client on an ephemeral port.
    expect(classifyApp(UDP, 1198, 61000)).toBe('OpenVPN');
  });

  it('counts saved ports as service ports for session direction', () => {
    expect(isKnownServicePort(UDP, 1198)).toBe(false);
    setSavedPortNames([{ port: 1198, protocol: 'udp', name: 'OpenVPN' }]);
    expect(isKnownServicePort(UDP, 1198)).toBe(true);
    expect(isKnownServicePort(UDP, 443)).toBe(true);
  });

  it('skips malformed entries and keeps the good ones', () => {
    setSavedPortNames([
      { port: 0, protocol: 'udp', name: 'Bad' },
      { port: 1198, protocol: 'icmp', name: 'Bad' },
      { port: 1199, protocol: 'udp', name: '' },
      null,
      'x',
      { port: 1200, protocol: 'udp', name: 'Good' },
    ]);
    expect(classifyApp(UDP, 50000, 1200)).toBe('Good');
    expect(classifyApp(UDP, 50000, 1198)).toBe('Other UDP');
    expect(classifyApp(UDP, 50000, 1199)).toBe('Other UDP');
  });

  it('clears the names when the setting is missing', () => {
    setSavedPortNames([{ port: 1198, protocol: 'udp', name: 'OpenVPN' }]);
    setSavedPortNames(undefined);
    expect(classifyApp(UDP, 50000, 1198)).toBe('Other UDP');
  });

  it('names every port in a range, a single port over it, and never a built-in one (#415)', () => {
    setSavedPortNames([
      { port: 5000, to: 5100, protocol: 'udp', name: 'Game' },
      { port: 5050, protocol: 'udp', name: 'Voice' },
      { port: 5040, to: 5060, protocol: 'udp', name: 'Lobby' },
      { port: 1, to: 1000, protocol: 'tcp', name: 'Low' },
    ]);
    expect(classifyApp(UDP, 50000, 5000)).toBe('Game');
    expect(classifyApp(UDP, 50000, 5100)).toBe('Game');
    expect(classifyApp(UDP, 50000, 5101)).toBe('Other UDP');
    expect(classifyApp(UDP, 50000, 5045)).toBe('Lobby');
    expect(classifyApp(UDP, 50000, 5050)).toBe('Voice');
    expect(classifyApp(TCP, 50000, 5050)).toBe('Other TCP');
    expect(classifyApp(TCP, 50000, 443)).toBe('HTTPS');
    expect(classifyApp(TCP, 50000, 999)).toBe('Low');
  });
});
