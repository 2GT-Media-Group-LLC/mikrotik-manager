import { describe, it, expect } from 'vitest';
import { portPriorityValue, portPriorityError, pathCostError, bpduGuardWarning } from './portStp';

describe('port spanning-tree fields', () => {
  it('reads port priority as RouterOS does', () => {
    expect(portPriorityValue('0x80')).toBe(128);
    expect(portPriorityValue('64')).toBe(64);
    expect(portPriorityError('')).toBeNull();
    expect(portPriorityError('100')).toMatch(/steps of 16/);
    expect(portPriorityError('0x100')).toMatch(/steps of 16/);
  });

  it('checks path cost', () => {
    expect(pathCostError('')).toBeNull();
    expect(pathCostError('2000')).toBeNull();
    expect(pathCostError('0')).toMatch(/1 to 200000000/);
    expect(pathCostError('200000001')).toMatch(/1 to 200000000/);
  });

  it('warns before BPDU guard goes on a port that hears a switch', () => {
    expect(bpduGuardWarning('root-port')).toMatch(/root port/);
    expect(bpduGuardWarning('alternate')).toMatch(/alternate port/);
    expect(bpduGuardWarning('designated-port')).toBeNull();
    expect(bpduGuardWarning(null)).toBeNull();
  });
});
