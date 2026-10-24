jest.mock('../mikrotik/DeviceCollector');
import { DeviceCollector, type DeviceRow } from '../mikrotik/DeviceCollector';
import { AntennaAlignmentService, AlignmentCapacityError } from '../AntennaAlignmentService';

const device: DeviceRow = { id: 1, name: 'radio', ip_address: '192.0.2.1', api_port: 8729,
  api_username: 'manager', api_password_encrypted: 'encrypted', device_type: 'wisp', status: 'online' };
const sample = { sampled_at: '2026-10-11T01:00:00Z', radios: [], warnings: [] };
const collector = jest.mocked(DeviceCollector);

describe('antenna alignment connection lifecycle', () => {
  let service: AntennaAlignmentService;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    DeviceCollector.prototype.connect = jest.fn().mockResolvedValue(undefined);
    DeviceCollector.prototype.disconnect = jest.fn();
    DeviceCollector.prototype.readAntennaAlignment = jest.fn().mockResolvedValue(sample);
    service = new AntennaAlignmentService(2);
  });
  afterEach(() => { service.close(); jest.useRealTimers(); });

  it('reuses a verified login and caps shared telemetry at two reads per second', async () => {
    expect(await service.read(device)).toEqual(sample);
    expect(await service.read(device)).toEqual(sample);
    expect(collector).toHaveBeenCalledTimes(1);
    expect(DeviceCollector.prototype.connect).toHaveBeenCalledTimes(1);
    expect(DeviceCollector.prototype.readAntennaAlignment).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(500);
    await service.read(device);
    expect(DeviceCollector.prototype.readAntennaAlignment).toHaveBeenCalledTimes(2);
    expect(DeviceCollector.prototype.connect).toHaveBeenCalledTimes(1);
  });
  it('deduplicates simultaneous reads while connecting', async () => {
    let finish!: () => void;
    DeviceCollector.prototype.connect = jest.fn().mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const one = service.read(device);
    const two = service.read(device);
    finish();
    await Promise.all([one, two]);
    expect(collector).toHaveBeenCalledTimes(1);
    expect(DeviceCollector.prototype.readAntennaAlignment).toHaveBeenCalledTimes(1);
  });
  it('reopens the connection when API-SSL is toggled on the same custom port', async () => {
    await service.read({ ...device, api_port: 9443, api_tls: false });
    await service.read({ ...device, api_port: 9443, api_tls: true });
    expect(collector).toHaveBeenCalledTimes(2);
    expect(DeviceCollector.prototype.disconnect).toHaveBeenCalledTimes(1);
    expect(DeviceCollector.prototype.connect).toHaveBeenCalledTimes(2);
  });
  it('closes an idle session after ten seconds without background device reads', async () => {
    await service.read(device);
    jest.advanceTimersByTime(10_000);
    expect(DeviceCollector.prototype.disconnect).toHaveBeenCalledTimes(1);
    expect(DeviceCollector.prototype.readAntennaAlignment).toHaveBeenCalledTimes(1);
    await service.read(device);
    expect(collector).toHaveBeenCalledTimes(2);
  });
  it.each(['api_password_encrypted', 'ip_address', 'api_username'] as const)('reconnects after %s changes', async field => {
    await service.read(device);
    await service.read({ ...device, [field]: 'changed' });
    expect(DeviceCollector.prototype.disconnect).toHaveBeenCalledTimes(1);
    expect(collector).toHaveBeenCalledTimes(2);
  });
  it('discards a failed connection and reconnects on the next read', async () => {
    jest.mocked(DeviceCollector.prototype.readAntennaAlignment).mockRejectedValueOnce(new Error('Connection closed'));
    await expect(service.read(device)).rejects.toThrow('Connection closed');
    await service.read(device);
    expect(collector).toHaveBeenCalledTimes(2);
    expect(DeviceCollector.prototype.disconnect).toHaveBeenCalledTimes(1);
  });
  it('bounds the number of persistent sessions and releases capacity on expiry', async () => {
    await service.read(device);
    await service.read({ ...device, id: 2 });
    await expect(service.read({ ...device, id: 3 })).rejects.toBeInstanceOf(AlignmentCapacityError);
    expect(collector).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(10_000);
    await expect(service.read({ ...device, id: 3 })).resolves.toEqual(sample);
  });
  it('closes all connections and cancels idle timers on shutdown', async () => {
    await service.read(device);
    await service.read({ ...device, id: 2 });
    service.close();
    expect(DeviceCollector.prototype.disconnect).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('aborts a slow multi-command read after fifteen seconds', async () => {
    let rejectRead!: (err: Error) => void;
    DeviceCollector.prototype.readAntennaAlignment = jest.fn().mockImplementation(() => new Promise((_, reject) => { rejectRead = reject; }));
    DeviceCollector.prototype.abort = jest.fn().mockImplementation(() => rejectRead(new Error('Read cancelled')));
    const pending = service.read(device);
    await Promise.resolve();
    jest.advanceTimersByTime(15_000);
    await expect(pending).rejects.toThrow('Read cancelled');
    expect(DeviceCollector.prototype.abort).toHaveBeenCalledTimes(1);
    expect(DeviceCollector.prototype.disconnect).toHaveBeenCalledTimes(1);
  });
});
