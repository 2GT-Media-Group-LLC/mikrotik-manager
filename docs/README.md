# MikroTik Manager documentation

Reference material for people already running the platform. If you are still deciding
whether to try it, the [project README](../README.md) is the better starting point.

| Document | Covers |
|---|---|
| [Configuration](configuration.md) | Environment variables, secret management and key rotation |
| [Change Guard and Config Health](change-guard.md) | How the safety system works, its settings, and what to expect when it fires |
| [Alerting](alerting.md) | Alert rules, delivery channels, webhooks, scheduled reports, maintenance windows |
| [Single sign-on (OIDC)](sso-oidc.md) | Identity provider setup, group-to-role mapping, break-glass behaviour |
| [CAPsMAN](capsman.md) | How centrally provisioned access points are modelled, and current limits |
| [API and automation](api.md) | Scoped tokens, authentication, and driving the platform from scripts |
| [Architecture](architecture.md) | How the system is put together, for contributors |

## Conventions used here

- **Settings in the UI** are stored in the database and apply without a restart.
- **Environment variables** live in `.env` and require a container restart to change.
- Anything described as *read-only* makes no writes to your devices.
