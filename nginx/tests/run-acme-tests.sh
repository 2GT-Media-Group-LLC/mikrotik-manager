#!/bin/sh
# Runs acme-status.sh in each of its modes, in the nginx image's own base (read
# from nginx/Dockerfile, so a base bump is tested as shipped). Used by CI and
# scripts/ci-preflight.sh. Needs Docker and network access for apk.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BASE=$(sed -n 's/^FROM \(nginx:alpine@sha256:[0-9a-f]*\).*/\1/p' "$ROOT/nginx/Dockerfile")
if [ -z "$BASE" ]; then
    echo "No nginx:alpine base found in nginx/Dockerfile" >&2
    exit 1
fi
for mode in status proxy real; do
    arg=$mode
    [ "$mode" = status ] && arg=
    # $arg is unquoted on purpose: the status mode passes no argument.
    # shellcheck disable=SC2086
    docker run --rm --memory 256m --cpus 1 -v "$ROOT:/source:ro" --entrypoint sh "$BASE" -c \
        'apk add --no-cache -q certbot openssl su-exec >/dev/null && sh /source/nginx/tests/acme-status.sh "$@"' _ $arg
done
