import { smsMessages, messagesFrom, normalizeSender, SMS_ID } from '../lteSms';

describe('LTE SMS inbox (#85)', () => {
  const rows: Record<string, string>[] = [
    { '.id': '*1', phone: '1237', timestamp: 'nov/06/2026 10:20:31 GMT +1', message: 'Your daily package is active', type: 'class-1' },
    { '.id': '*2', phone: '+381 64 123 4567', timestamp: 'nov/06/2026 11:02:00 GMT +1', message: 'hello' },
    { '.id': '*3', phone: 'Operator', message: 'Promo' },
    { phone: '1237', message: 'no id' },
  ];

  it('reads the inbox, leaving out rows that can\'t be deleted', () => {
    const m = smsMessages(rows);
    expect(m.map((x) => x.id)).toEqual(['*1', '*2', '*3']);
    expect(m[2]).toEqual({ id: '*3', phone: 'Operator', timestamp: null, message: 'Promo', type: null });
  });

  it('finds the carrier\'s replies by sender, whatever the spacing or case', () => {
    const m = smsMessages(rows);
    expect(messagesFrom(m, '1237').map((x) => x.id)).toEqual(['*1']);
    expect(messagesFrom(m, '+381 (64) 123-4567').map((x) => x.id)).toEqual(['*2']);
    expect(messagesFrom(m, 'operator').map((x) => x.id)).toEqual(['*3']);
    expect(messagesFrom(m, '')).toEqual([]);
    expect(normalizeSender(' +1 (555) 010-0000 ')).toBe('+15550100000');
  });

  it('only takes RouterOS ids', () => {
    expect(SMS_ID.test('*1A')).toBe(true);
    expect(SMS_ID.test('*1;/system/reboot')).toBe(false);
    expect(SMS_ID.test('1')).toBe(false);
  });
});
