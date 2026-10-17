jest.mock('../../config/database');
jest.mock('../../config/influxdb', () => ({ getQueryApi: jest.fn(), bucket: 'test' }));
jest.mock('../../middleware/auth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import request from 'supertest';
import express from 'express';
import metricsRoutes from '../metrics';
import { query } from '../../config/database';
import { getQueryApi } from '../../config/influxdb';

const mockedQuery = jest.mocked(query);
const mockedGetQueryApi = jest.mocked(getQueryApi);

type Row = Record<string, unknown>;

/** A query API whose queryRows replays `rows`, or fails with `error`. */
function fakeInflux(rows: Row[], error?: Error) {
  const queryRows = jest.fn((_flux: string, observer: { next: (r: Row, m: { toObject: (r: Row) => Row }) => void; error: (e: Error) => void; complete: () => void }) => {
    if (error) return observer.error(error);
    for (const r of rows) observer.next(r, { toObject: (x) => x });
    observer.complete();
  });
  mockedGetQueryApi.mockReturnValue({ queryRows } as never);
  return queryRows;
}

function app() {
  const a = express();
  a.use('/api/metrics', metricsRoutes);
  return a;
}

describe('GET /api/metrics/resources/latest', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
    mockedQuery.mockResolvedValue([{ id: 1 }, { id: 2 }] as never);
  });

  it('returns the newest point per device, only for devices in scope', async () => {
    fakeInflux([
      { device_id: '1', _field: 'cpu_load', _value: 12.5, _time: '2026-10-17T10:00:00Z' },
      { device_id: '1', _field: 'memory_total', _value: 1000, _time: '2026-10-17T10:00:00Z' },
      { device_id: '1', _field: 'memory_used', _value: 400, _time: '2026-10-17T10:00:00Z' },
      { device_id: '99', _field: 'cpu_load', _value: 80, _time: '2026-10-17T10:00:00Z' },
    ]);
    const res = await request(app()).get('/api/metrics/resources/latest');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: { '1': { cpu_load: 12.5, memory_used: 400, memory_total: 1000, time: '2026-10-17T10:00:00.000Z' } },
    });
  });

  it('is empty when Influx cannot be read', async () => {
    fakeInflux([], new Error('down'));
    const res = await request(app()).get('/api/metrics/resources/latest');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: {} });
  });
});

describe('GET /api/metrics/interfaces/latest', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
    mockedQuery.mockResolvedValue([{ id: 1 }] as never);
  });

  it('groups cumulative counters by device and interface, in scope only, with one query', async () => {
    const queryRows = fakeInflux([
      { device_id: '1', interface: 'ether1', _field: 'rx_bytes', _value: 5000, _time: '2026-10-17T10:00:00Z' },
      { device_id: '1', interface: 'ether1', _field: 'tx_bytes', _value: 9000, _time: '2026-10-17T10:00:00Z' },
      { device_id: '1', interface: 'sfp1', _field: 'rx_bytes', _value: 1, _time: '2026-10-17T10:00:05Z' },
      { device_id: '7', interface: 'ether1', _field: 'rx_bytes', _value: 3, _time: '2026-10-17T10:00:00Z' },
    ]);
    const res = await request(app()).get('/api/metrics/interfaces/latest');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: {
        '1': {
          ether1: { rx_bytes: 5000, tx_bytes: 9000, time: '2026-10-17T10:00:00.000Z' },
          sfp1: { rx_bytes: 1, tx_bytes: 0, time: '2026-10-17T10:00:05.000Z' },
        },
      },
    });
    expect(queryRows).toHaveBeenCalledTimes(1);
    const flux = String(queryRows.mock.calls[0][0]);
    expect(flux).toContain('interface_traffic');
    expect(flux).toContain('range(start: -15m)');
    expect(flux).toContain('last()');
  });

  it('reports 503 rather than an empty fleet when Influx fails', async () => {
    fakeInflux([], new Error('down'));
    const res = await request(app()).get('/api/metrics/interfaces/latest');
    expect(res.status).toBe(503);
  });
});
