# Contributing to MikroTik Manager

Thanks for helping out. Bug reports, ideas, docs fixes and code are all welcome, and a lot of
MikroTik Manager has been shaped by people running it on their own networks.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs and asking for features

- **Bugs:** open an issue with the **Bug report** form. The version, how it's installed and the
  backend log answer most of our first questions.
- **Features:** open an issue with the **Feature request** form. For anything set on a device, a
  WinBox screenshot or a few lines of `/export` show exactly what you mean.
- **Questions, and ideas you'd like to talk through:** use
  [Discussions](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/discussions).
- **Security problems:** please don't open an issue. Report them privately as described in
  [SECURITY.md](SECURITY.md).

## Branches and releases

| Branch | Releases | What goes in |
|---|---|---|
| `main` | Stable 1.0.x, the `:latest` images | Fixes only |
| `dev` | Betas of the next version, the `:beta` images | New features, and everything else |

So a new feature targets `dev`, and a fix for something broken in the stable release targets
`main` (we copy it to `dev`). Not sure which? Use `dev` and we'll move it if needed.

For anything bigger than a small fix, such as a new page, a change to the database or something
that writes to devices, please open an issue or discussion first so we can agree on the approach
before you spend time on it.

## Running it locally

You need Docker with Compose, and Node 26 for the checks below.

```bash
git clone https://github.com/2GT-Media-Group-LLC/mikrotik-manager.git
cd mikrotik-manager
cp .env.example .env
docker compose up -d
```

It's then at https://localhost (accept the self-signed certificate warning). After changing code,
rebuild with `docker compose up -d --build backend nginx`.

Test against lab equipment, never a network people depend on. A
[MikroTik CHR](https://mikrotik.com/download) in a VM is a free way to have a router to point it at.

## Before you open a pull request

- **Run `scripts/ci-preflight.sh`.** It runs what CI runs: lint, type-check, tests and builds for
  the backend and frontend, plus dependency audits. Run `npm ci` in `backend/` and `frontend/`
  first. With Docker running, it also runs the database tests against a throwaway Postgres.
- **Add or update tests.** The backend uses Jest and the frontend Vitest; `npm test` in either
  folder runs them.
- **Code that reads input from outside** (a packet, a log line, a request body, a path) has
  property-based fuzz tests, in files ending `.fuzz.test.ts`, using
  [fast-check](https://fast-check.dev/). They generate a few hundred inputs per property in CI;
  set `FUZZ_RUNS` for more. A failure prints a seed: `FUZZ_SEED=<seed> FUZZ_RUNS=1` with the same
  test replays it. The weekly **Fuzz** workflow runs them with far more cases, plus
  coverage-guided fuzzing of the NetFlow decoder and the firewall log parser with Jazzer.js
  (`fuzz/`; build the backend, then `npm ci`, `npm run seed` and `npm run netflow` there). If
  you change one of those parsers, a fuzz property for it is welcome.
- **Update the docs.** The guides are the Markdown files in `docs/`, published as the
  [documentation site](https://2gt-media-group-llc.github.io/mikrotik-manager/latest/). Change them
  in the same pull request as the behaviour they describe. To check they build:
  `pip install -r requirements-docs.txt`, then `mkdocs build --strict`. Please leave the README
  to the maintainers and describe features in `docs/`.
- **Changes that write to a device** should work the way the existing ones do: show what will
  change before it happens (**Review changes**), refuse bad input in the form with a reason
  rather than only on the server, and go through [Change Guard](docs/change-guard.md) where a
  mistake could cut off access to the device.
- **One change per pull request.** Two unrelated changes are easier to review, and to ship, as
  two pull requests.

## What happens next

We read every line of a pull request before running it, then try it on a test install and, where
it touches devices, on lab hardware. For a first-time contributor, GitHub waits for us to approve
the CI run. We may ask for changes, and sometimes we merge a pull request by applying its commits
ourselves and then close it with a note saying where it landed. Contributions are credited in the
release notes.

## License

MikroTik Manager is licensed under the [GNU AGPL v3](LICENSE). By contributing, you agree that
your contribution is licensed under the same terms.
