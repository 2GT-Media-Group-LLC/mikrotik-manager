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
