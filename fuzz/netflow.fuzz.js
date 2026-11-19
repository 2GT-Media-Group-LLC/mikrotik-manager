/**
 * Coverage-guided fuzzing of the NetFlow v9 / IPFIX decoder, built from the
 * backend (npm run build there first). The decoder takes unauthenticated UDP
 * from the network: no input may throw, hang or produce an impossible flow.
 *
 * Templates persist between inputs, as they do in the collector, so the
 * fuzzer can send a template in one input and data for it in the next. The
 * cache is pruned the way the collector prunes it, so memory stays bounded.
 */
const { decodePacket, pruneTemplateCache } = require('../backend/dist/services/netflow/decoder');

const cache = new Map();
let calls = 0;

function check(ok, what, flow) {
  if (!ok) throw new Error(`${what}: ${JSON.stringify(flow)}`);
}

module.exports.fuzz = function (data) {
  const result = decodePacket(data, '192.0.2.1', cache);
  if (++calls % 1000 === 0) pruneTemplateCache(cache, 60_000, 1000);
  for (const f of result.flows) {
    for (const a of [f.srcAddr, f.dstAddr, f.natSrcAddr, f.natDstAddr]) {
      if (a === undefined) continue;
      check(typeof a === 'string' && /^[0-9a-f.:]+$/.test(a), 'address', f);
      const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
      if (v4) check(v4.slice(1).every((o) => Number(o) <= 255), 'octet', f);
    }
    for (const n of [f.bytes, f.packets, f.protocol, f.srcPort, f.dstPort, f.natSrcPort, f.natDstPort, f.tcpFlags, f.startMs, f.endMs]) {
      if (n !== undefined) check(Number.isFinite(n) && n >= 0, 'number', f);
    }
    if (f.tcpFlags !== undefined) check(f.tcpFlags <= 0xff, 'tcp flags', f);
  }
};
