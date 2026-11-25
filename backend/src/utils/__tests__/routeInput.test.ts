import { routeInputProblem } from '../routeInput';

describe('routeInputProblem', () => {
  it('accepts networks, hosts and the default route', () => {
    expect(routeInputProblem('10.100.32.0/24', '192.168.1.1')).toBeNull();
    expect(routeInputProblem('0.0.0.0/0', '192.168.1.1')).toBeNull();
    expect(routeInputProblem('10.1.2.3', 'ether1')).toBeNull();
    expect(routeInputProblem(' 10.1.2.3/32 ', '10.0.0.1%ether2')).toBeNull();
    expect(routeInputProblem('10.0.0.0/8', 'wg-office')).toBeNull();
  });

  it('refuses a destination that is not an IPv4 address or prefix (#505)', () => {
    expect(routeInputProblem('10.100.32.256/24', '192.168.1.1')).toMatch(/10\.100\.32\.256\/24 is not a valid destination/);
    expect(routeInputProblem('10.100.32.0/33', '192.168.1.1')).not.toBeNull();
    expect(routeInputProblem('10.100.32/24', '192.168.1.1')).not.toBeNull();
    expect(routeInputProblem('10.0.0.0/8/8', '192.168.1.1')).not.toBeNull();
    expect(routeInputProblem('10.0.0.0/', '192.168.1.1')).not.toBeNull();
    expect(routeInputProblem('lan', '192.168.1.1')).not.toBeNull();
  });

  it('refuses a gateway that reads as an address but is not one', () => {
    expect(routeInputProblem('0.0.0.0/0', '192.168.1.256')).toMatch(/192\.168\.1\.256 is not a valid gateway/);
    expect(routeInputProblem('0.0.0.0/0', '192.168.1')).not.toBeNull();
    expect(routeInputProblem('0.0.0.0/0', '10.0.0.300%ether1')).not.toBeNull();
  });
});
