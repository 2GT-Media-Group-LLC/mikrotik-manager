# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| The latest release | Yes |
| Anything older | No |

MikroTik Manager is in beta, and security fixes go into the latest release only. Every commit to
`main` is a release: its version is in `backend/package.json`, shown in the app's sidebar and
tagged on the published images. Updating (`git pull` and `docker compose up -d --build`, or
`docker compose pull` with the published images) is how a fix is applied.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability, please use one of the following channels:

- **GitHub Private Security Advisory** *(preferred)*: Use the [Report a Vulnerability](../../security/advisories/new) button in the Security tab of this repository. This lets us discuss the issue privately before public disclosure.
- **Email**: Send details to the repository maintainer via the contact information on their GitHub profile.

### What to include in your report

- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- Any proof-of-concept code (if applicable)
- Your suggested fix (if you have one)

### What to expect

- **Acknowledgement** within 3 business days
- **Status update** within 7 days (confirmed, need more info, or not a vulnerability)
- **Fix and disclosure** coordinated with you once a patch is ready

We ask that you give us reasonable time to address the issue before any public disclosure. We will credit you in the release notes if you wish.

## Acknowledgements

Thank you to the people and organizations who have taken the time to review MikroTik Manager
and report what they found.

- **[Novus Insight](https://novusinsight.com)** carried out an independent code and security
  review of version 0.24.32 in September 2026: 12 serious findings, 36 bugs and 54 hardening
  items, each traced through the code and several reproduced. Every one of them is fixed, in
  0.24.35 through 0.24.51. The review led to session revocation, per-site access roles, API-SSL
  with certificate and host-key pinning, Change Guard refusing what it can't protect, honest
  restore results and signed, digest-pinned images, among much else. Novus Insight supports
  schools, municipalities and non-profit organizations, and runs MikroTik throughout.

## Security Considerations for Self-Hosted Deployments

MikroTik Manager is designed to be run on your local network. A few things to keep in mind:

- **Do not expose this application directly to the public internet.** It is intended for LAN or VPN-only access.
- The `.env` file holds the internal database passwords, and the JWT secret and encryption key if you set them yourself. Left unset, those two are generated on first start and kept in the `app_data` volume, which then needs the same protection. Never commit `.env` to version control.
- The internal database passwords default to publicly known values. Set your own; see [Internal service passwords](docs/configuration.md#internal-service-passwords).
- Device passwords are encrypted at rest with AES-256-GCM, and so are backups that contain secrets. Anyone holding both the database and the encryption key can decrypt them, so back up and protect them separately.
- The included nginx configuration redirects HTTP to HTTPS. Its certificate is self-signed until you upload your own.
- The first sign-in as `admin`/`admin` must set a new password before anything else works.
- Use the roles (admin, operator, viewer, fleet-wide or per site) to give people only the access they need.

## AI-Assisted Security Infrastructure

The security measures in this project were designed and implemented with the assistance of [Claude](https://claude.ai) by Anthropic, including:

- **ESLint security rules** — static analysis configured with `eslint-plugin-security` to catch common vulnerabilities (injection risks, unsafe regex, insecure randomness, etc.)
- **Unit tests** — test coverage for security-critical code paths including AES-256-GCM encryption/decryption, JWT signing and verification, and role-based access control middleware
- **CI pipeline** — automated linting, type-checking, dependency auditing (`npm audit`), and CodeQL analysis on every push and pull request
- **Credential handling** — encryption-at-rest design for stored device credentials, JWT secret management, and `.env`-based secrets isolation

AI-generated security infrastructure is reviewed and validated the same as any other code. If you discover a gap or vulnerability, please report it using the process above.
