#!/bin/sh
# Runs acme-status.sh in each of its modes, in the nginx image's own base (read
# from nginx/Dockerfile, so a base bump is tested as shipped), then checks the
# entrypoint starts on a read-only root filesystem, as docker-compose.yml runs
# it. Used by CI and scripts/ci-preflight.sh. Needs Docker and network access.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BASE=$(sed -n 's/^FROM \(nginx:alpine@sha256:[0-9a-f]*\).*/\1/p' "$ROOT/nginx/Dockerfile")
if [ -z "$BASE" ]; then
    echo "No nginx:alpine base found in nginx/Dockerfile" >&2
    exit 1
fi
IMAGE="mtm-acme-test:$$"
trap 'docker image rm -f "$IMAGE" >/dev/null 2>&1 || true' EXIT
printf 'FROM %s\nRUN apk add --no-cache certbot openssl su-exec\n' "$BASE" | docker build -q -t "$IMAGE" - >/dev/null

for mode in status proxy real; do
    arg=$mode
    [ "$mode" = status ] && arg=
    # $arg is unquoted on purpose: the status mode passes no argument.
    # shellcheck disable=SC2086
    docker run --rm --memory 256m --cpus 1 -v "$ROOT:/source:ro" --entrypoint sh "$IMAGE" /source/nginx/tests/acme-status.sh $arg
done

# #439: the entrypoint must reach nginx with only the compose file's tmpfs
# mounts writable, whatever the compose file in use. nginx is stubbed from
# /stub (Docker's tmpfs mounts are noexec unless asked), and the run is capped
# so a real nginx starting by mistake can't hang CI.
for tls in https proxy; do
    out=$(docker run --rm --memory 256m --cpus 1 --read-only \
        --tmpfs /var/cache/nginx --tmpfs /var/run --tmpfs /tmp --tmpfs /certs --tmpfs /stub:exec \
        -e TLS_MODE=$tls -v "$ROOT:/source:ro" --entrypoint sh "$IMAGE" -c \
        'printf "#!/bin/sh\necho NGINX-STARTED\n" > /stub/nginx && chmod +x /stub/nginx && PATH=/stub:$PATH timeout 60 sh /source/nginx/entrypoint.sh' 2>&1) || true
    if ! printf '%s\n' "$out" | grep -q NGINX-STARTED; then
        printf '%s\n' "$out" >&2
        echo "The entrypoint didn't reach nginx on a read-only root filesystem (TLS_MODE=$tls)." >&2
        exit 1
    fi
    echo "Read-only start with TLS_MODE=$tls reaches nginx."
done
