# Security page

[← Documentation index](README.md)

The Security page brings together the fleet's firewall posture, certificates, and known
vulnerabilities in the RouterOS versions it runs.

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
