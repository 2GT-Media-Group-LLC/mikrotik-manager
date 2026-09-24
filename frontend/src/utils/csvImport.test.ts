import { describe, it, expect } from 'vitest';
import { parseDeviceCsv, splitCsvLine, MAX_ROWS, CSV_TEMPLATE } from './csvImport';

const presets = [{ id: 7, name: 'Default' }, { id: 9, name: 'Core Switches' }];

describe('splitCsvLine', () => {
  it('handles quoted commas and doubled quotes', () => {
    expect(splitCsvLine('a,"b, c","say ""hi"""')).toEqual(['a', 'b, c', 'say "hi"']);
  });
});

describe('parseDeviceCsv', () => {
  it('turns a clean file into bulk-add items', () => {
    const r = parseDeviceCsv('name,ip,type,preset\nsw1,10.0.0.2,switch,Default\n', presets);
    expect(r.fileErrors).toEqual([]);
    expect(r.rows[0].item).toEqual({
      name: 'sw1', ip_address: '10.0.0.2', device_type: 'switch', credential_preset_id: 7,
    });
  });

  it('passes SSH credentials through when given (#160 follow-up)', () => {
    const r = parseDeviceCsv('ip,username,password,ssh_username,ssh_password,ssh_port\n10.0.0.5,admin,a,backup,b,2222\n', presets);
    expect(r.rows[0].item).toMatchObject({ ssh_username: 'backup', ssh_password: 'b', ssh_port: 2222 });
  });

  it('leaves SSH out when blank, so SSH falls back to the API login', () => {
    const r = parseDeviceCsv('ip,username,password,ssh_username,ssh_password\n10.0.0.5,admin,a,,\n', presets);
    expect(r.rows[0].item).not.toHaveProperty('ssh_username');
    expect(r.rows[0].errors).toEqual([]);
  });

  it('rejects half an SSH credential', () => {
    const r = parseDeviceCsv('ip,username,password,ssh_username\n10.0.0.5,admin,a,backup\n', presets);
    expect(r.rows[0].errors.join(' ')).toMatch(/both ssh_username and ssh_password/);
  });

  it('warns that SSH columns are ignored alongside a preset', () => {
    const r = parseDeviceCsv('ip,preset,ssh_username,ssh_password\n10.0.0.5,Default,x,y\n', presets);
    expect(r.rows[0].warnings.join(' ')).toMatch(/preset's SSH settings/);
    expect(r.rows[0].item).not.toHaveProperty('ssh_username');
  });

  it('matches preset names case-insensitively', () => {
    const r = parseDeviceCsv('ip,preset\n10.0.0.2,core switches\n', presets);
    expect(r.rows[0].item?.credential_preset_id).toBe(9);
  });

  it('accepts username and password instead of a preset', () => {
    const r = parseDeviceCsv('ip,username,password\n10.0.0.2,admin,secret\n', presets);
    expect(r.rows[0].item).toMatchObject({ api_username: 'admin', api_password: 'secret' });
    expect(r.rows[0].item?.credential_preset_id).toBeUndefined();
  });

  it('defaults the name to the address', () => {
    expect(parseDeviceCsv('ip,preset\n10.0.0.2,Default\n', presets).rows[0].item?.name).toBe('10.0.0.2');
  });

  it('reports errors per line instead of failing the file', () => {
    const r = parseDeviceCsv(
      'ip,preset,type\n10.0.0.2,Default,switch\n10.0.0.999,Default,switch\n10.0.0.4,Nope,switch\n10.0.0.5,Default,toaster\n',
      presets
    );
    expect(r.rows.map((x) => x.errors.length > 0)).toEqual([false, true, true, true]);
    expect(r.rows[1].errors[0]).toMatch(/not a valid/);
    expect(r.rows[2].errors[0]).toMatch(/No credential preset called "Nope"/);
    expect(r.rows[3].errors[0]).toMatch(/Unknown type/);
    expect(r.rows[1].line).toBe(3);
  });

  it('requires credentials of some kind', () => {
    expect(parseDeviceCsv('ip\n10.0.0.2\n', presets).rows[0].errors[0]).toMatch(/preset, or both username/);
  });

  it('catches the same address twice in one file', () => {
    const r = parseDeviceCsv('ip,preset\n10.0.0.2,Default\n10.0.0.2,Default\n', presets);
    expect(r.rows[1].errors[0]).toMatch(/Same address as line 2/);
  });

  it('skips a device already managed rather than sending a row that would fail', () => {
    // The bulk job answers an existing device with a duplicate-serial failure.
    const r = parseDeviceCsv('ip,preset\n10.0.0.2,Default\n10.0.0.3,Default\n', presets, ['10.0.0.2']);
    expect(r.rows[0].errors).toEqual([]);
    expect(r.rows[0].skip).toBe(true);
    expect(r.rows[0].warnings[0]).toMatch(/Already managed/);
    expect(r.rows[1].skip).toBe(false);
  });

  it('accepts hostnames', () => {
    expect(parseDeviceCsv('host,preset\nsw1.example.net,Default\n', presets).rows[0].errors).toEqual([]);
  });

  it('skips blank lines, comments, CRLF and a BOM', () => {
    const r = parseDeviceCsv('\uFEFF# fleet\r\nip,preset\r\n\r\n# comment\r\n10.0.0.2,Default\r\n', presets);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].errors).toEqual([]);
  });

  it('needs an address column', () => {
    expect(parseDeviceCsv('name,preset\nsw1,Default\n', presets).fileErrors[0]).toMatch(/No address column/);
  });

  it('lists columns it will ignore', () => {
    expect(parseDeviceCsv('ip,preset,rack\n10.0.0.2,Default,A1\n', presets).ignoredColumns).toEqual(['rack']);
  });

  it('refuses more rows than the job accepts', () => {
    const body = Array.from({ length: MAX_ROWS + 1 }, (_, i) => `10.1.${Math.floor(i / 250)}.${(i % 250) + 1},Default`).join('\n');
    expect(parseDeviceCsv(`ip,preset\n${body}\n`, presets).fileErrors[0]).toMatch(/limit per import/);
  });

  it('parses its own template cleanly', () => {
    const r = parseDeviceCsv(CSV_TEMPLATE, presets);
    expect(r.fileErrors).toEqual([]);
    expect(r.rows.every((x) => x.errors.length === 0)).toBe(true);
  });
});
