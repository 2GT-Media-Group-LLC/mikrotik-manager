jest.mock('../../../config/database', () => ({ query: jest.fn() }));
import { cachePairs, due, WRITE_EVERY_MS } from '../dnsCacheStore';

describe('router DNS cache (#366)', () => {
  it('keeps A and AAAA records as unique address and name pairs', () => {
    expect(cachePairs([
      { type: 'A', name: 'www.youtube.com', data: '142.251.151.4' },
      { type: 'A', name: 'WWW.YouTube.com.', data: '142.251.151.4' },
      { type: 'AAAA', name: 'www.youtube.com', data: '2a00:1450:400f:80c::200e' },
      { type: 'CNAME', name: 'www.youtube.com', data: 'youtube-ui.l.google.com' },
      { type: 'A', name: 'bad name', data: '1.2.3.4' },
      { type: 'A', name: 'x.example', data: 'not-an-ip;' },
    ])).toEqual([
      { ip: '142.251.151.4', name: 'www.youtube.com' },
      { ip: '2a00:1450:400f:80c::200e', name: 'www.youtube.com' },
    ]);
  });

  it('names an address by the question at the top of its CNAME chain', () => {
    expect(cachePairs([
      { type: 'CNAME', name: 'www.netflix.com', data: 'ftl-www.netflix.com.' },
      { type: 'A', name: 'ftl-www.netflix.com', data: '207.45.72.1' },
      { type: 'CNAME', name: 'a.example', data: 'b.example.' },
      { type: 'CNAME', name: 'b.example', data: 'c.example.' },
      { type: 'A', name: 'c.example', data: '192.0.2.9' },
      // A loop mustn't hang.
      { type: 'CNAME', name: 'x.example', data: 'y.example.' },
      { type: 'CNAME', name: 'y.example', data: 'x.example.' },
      { type: 'A', name: 'y.example', data: '192.0.2.10' },
    ])).toEqual([
      { ip: '207.45.72.1', name: 'www.netflix.com' },
      { ip: '192.0.2.9', name: 'a.example' },
      { ip: '192.0.2.10', name: 'x.example' },
    ]);
  });

  it('writes a pair again only after the interval', () => {
    const p = [{ ip: '192.0.2.1', name: 'a.example' }];
    expect(due(1, p, 1_000)).toEqual(p);
    expect(due(1, p, 2_000)).toEqual([]);
    expect(due(2, p, 2_000)).toEqual(p);   // another site
    expect(due(1, p, 1_000 + WRITE_EVERY_MS)).toEqual(p);
  });
});
