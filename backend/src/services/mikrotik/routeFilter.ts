/**
 * Route filter rules in RouterOS 7's schema (outside review C7).
 *
 * RouterOS 6 took `chain`, `prefix` and `action`. RouterOS 7 takes a `chain`
 * and a `rule` script such as `if (dst in 10.0.0.0/8) { accept }`, and has
 * no `discard` (its `reject` drops the route).
 */

const ACTIONS: Record<string, string> = { accept: 'accept', reject: 'reject', discard: 'reject', return: 'return' };
const PREFIX = /^[0-9a-fA-F:.]+\/\d{1,3}$/;

export function toV7FilterRule(params: Record<string, string>): Record<string, string> {
  const { chain, action, prefix, comment, rule, disabled } = params;
  const out: Record<string, string> = {};
  if (chain) out['chain'] = chain;
  if (comment) out['comment'] = comment;
  if (disabled) out['disabled'] = disabled;
  if (rule) {
    out['rule'] = rule;
    return out;
  }
  const verb = ACTIONS[action || 'accept'];
  if (!verb) throw new Error(`Route filter action "${action}" isn't available on RouterOS 7.`);
  if (prefix) {
    if (!PREFIX.test(prefix)) throw new Error(`"${prefix}" isn't a prefix like 10.0.0.0/8.`);
    out['rule'] = `if (dst in ${prefix}) { ${verb} }`;
  } else {
    out['rule'] = verb;
  }
  return out;
}
