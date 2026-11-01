/**
 * Connection options for sending mail through an email alert channel.
 *
 * The server's certificate is checked unless the channel turns it off
 * (`smtp_tls_verify: false`, for an internal server with a self-signed
 * certificate). Alert email used to skip the check for everyone, so whoever sat
 * between the manager and the mail server could read the SMTP login
 * (GHSA-63v6-w7qf-349f). With the check on and a login to send, STARTTLS is
 * required too: otherwise a server, or someone in between, that doesn't offer
 * it would receive the login unencrypted.
 */
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

export function smtpTransportOptions(cfg: Record<string, unknown>): SMTPTransport.Options {
  const user = typeof cfg.smtp_user === 'string' && cfg.smtp_user ? cfg.smtp_user : undefined;
  const pass = typeof cfg.smtp_pass === 'string' && cfg.smtp_pass ? cfg.smtp_pass : undefined;
  const secure = !!cfg.smtp_secure;
  const verify = cfg.smtp_tls_verify !== false;
  const auth = user && pass ? { user, pass } : undefined;
  return {
    host: cfg.smtp_host as string,
    port: (cfg.smtp_port as number) || 587,
    secure,
    auth,
    tls: { rejectUnauthorized: verify },
    requireTLS: verify && !secure && !!auth,
  };
}

const CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * A sending error in words an admin can act on. Node's own text for an
 * untrusted certificate suggests restarting Node with a flag, which isn't
 * something anyone running the manager can do.
 */
export function describeSmtpError(err: unknown): Error {
  const e = err as Error & { code?: string; cause?: { code?: string } };
  const code = e?.code && CERT_CODES.has(e.code) ? e.code : e?.cause?.code;
  if ((code && CERT_CODES.has(code)) || /self[- ]signed certificate|unable to verify|certificate has expired|altnames/i.test(e?.message ?? '')) {
    return new Error("The mail server's certificate isn't trusted (self-signed, expired, or for another name). "
      + "If it's your own server, untick \"Check the server's certificate\" on the email channel.");
  }
  if (/STARTTLS/i.test(e?.message ?? '')) {
    return new Error("The mail server doesn't offer STARTTLS, so the login wasn't sent. Use port 465 with TLS/SSL, "
      + "or untick \"Check the server's certificate\" on the email channel to send without encryption.");
  }
  return e instanceof Error ? e : new Error(String(err));
}
