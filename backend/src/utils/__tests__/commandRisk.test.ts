import { assessCommand } from '../commandRisk';

// Outside review U3: lockout commands the old patterns missed.
describe('assessCommand', () => {
  it.each([
    '/interface bridge set bridge1 vlan-filtering=yes',
    '/interface bridge port remove [find interface=ether1]',
    '/interface/bridge/vlan remove [find vlan-ids=10]',
    '/interface ethernet set ether1 disabled=yes',
    '/interface bridge port set [find interface=sfp1] pvid=20',
    '/ip dhcp-client remove [find]',
    '/ip address remove [find address~"192.168"]',
    '/user set admin password=x',
    '/certificate remove [find name=api]',
  ])('flags %s', (cmd) => expect(assessCommand(cmd).risky).toBe(true));

  it.each(['/system identity print', '/ip address print', ':put [/system resource get uptime]', '/interface print stats'])(
    'leaves %s alone', (cmd) => expect(assessCommand(cmd).risky).toBe(false));
});
