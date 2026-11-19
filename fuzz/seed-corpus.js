/**
 * Starting inputs for the fuzzers: a few well-formed packets and log lines as
 * RouterOS sends them, so the fuzzer begins deep in the parsers rather than
 * at the version check. Written fresh on each run; nothing binary is committed.
 */
const fs = require('fs');
const path = require('path');

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const set = (id, body) => Buffer.concat([u16(id), u16(body.length + 4), body]);
// src v4, dst v4, src port, dst port, protocol, bytes (8), packets (4), first/last switched, NAT src.
const FIELDS = [[8, 4], [12, 4], [7, 2], [11, 2], [4, 1], [1, 8], [2, 4], [22, 4], [21, 4], [225, 4], [6, 1]];
const template = (ipfix) => set(ipfix ? 2 : 0, Buffer.concat([u16(256), u16(FIELDS.length), ...FIELDS.map(([id, len]) => Buffer.concat([u16(id), u16(len)]))]));
const record = () => {
  const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(123456n);
  return Buffer.concat([Buffer.from([192, 168, 88, 10]), Buffer.from([1, 1, 1, 1]), u16(51234), u16(443), Buffer.from([6]), bytes, u32(42), u32(1000), u32(5000), Buffer.from([203, 0, 113, 5]), Buffer.from([0x1b])]);
};
const packet = (ipfix, sets) => {
  const body = Buffer.concat(sets);
  return ipfix
    ? Buffer.concat([u16(10), u16(body.length + 16), u32(1700000000), u32(1), u32(0), body])
    : Buffer.concat([u16(9), u16(sets.length), u32(600000), u32(1700000000), u32(1), u32(0), body]);
};

const out = (dir, name, data) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), data); };
const nf = path.join(__dirname, 'corpus', 'netflow');
for (const ipfix of [false, true]) {
  const v = ipfix ? 'ipfix' : 'v9';
  out(nf, `${v}-template-and-data`, packet(ipfix, [template(ipfix), set(256, Buffer.concat([record(), record()]))]));
  out(nf, `${v}-template`, packet(ipfix, [template(ipfix)]));
  out(nf, `${v}-data`, packet(ipfix, [set(256, record())]));
}
const fw = path.join(__dirname, 'corpus', 'firewall-log');
[
  'zone drop in mtm#0khn input: in:bridge out:(unknown 0), connection-state:new src-mac D0:EA:11:05:2E:44, proto UDP, 192.168.0.84:5678->255.255.255.255:5678, len 193',
  'zone accept mtm#w4yr LAN-to-WAN: in:bridge out:ether1, connection-state:new src-mac 02:00:00:00:00:01, proto TCP (SYN), 192.168.88.10:51234->1.1.1.1:443, len 60',
  'FW-DROP input: in:wan, proto ICMPv6 (type 128, code 0), [2001:db8::10]->[2001:db8::1], len 64',
  'mtmchaintest mtm-test-out: in:(unknown 0) out:ether1, connection-state:established proto TCP (ACK,FIN), 10.0.2.15:48244->198.35.26.224:443, len 40',
].forEach((line, i) => out(fw, `line-${i}`, line));
console.log('corpus written');
