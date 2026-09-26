/**
 * Return a short, stable message for API clients; log full detail server-side only.
 *
 * Mapped by `err.code` where we have one, so "hostname doesn't resolve" and
 * "port firewalled" read differently from "wrong password" — useful now that
 * the address can be a hostname or a public IP, not just a LAN IP an operator
 * can eyeball. These reveal no more than a port probe would.
 */
export function safeConnectionError(context: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  console.warn(`[${context}]`, raw);

  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Hostname could not be resolved. Check the address for typos.';
    case 'ECONNREFUSED':
      return 'Connection refused. Check that the API service is enabled on this port.';
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Device unreachable. Check routing and firewall rules to this address and port.';
    case 'ECONNRESET':
      return 'Connection was reset. Check the port and that api-ssl is used if required.';
    default:
      // RouterOS's own login refusal, surfaced by RouterOSClient as a message.
      if (/invalid user name or password/i.test(raw)) {
        return 'Login failed: the username or password is wrong.';
      }
      // Connected, but nothing answered in the API protocol: usually the Winbox,
      // SSH or web port rather than the API one.
      if (/read timeout waiting for api response/i.test(raw)) {
        return 'The device accepted the connection but did not answer as the RouterOS API. '
          + 'Check the port is the API port (8728, or 8729 for api-ssl).';
      }
      // RouterOSClient's own connect-timeout has no .code, only a message.
      if (/connection timeout/i.test(raw)) {
        return 'Timed out connecting to the device. Check the address, port, and firewall rules.';
      }
      // The TCP handshake succeeded but the socket closed before login finished —
      // RouterOS itself accepted the connection, then dropped it. The usual cause
      // is IP > Services > api(-ssl) restricting "Available From" to an address
      // range (e.g. a VPN subnet) that this connection isn't part of.
      if (/connection closed/i.test(raw)) {
        return 'The device closed the connection during login. If RouterOS\'s API service '
          + '(IP > Services) restricts "Available From" to certain addresses, this one isn\'t on that list.';
      }
      return 'Cannot connect to device. Check the address, port, credentials, and that the API service is reachable.';
  }
}
