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

for mode in status proxy http real; do
    arg=$mode
    [ "$mode" = status ] && arg=
    # $arg is unquoted on purpose: the status mode passes no argument.
    # shellcheck disable=SC2086
    docker run --rm --memory 256m --cpus 1 -v "$ROOT:/source:ro" --entrypoint sh "$IMAGE" /source/nginx/tests/acme-status.sh $arg
done

# #439: validate the generated config with only the Compose tmpfs mounts writable.
# Wrap nginx to dump its effective config and exit instead of serving requests.
for tls in https proxy http; do
    set --
    if [ "$tls" != http ]; then
        set -- --tmpfs /certs
    fi
    upstream=backend:3001
    case "$tls" in
        proxy) set -- "$@" -e BACKEND_UPSTREAM= ;;
        http) upstream=127.0.0.1:3100; set -- "$@" -e "BACKEND_UPSTREAM=$upstream" ;;
    esac
    if ! out=$(docker run --rm --memory 256m --cpus 1 --read-only --add-host backend:127.0.0.1 \
        --tmpfs /var/cache/nginx --tmpfs /var/run --tmpfs /tmp --tmpfs /stub:exec "$@" \
        -e "TLS_MODE=$tls" -v "$ROOT:/source:ro" \
        -v "$ROOT/nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
        -v "$ROOT/nginx/mtm-app.conf:/etc/nginx/mtm-app.conf:ro" \
        -v "$ROOT/nginx/mtm-https.conf:/etc/nginx/mtm-https.conf:ro" \
        --entrypoint sh "$IMAGE" -c \
        'printf "#!/bin/sh\nexec /usr/sbin/nginx -T\n" > /stub/nginx && chmod +x /stub/nginx && PATH=/stub:$PATH timeout 60 sh /source/nginx/entrypoint.sh' 2>&1); then
        printf '%s\n' "$out" >&2
        echo "nginx configuration failed on a read-only root filesystem (TLS_MODE=$tls)." >&2
        exit 1
    fi
    case "$tls" in
        https) expected_http='return 301 https://' ;;
        proxy|http) expected_http='include /etc/nginx/mtm-app.conf;' ;;
    esac
    http_config=$(printf '%s\n' "$out" | sed -n '/^# configuration file .*\/http-mode.conf:$/,/^$/p')
    printf '%s\n' "$http_config" | grep -Fq "$expected_http"
    case "$tls" in
        https|proxy) printf '%s\n' "$out" | grep -Fq 'listen 443 ssl;' ;;
        http)
            if printf '%s\n' "$out" | grep -Fq 'listen 443 ssl;'; then
                echo 'Unexpected HTTPS listener in HTTP-only mode.' >&2
                exit 1
            fi
            ;;
    esac
    printf '%s\n' "$out" | grep -Fq "server \"$upstream\";"
    echo "Read-only nginx configuration passed for TLS_MODE=$tls."
done
