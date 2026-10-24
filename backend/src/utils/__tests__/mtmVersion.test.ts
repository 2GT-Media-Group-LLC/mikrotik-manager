import { compareMtmVersions, parseMtmVersion, releaseBranch } from '../mtmVersion';

describe('MikroTik Manager version order', () => {
  it('reads every form the version appears in', () => {
    expect(parseMtmVersion('0.77.1-beta')).toEqual({ nums: [0, 77, 1], rank: 2, preNum: 0 });
    expect(parseMtmVersion('v0.77.1 Beta')).toEqual({ nums: [0, 77, 1], rank: 2, preNum: 0 });
    expect(parseMtmVersion('1.0.0-rc.1')).toEqual({ nums: [1, 0, 0], rank: 3, preNum: 1 });
    expect(parseMtmVersion('v1.0.0 RC 2')).toEqual({ nums: [1, 0, 0], rank: 3, preNum: 2 });
    expect(parseMtmVersion('1.0.0')).toEqual({ nums: [1, 0, 0], rank: 4, preNum: 0 });
    expect(parseMtmVersion('v1.0.0')).toEqual({ nums: [1, 0, 0], rank: 4, preNum: 0 });
    expect(parseMtmVersion('nonsense')).toBeNull();
  });

  it('puts the release after its candidates, and candidates in order (the case three numbers missed)', () => {
    const order = ['0.77.1-beta', '1.0.0-rc.1', 'v1.0.0 RC 2', '1.0.0', '1.0.1', '1.1.0-beta.1', '1.1.0-beta.2', '1.1.0-rc.1', '1.1.0'];
    for (let i = 1; i < order.length; i++) {
      expect(compareMtmVersions(order[i - 1], order[i])).toBe(-1);
      expect(compareMtmVersions(order[i], order[i - 1])).toBe(1);
    }
  });

  it('still orders the beta line by its numbers', () => {
    expect(compareMtmVersions('0.76.2-beta', '0.77.0-beta')).toBe(-1);
    expect(compareMtmVersions('v0.77.1 Beta', '0.77.1-beta')).toBe(0);
    expect(compareMtmVersions('0.9.0-beta', '0.10.0-beta')).toBe(-1);
  });

  it('never treats an unreadable version as newer', () => {
    expect(compareMtmVersions('garbage', '0.1.0-beta')).toBe(-1);
    expect(compareMtmVersions('1.0.0', '')).toBe(1);
  });
});

describe('releaseBranch', () => {
  it('sends 1.x betas to dev and everything else to main', () => {
    expect(releaseBranch('0.77.1-beta')).toBe('main');
    expect(releaseBranch('1.0.0-rc.1')).toBe('main');
    expect(releaseBranch('1.0.0')).toBe('main');
    expect(releaseBranch('1.0.3')).toBe('main');
    expect(releaseBranch('1.1.0-beta.2')).toBe('dev');
    expect(releaseBranch('v1.1.0 Beta 2')).toBe('dev');
    expect(releaseBranch('1.1.0-rc.1')).toBe('main');
  });
});
