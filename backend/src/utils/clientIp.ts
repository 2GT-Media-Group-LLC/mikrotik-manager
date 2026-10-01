/**
 * The client address behind nginx, by the same rule Express uses for req.ip
 * with `trust proxy` = 1: the last entry nginx appended to X-Forwarded-For,
 * which is the address nginx itself saw. Earlier entries are whatever the
 * client sent and are not trusted. Without a header, the socket's own peer.
 *
 * Terminal sessions used to be audited with the socket's peer address, which
 * is always the nginx container (outside review P2-33).
 */
export function clientIpBehindProxy(forwardedFor: string | string[] | undefined, peer: string | undefined): string {
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  const last = header?.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  return (last || peer || '').replace(/^::ffff:/, '');
}
