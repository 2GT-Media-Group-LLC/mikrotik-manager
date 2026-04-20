# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.10.x (current beta) | Yes |
| Earlier versions | No |

MikroTik Manager is currently in beta. Security fixes will be applied to the latest release only.

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

## Security Considerations for Self-Hosted Deployments

MikroTik Manager is designed to be run on your local network. A few things to keep in mind:

- **Do not expose this application directly to the public internet.** It is intended for LAN or VPN-only access.
- The `.env` file contains sensitive credentials (JWT secret, encryption key, database passwords). Protect this file and never commit it to version control.
- Device credentials stored in the database are encrypted at rest using AES-256.
- HTTPS is enforced by default. The included nginx configuration redirects all HTTP traffic to HTTPS.
- Default credentials should be changed immediately after first login.
- The built-in role-based access control (Admin / Operator / Viewer) should be used to limit user privileges.

## AI-Assisted Security Infrastructure

The security measures in this project were designed and implemented with the assistance of [Claude](https://claude.ai) by Anthropic, including:

- **ESLint security rules** — static analysis configured with `eslint-plugin-security` to catch common vulnerabilities (injection risks, unsafe regex, insecure randomness, etc.)
- **Unit tests** — test coverage for security-critical code paths including AES-256-GCM encryption/decryption, JWT signing and verification, and role-based access control middleware
- **CI pipeline** — automated linting, type-checking, dependency auditing (`npm audit`), and CodeQL analysis on every push and pull request
- **Credential handling** — encryption-at-rest design for stored device credentials, JWT secret management, and `.env`-based secrets isolation

AI-generated security infrastructure is reviewed and validated the same as any other code. If you discover a gap or vulnerability, please report it using the process above.
