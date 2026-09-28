import { encrypt, decrypt } from './crypto';

/**
 * Passwords in a queued bulk add (P2-28).
 *
 * A bulk add is a BullMQ job, stored in Redis (and Redis's append-only file on
 * disk) for up to a day. The items used to carry each device's API and SSH
 * passwords in plain text, while the devices table stores the same passwords
 * encrypted. They are now encrypted with the same key before queueing and
 * decrypted by the worker.
 */

const FIELDS = ['api_password', 'ssh_password'] as const;
type Field = typeof FIELDS[number];

type Item = Partial<Record<Field, string | null>>;

/** A copy of each item with its passwords encrypted into `<field>_sealed`. */
export function sealItems<T extends Item>(items: T[]): T[] {
  return items.map((item) => {
    const out: Record<string, unknown> = { ...item };
    for (const f of FIELDS) {
      const v = item[f];
      if (typeof v === 'string' && v !== '') {
        out[`${f}_sealed`] = encrypt(v);
        delete out[f];
      }
    }
    return out as unknown as T;
  });
}

/** Restore the passwords. Items queued before sealing existed pass through. */
export function openItem<T extends Item>(item: T): T {
  const out: Record<string, unknown> = { ...item };
  for (const f of FIELDS) {
    const sealed = (item as Record<string, unknown>)[`${f}_sealed`];
    if (typeof sealed === 'string') {
      out[f] = decrypt(sealed);
      delete out[`${f}_sealed`];
    }
  }
  return out as unknown as T;
}
