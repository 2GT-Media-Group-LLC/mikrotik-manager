import { describe, it, expect } from 'vitest';
import { glyphKind } from './PortGlyph';

describe('glyphKind (#412)', () => {
  it('draws copper as a jack and SFP cages as cages, by factory name', () => {
    expect(glyphKind({ name: 'ether5' })).toBe('rj45');
    expect(glyphKind({ name: 'starlink1', default_name: 'sfp-sfpplus8' })).toBe('sfp');
    expect(glyphKind({ name: 'uplink', default_name: 'ether1' })).toBe('rj45');
  });

  it('draws bridges and bonds as virtual', () => {
    expect(glyphKind({ name: 'bridge', type: 'bridge' })).toBe('virtual');
    expect(glyphKind({ name: 'bond1', type: 'bond' })).toBe('virtual');
  });

  it('draws a QSFP lane narrow, unless it stands for the whole cage', () => {
    expect(glyphKind({ name: 'qsfp28-1-3' })).toBe('lane');
    expect(glyphKind({ name: 'qsfp28-1-1', link_rate: '100Gbps' }, true)).toBe('qsfp');
    expect(glyphKind({ name: 'qsfp28-2' })).toBe('qsfp');
  });

  it('tells QSFP-DD by name or by a link faster than QSFP28 carries', () => {
    expect(glyphKind({ name: 'qsfp56-dd-1' })).toBe('qsfpdd');
    expect(glyphKind({ name: 'qsfp56-dd-1-1' }, true)).toBe('qsfpdd');
    expect(glyphKind({ name: 'qsfp56-dd-1-2' })).toBe('lane');
    expect(glyphKind({ name: 'qsfp-1-1', link_rate: '400Gbps' }, true)).toBe('qsfpdd');
    expect(glyphKind({ name: 'qsfp-1-1', link_rate: '100Gbps' }, true)).toBe('qsfp');
  });
});
