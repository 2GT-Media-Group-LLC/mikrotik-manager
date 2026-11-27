#!/bin/sh
# Verify the static frontend image: SPA deep links, asset caching, the 404 rule
# for missing assets, security headers, compression, and that the image serves
# no API. Runs the image and checks it over HTTP; needs Docker and curl.
#
#   sh frontend/tests/serve.sh <image>
set -eu

# A hung image must not hang CI; bound every request.
curl() { command curl --max-time 5 "$@"; }

image="${1:?usage: serve.sh <image>}"
name="mtm-frontend-test-$$-$(date +%s)"

cleanup() {
    docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run -d --rm --name "$name" -p "127.0.0.1::8080" "$image" >/dev/null
hostport="$(docker port "$name" 8080/tcp | head -1 | sed 's/.*://')"
if [ -z "$hostport" ]; then
    echo "could not find the published frontend port" >&2
    exit 1
fi
base="http://127.0.0.1:$hostport"

ready=0
i=0
while [ "$i" -lt 30 ]; do
    if curl -fsS "$base/health" >/dev/null 2>&1; then
        ready=1
        break
    fi
    i=$((i + 1))
    sleep 1
done
if [ "$ready" -ne 1 ]; then
    echo "frontend did not become ready:" >&2
    docker logs "$name" >&2 2>&1 || true
    exit 1
fi

fail=0
ok() { echo "ok - $1"; }
no() { echo "not ok - $1" >&2; fail=1; }

expect_status() {
    desc=$1 want=$2 url=$3
    got="$(curl -s -o /dev/null -w '%{http_code}' "$url")"
    if [ "$got" = "$want" ]; then ok "$desc"; else no "$desc (got $got, want $want)"; fi
}
header_of() {
    curl -sS -D - -o /dev/null "$1" | tr -d '\r' |
        awk -F': ' -v h="$2" 'tolower($1)==tolower(h){print substr($0, index($0,": ")+2); exit}'
}
expect_header() {
    desc=$1 url=$2 header=$3 pattern=$4
    got="$(header_of "$url" "$header")"
    if printf '%s' "$got" | grep -qi -- "$pattern"; then
        ok "$desc"
    else
        no "$desc (got '$got')"
    fi
}

expect_status "root is 200" 200 "$base/"
if curl -fsS "$base/" | grep -q '<div id="root">'; then
    ok "root mounts the SPA"
else
    no "root mounts the SPA"
fi
expect_status "SPA deep link /dashboard" 200 "$base/dashboard"
expect_status "SPA deep link /devices/42" 200 "$base/devices/42"
expect_status "health endpoint" 200 "$base/health"

asset="$(curl -fsS "$base/" | sed -n 's/.*src="\(\/assets\/[^"]*\.js\)".*/\1/p' | head -1)"
if [ -n "$asset" ]; then
    ok "finds a hashed JS asset in index.html"
    expect_status "hashed asset is 200" 200 "$base$asset"
    expect_header "hashed asset is JavaScript" "$base$asset" content-type 'javascript'
    expect_header "hashed asset is immutable" "$base$asset" cache-control 'immutable'
    gzip_header="$(curl -sS -D - -o /dev/null -H 'Accept-Encoding: gzip' "$base$asset" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-encoding"{print $2; exit}')"
    if printf '%s' "$gzip_header" | grep -qi gzip; then
        ok "hashed asset is compressed"
    else
        no "hashed asset is compressed (got '$gzip_header')"
    fi
else
    no "finds a hashed JS asset in index.html"
fi

expect_status "missing asset is 404" 404 "$base/assets/does-not-exist.js"
if curl -sS "$base/assets/does-not-exist.js" | grep -q '<div id="root">'; then
    no "missing asset is not index.html"
else
    ok "missing asset is not index.html"
fi
missing_cache="$(header_of "$base/assets/does-not-exist.js" cache-control)"
if printf '%s' "$missing_cache" | grep -qi immutable; then
    no "missing asset is not cached as immutable"
else
    ok "missing asset is not cached as immutable"
fi

expect_status "favicon is served" 200 "$base/favicon.svg"
expect_status "image does not proxy the API" 404 "$base/api/health"

expect_header "CSP is set" "$base/" content-security-policy "frame-ancestors 'none'"
expect_header "X-Frame-Options is DENY" "$base/" x-frame-options 'DENY'
expect_header "X-Content-Type-Options is nosniff" "$base/" x-content-type-options 'nosniff'
expect_header "Referrer-Policy is set" "$base/" referrer-policy 'strict-origin-when-cross-origin'
expect_header "HSTS is set" "$base/" strict-transport-security 'max-age=31536000'

traversal="$(curl --path-as-is -s -o /dev/null -w '%{http_code}' "$base/../etc/passwd")"
case "$traversal" in
    400|404) ok "path traversal is rejected ($traversal)" ;;
    *) no "path traversal returned $traversal" ;;
esac

if [ "$fail" -ne 0 ]; then
    echo "frontend image checks failed" >&2
    exit 1
fi
echo "frontend image checks passed"
