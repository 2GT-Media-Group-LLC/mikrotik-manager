jest.mock('../../config/database');
const writePoint = jest.fn();
const flush = jest.fn().mockResolvedValue(undefined);
jest.mock('../../config/influxdb', () => ({ getWriteApi: () => ({ writePoint, flush }) }));

import type { Point } from '@influxdata/influxdb-client';
import { query } from '../../config/database';
import { writeClientCounts } from '../clientCounts';

it('writes the fleet and each site total from one query, at most every 15 s', async () => {
  (query as jest.Mock).mockResolvedValue([
    { site_id: 3, fleet: false, count: '12' },
    { site_id: 7, fleet: false, count: '0' },   // a site whose clients have all gone
    { site_id: null, fleet: false, count: '4' }, // devices in no site: no series of their own
    { site_id: null, fleet: true, count: '15' },
  ]);
  await writeClientCounts();
  await writeClientCounts(); // within 15 s of the last: nothing
  expect(query).toHaveBeenCalledTimes(1);
  expect(String((query as jest.Mock).mock.calls[0][0])).toContain('GROUP BY ROLLUP (d.site_id)');
  const lines = writePoint.mock.calls.map(([p]: [Point]) => p.toLineProtocol()!.replace(/ \d+$/, ''));
  expect(lines).toEqual([
    'client_counts,device_id=_site_3,device_name=_site_3 total_clients=12i',
    'client_counts,device_id=_site_7,device_name=_site_7 total_clients=0i',
    'client_counts,device_id=_global,device_name=_global total_clients=15i',
  ]);
  expect(flush).toHaveBeenCalledTimes(1);
});
