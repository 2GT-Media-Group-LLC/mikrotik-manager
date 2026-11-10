#!/usr/bin/env bash
# Run the same gates GitHub Actions runs, locally, before pushing.
#
# Mirrors .github/workflows/ci.yml exactly (frontend lint/type-check/test/build,
# backend lint/type-check/build, prod-dependency audits) and additionally runs
# the backend Jest suite, which CI does not currently cover.
#
# Usage:  scripts/ci-preflight.sh [--skip-audit]
# Exit:   0 = everything CI checks would pass, 1 = at least one gate failed.
#
# Runs every gate rather than failing fast, so one invocation surfaces all
# problems instead of dribbling them out one push at a time.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_AUDIT=0
[[ "${1:-}" == "--skip-audit" ]] && SKIP_AUDIT=1

# Per-run scratch output, so two preflights at once don't overwrite each
# other's. The failure excerpt goes where CI_PREFLIGHT_FAILURES says (the push
# gate passes its own file), or the usual /tmp path.
OUT="$(mktemp -t ci-preflight-out.XXXXXX)"
FAILURES="${CI_PREFLIGHT_FAILURES:-/tmp/ci-preflight-failures}"
trap 'rm -f "$OUT"' EXIT

FAILED=()
run() {
  local label="$1" dir="$2"; shift 2
  printf '  %-34s' "$label"
  if (cd "$ROOT/$dir" && "$@") >"$OUT" 2>&1; then
    echo "ok"
  else
    echo "FAIL"
    FAILED+=("$label")
    # Keep a trimmed excerpt so the caller can see why without re-running.
    {
      echo "----- $label -----"
      tail -25 "$OUT"
      echo
    } >>"$FAILURES"
  fi
}

: >"$FAILURES"
echo "Running CI gates locally (mirrors .github/workflows/ci.yml)"

# The published deployment file is generated. Checking it first because it costs
# nothing and because drift here is invisible to every maintainer — it only ever
# breaks the Quick Deploy path that no one on the team runs (#121).
run "compose: ghcr in sync"  .  node scripts/generate-ghcr-compose.mjs --check

run "backend: lint"        backend  npm run lint
run "backend: type-check"  backend  npx tsc --noEmit
run "backend: build"       backend  npm run build
run "backend: tests"       backend  npx jest --silent

# The platform-backup round trip against a real Postgres, as CI runs it with its
# service database. A throwaway container on a spare port; skipped without Docker.
#
# The container's name is unique to this run and Docker picks the port: two
# preflights at once (a manual run plus the push gate's) used to share a fixed
# name and port, and one's cleanup removed the other's database mid-test.
# Readiness is checked over TCP, which the first-boot init server doesn't
# listen on, so the tests don't start against a server about to restart.
e2e_pg() {
  local name="mtm-preflight-pg-$$-$RANDOM" port=''
  docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=mtm_e2e \
    -p "127.0.0.1::5432" postgres:15-alpine >/dev/null || return 1
  local ok=1
  for _ in $(seq 1 60); do
    docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && { ok=0; break; }
    sleep 1
  done
  port="$(docker port "$name" 5432/tcp 2>/dev/null | head -1 | sed 's/.*://')"
  if [[ $ok -ne 0 || -z "$port" ]]; then
    echo "Postgres container $name didn't become ready"
    docker rm -f "$name" >/dev/null 2>&1
    return 1
  fi
  PG_E2E_URL="postgres://postgres:e2e@127.0.0.1:$port/mtm_e2e" npx jest --silent "\.pg\.test\.ts$"
  local rc=$?
  docker rm -f "$name" >/dev/null 2>&1
  return $rc
}
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  run "backend: Postgres tests"     backend  e2e_pg
  run "nginx: ACME entrypoint"      nginx    sh tests/run-acme-tests.sh
else
  printf '  %-34s%s\n' "backend: Postgres tests" "skipped (no Docker)"
  printf '  %-34s%s\n' "nginx: ACME entrypoint" "skipped (no Docker)"
fi
run "frontend: lint"       frontend npm run lint
run "frontend: type-check" frontend npx tsc --noEmit
run "frontend: tests"      frontend npm test
run "frontend: build"      frontend npm run build

if [[ $SKIP_AUDIT -eq 0 ]]; then
  run "frontend: audit (prod)" frontend \
    npx --yes audit-ci@^7 --high --skip-dev --allowlist GHSA-qwww-vcr4-c8h2
  run "backend: audit (prod)"  backend \
    npx --yes audit-ci@^7 --high --skip-dev
fi

if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo "All CI gates passed."
  exit 0
fi

echo
echo "FAILED: ${FAILED[*]}"
echo "Details in $FAILURES"
exit 1
