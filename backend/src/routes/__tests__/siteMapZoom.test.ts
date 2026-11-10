import { parseMapZoom } from '../sites';

jest.mock('../../config/database');

describe('site map zoom (#362)', () => {
  it('takes 1 to 19, or blank to fit, and leaves it alone when not sent', () => {
    expect(parseMapZoom(12)).toEqual({ ok: true, value: 12 });
    expect(parseMapZoom('19')).toEqual({ ok: true, value: 19 });
    expect(parseMapZoom('')).toEqual({ ok: true, value: null });
    expect(parseMapZoom(null)).toEqual({ ok: true, value: null });
    expect(parseMapZoom(undefined)).toEqual({ ok: true, value: undefined });
    for (const bad of [0, 20, 12.5, 'street']) expect(parseMapZoom(bad)).toMatchObject({ ok: false });
  });
});
