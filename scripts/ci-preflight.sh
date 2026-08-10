#!/usr/bin/env bash
# Run the same gates GitHub Actions runs, locally, before pushing.
#
# Mirrors .github/workflows/ci.yml exactly (frontend lint/type-check/build,
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

FAILED=()
run() {
  local label="$1" dir="$2"; shift 2
  printf '  %-34s' "$label"
  if (cd "$ROOT/$dir" && "$@") >/tmp/ci-preflight-out 2>&1; then
    echo "ok"
  else
    echo "FAIL"
    FAILED+=("$label")
    # Keep a trimmed excerpt so the caller can see why without re-running.
    {
      echo "----- $label -----"
      tail -25 /tmp/ci-preflight-out
      echo
    } >>/tmp/ci-preflight-failures
  fi
}

: >/tmp/ci-preflight-failures
echo "Running CI gates locally (mirrors .github/workflows/ci.yml)"

run "backend: lint"        backend  npm run lint
run "backend: type-check"  backend  npx tsc --noEmit
run "backend: build"       backend  npm run build
run "backend: tests"       backend  npx jest --silent
run "frontend: lint"       frontend npm run lint
run "frontend: type-check" frontend npx tsc --noEmit
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
echo "Details in /tmp/ci-preflight-failures"
exit 1
