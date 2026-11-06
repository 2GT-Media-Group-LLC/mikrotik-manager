/**
 * The modem's SMS inbox (discussion #85): what's in it, and which messages
 * are the carrier's replies to the data-cap reset SMS, so they can be cleared
 * instead of filling the SIM.
 */
type Ros = Record<string, string>;

export interface SmsMessage { id: string; phone: string; timestamp: string | null; message: string; type: string | null }

/** Inbox rows as the page shows them; rows without an id can't be deleted, so they're left out. */
export function smsMessages(rows: Ros[]): SmsMessage[] {
  return rows.filter((r) => r['.id']).map((r) => ({
    id: r['.id'],
    phone: (r.phone ?? '').slice(0, 64),
    timestamp: r.timestamp ? r.timestamp.slice(0, 64) : null,
    message: (r.message ?? '').slice(0, 2000),
    type: r.type ? r.type.slice(0, 32) : null,
  }));
}

/** Spaces, dashes and brackets don't count, and a sender name's case doesn't. */
export const normalizeSender = (v: string | null | undefined) => (v ?? '').replace(/[\s()-]/g, '').toLowerCase();

/** The messages from one sender: the carrier's replies to the reset SMS. */
export function messagesFrom(messages: SmsMessage[], sender: string | null | undefined): SmsMessage[] {
  const want = normalizeSender(sender);
  if (!want) return [];
  return messages.filter((m) => normalizeSender(m.phone) === want);
}

/** RouterOS item ids, so nothing else reaches the remove command. */
export const SMS_ID = /^\*[0-9A-F]{1,8}$/i;
