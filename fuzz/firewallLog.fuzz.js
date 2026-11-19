/**
 * Coverage-guided fuzzing of the firewall log parser, built from the backend
 * (npm run build there first). Log lines come from devices: no text may throw,
 * and what it returns must hold together.
 */
const { parseFirewallLog } = require('../backend/dist/utils/firewallLogParser');

module.exports.fuzz = function (data) {
  const e = parseFirewallLog(data.toString('utf8'));
  if (!e) return;
  if (!['input', 'forward', 'output'].includes(e.chain)) throw new Error(`chain ${e.chain}`);
  if (!['accept', 'drop', 'reject', 'fasttrack', 'unknown'].includes(e.action)) throw new Error(`action ${e.action}`);
  for (const p of [e.srcPort, e.dstPort, e.length]) {
    if (p !== undefined && !(Number.isInteger(p) && p >= 0)) throw new Error(`number ${p}`);
  }
  if (typeof e.srcIp !== 'string' || typeof e.dstIp !== 'string' || !e.srcIp || !e.dstIp) throw new Error('endpoints');
};
