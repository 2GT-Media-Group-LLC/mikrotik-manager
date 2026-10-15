import { describe, it, expect } from 'vitest';
import {
  lookupModelLayout, resolveEvenOnTop, arrangeSfp, stackCages, cageTiles, MODEL_LAYOUTS,
} from './faceplateModels';

const nums = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe('lookupModelLayout', () => {
  it('matches case-insensitively', () => {
    expect(lookupModelLayout('crs354-48p-4s+2q+')).toBe(MODEL_LAYOUTS['CRS354-48P-4S+2Q+']);
    expect(lookupModelLayout(' CRS510-8XS-2XQ ')?.qsfpStacked).toBe(true);
  });
  it('returns undefined for unknown or empty models', () => {
    expect(lookupModelLayout('CRS305-1G-4S+')).toBeUndefined();
    expect(lookupModelLayout(null)).toBeUndefined();
    expect(lookupModelLayout('')).toBeUndefined();
  });
  it('seeds CRS328-24P-4S+ ethers even-on-top but leaves SFP+ unset', () => {
    const l = lookupModelLayout('CRS328-24P-4S+')!;
    expect(l.etherEvenOnTop).toBe(true);
    expect(l.sfp).toBeUndefined();
    expect(l.qsfpStacked).toBeUndefined();
  });
});

describe('resolveEvenOnTop', () => {
  const l = lookupModelLayout('CRS328-24P-4S+');
  it('uses the model default when nothing is stored', () => {
    expect(resolveEvenOnTop(null, l)).toBe(true);
    expect(resolveEvenOnTop(null, undefined)).toBe(false);
  });
  it('lets a stored user choice override the default', () => {
    expect(resolveEvenOnTop('0', l)).toBe(false);
    expect(resolveEvenOnTop('1', undefined)).toBe(true);
  });
});

describe('arrangeSfp', () => {
  it('unknown models keep plain wrapped rows', () => {
    const a = arrangeSfp(nums(10), undefined, 4);
    expect(a).toEqual({ kind: 'rows', rows: [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10]] });
  });
  it('staggers 4 ports as 2 4 over 1 3', () => {
    const a = arrangeSfp(nums(4), lookupModelLayout('CRS354-48P-4S+2Q+'), 22);
    expect(a).toEqual({ kind: 'banks', banks: [{ top: [2, 4], bottom: [1, 3] }] });
  });
  it('staggers 8 ports in two banks of four', () => {
    const a = arrangeSfp(nums(8), lookupModelLayout('CRS510-8XS-2XQ'), 22);
    expect(a).toEqual({ kind: 'banks', banks: [
      { top: [2, 4], bottom: [1, 3] }, { top: [6, 8], bottom: [5, 7] },
    ] });
  });
  it('CRS317 keeps 16 ports in one row even at a narrow column count', () => {
    const a = arrangeSfp(nums(16), lookupModelLayout('CRS317-1G-16S+'), 4);
    expect(a).toEqual({ kind: 'rows', rows: [nums(16)] });
  });
});

describe('QSFP cages', () => {
  it('stacks cages 2 over 1', () => {
    expect(stackCages(['q1', 'q2'])).toEqual([{ top: ['q2'], bottom: ['q1'] }]);
    expect(stackCages(['q1'])).toEqual([{ top: ['q1'], bottom: [] }]);
  });
  it('a single-mode cage is one box mapped to its real port', () => {
    const port = { name: 'qsfpplus1-1' };
    expect(cageTiles({ lanes: [], singlePort: port })).toEqual([port]);
  });
  it('a breakout cage keeps its real lanes', () => {
    const lanes = [1, 2, 3, 4].map((n) => ({ name: `qsfp28-1-${n}` }));
    expect(cageTiles({ lanes })).toEqual(lanes);
  });
});
