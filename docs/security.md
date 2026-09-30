# Security page

[← Documentation index](README.md)

The Security page brings together the fleet's firewall posture, certificates, and known
vulnerabilities in the RouterOS versions it runs.

## Encrypted management (API-SSL)

The manager talks to each device over the RouterOS API. On the plain API (port 8728) the
device's username and password cross the network unencrypted on every poll, every 30
seconds. API-SSL (port 8729) encrypts the whole session.

While any device is still on the plain API, the Security page shows a notice listing them
("N devices are managed over the unencrypted API"). Once every device is on API-SSL the
notice goes away. **Switch to API-SSL** (per device, or **Switch all online** when more
than one is online) does this on the device:

1. Uses the certificate already assigned to the `api-ssl` service if it has a working one.
   Otherwise it creates a self-signed certificate named `mtm-api-ssl` (valid 10 years) and
   signs it on the device, which takes a few seconds, longer on small devices.
2. Enables `api-ssl` on port 8729 with that certificate.
3. Logs in over API-SSL on a new connection. Only if that works does the manager move its
   connection for the device to 8729.

If the login over API-SSL fails, the device stays on 8728 and the card says why. The usual
cause is a firewall rule, or the `api-ssl` service's *Available From* list, that lets 8728 in
but not 8729. The plain `api` service is left running either way; once a device is on
API-SSL, its **Security** tab offers to turn the plain API off.

The same switch is on each device's **Security** tab, next to the *MikroTik Manager connects
over the plain API* finding.

The certificate is self-signed, so there is no certificate authority to check it against.
Instead the manager pins it, below.

## Certificate and host key pinning

The first time the manager connects to a device over API-SSL it remembers the device's
certificate, and the first time over SSH its host key. Every later connection has to present
the same one. If it doesn't, the manager stops **before sending the device's login**, so
someone posing as the device on the network never receives the password.

When that happens:

- the device shows as offline, and its page shows a red banner with the fingerprint the
  manager trusts and the one the device now presents;
- the Security page lists it at the top;
- a critical event is logged and the `device_identity_changed` alert fires (on by default).

A changed certificate or host key usually has an ordinary cause: the device was reset, its
certificate was regenerated, or it was replaced. Check the new fingerprint on the device
before trusting it:

- **Certificate:** on the device, **System → Certificates**, open the certificate the
  `api-ssl` service uses and compare its **Fingerprint**. The manager shows it in the same
  form.
- **SSH host key:** from a computer on a network you trust, run
  `ssh-keyscan -p PORT ADDRESS | ssh-keygen -lf -` and compare the `SHA256:` value.

An admin then clicks **Trust new certificate** (or **Trust new host key**) on the banner, and
the manager reconnects. When the manager replaces a device's certificate itself, through
**Switch to API-SSL**, it updates the pin on its own.

Pinning starts silently on upgrade: devices already managed are pinned the next time the
manager connects to them. Manage each device by its own address; two devices sharing an
address (a VRRP address, for example) would look like one device whose certificate keeps
changing.

## RouterOS vulnerabilities

Every RouterOS version in use in the current site is listed with the known vulnerabilities
(CVEs) filed against it. Versions with the most serious problems come first, and a version
with none says so.

Open a version to see its devices and each CVE:

- **Severity and score** (CVSS), from the newest scoring the entry has
- **Actively exploited**: CISA lists it as one attackers are using. Treat these first
- **Fixed in**: the first release on that line that isn't affected, when the entry says
- A short description, and a link to the full write-up

**Where it comes from.** The list is NIST's National Vulnerability Database (NVD) entries for
RouterOS, with CISA's Known Exploited Vulnerabilities catalogue marking the exploited ones.
The manager downloads both once a day (one request to each), and **Check now** fetches them
on demand. An NVD API key is optional; set `NVD_API_KEY` to use one.

**What a match means.** A match says the version is *listed* as affected. It doesn't say the
device can be attacked: many CVEs need a particular service (SSH, winbox, btest, the web
interface, hotspot) to be reachable. Read each one before acting. A few NVD entries give no
usable version range; they aren't matched, and the page says how many.

**Matches that may not apply.** NVD often lists a CVE as "before 7.5" with no starting
version, which takes in every RouterOS 6 release even when the flaw was only ever in v7. On a
v6 device such a match is shown greyed out as *may not apply*, with the reason, and isn't
counted in the version's total. Actively exploited CVEs are never greyed out.

**Corrections.** A few entries are known to be wrong for a release line and are left out,
with a note saying so. For example, CVE-2025-6443 is a VXLAN flaw listed as "before 7.20",
but RouterOS 6 has no VXLAN. If you find another, please
[open an issue](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues) with the CVE id.

**Dark Site Mode.** The download is listed under **Settings → Dark Site Mode** as
*RouterOS vulnerability list*. Turned off, nothing is fetched and the card says so.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/security/cves` | The versions in the current site, with their CVEs |
| `POST` | `/api/security/cves/refresh` | Download the lists now |
