/**
 * The SQL that reads firewall log lines in the database (which lines are
 * packet logs, their prefix, their built-in chain) must agree with
 * parseFirewallLog, which reads them in the app: Firewall Logs filters and
 * groups in SQL and shows what the parser says. When the two disagreed about
 * jump chains (#369), lines vanished. Every generated line must read the same
 * both ways.
 */
import fc from 'fast-check';
import { Client } from 'pg';
import { parseFirewallLog } from '../firewallLogParser';
import { firewallPacketLogSql, firewallPrefixSql, firewallBaseChainSql } from '../firewallEventSql';
import { fuzz, FUZZ_TIMEOUT_MS } from '../../test/fuzz';
import { firewallLine } from './firewallLineArbitrary';

const PG = process.env.PG_E2E_URL;
const suite = PG ? describe : describe.skip;
jest.setTimeout(Math.max(FUZZ_TIMEOUT_MS, 120_000));

suite('firewall log SQL agrees with the parser (fuzz)', () => {
  let db: Client;
  beforeAll(async () => { db = new Client({ connectionString: PG }); await db.connect(); });
  afterAll(async () => { await db?.end(); });

  const read = async (messages: string[]) => (await db.query<{ message: string; packet: boolean; prefix: string; chain: string }>(
    `SELECT message, ${firewallPacketLogSql()} AS packet, ${firewallPrefixSql()} AS prefix, ${firewallBaseChainSql()} AS chain
       FROM (SELECT unnest($1::text[]) AS message, 'firewall,info'::text AS topic) l`, [messages])).rows;

  it('reads the prefix and chain of every line the way the parser does', async () => {
    await fc.assert(fc.asyncProperty(fc.array(firewallLine, { minLength: 1, maxLength: 25 }), async (lines) => {
      for (const row of await read(lines.map((l) => l.message))) {
        const e = parseFirewallLog(row.message);
        expect(e).not.toBeNull();
        expect({ message: row.message, packet: row.packet, prefix: row.prefix, chain: row.chain })
          .toEqual({ message: row.message, packet: true, prefix: e!.prefix, chain: e!.chain });
      }
    }), fuzz({ numRuns: Math.max(20, Math.floor(fuzz().numRuns! / 10)) }));
  });

  it('never calls a line the parser refuses a packet log', async () => {
    const noise = fc.oneof(
      fc.string({ maxLength: 200, unit: 'grapheme-ascii' }),
      firewallLine.map((l) => l.message.replace(/ proto [^,]+,/, ',')),
      firewallLine.map((l) => l.message.replace('->', ' to ')),
    );
    await fc.assert(fc.asyncProperty(fc.array(noise, { minLength: 1, maxLength: 25 }), async (messages) => {
      for (const row of await read(messages)) {
        if (row.packet) expect({ message: row.message, parsed: parseFirewallLog(row.message) !== null }).toEqual({ message: row.message, parsed: true });
      }
    }), fuzz({ numRuns: Math.max(20, Math.floor(fuzz().numRuns! / 10)) }));
  });
});
