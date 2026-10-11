#!/bin/sh
set -e

CERT=/certs/server.crt
KEY=/certs/server.key
RELOAD_SIGNAL=/certs/.reload

# Ensure certs directory exists (it will be a mounted volume, but just in case)
mkdir -p /certs

# Generate self-signed certificate if none exists
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
    echo "[entrypoint] No certificate found — generating self-signed certificate..."
    openssl req -x509 -nodes -days 3650 \
        -newkey rsa:2048 \
        -keyout "$KEY" \
        -out "$CERT" \
        -subj "/CN=Mikrotik Manager/O=Self-Signed/OU=Local/C=US" \
        -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" \
        2>/dev/null
    echo "[entrypoint] Self-signed certificate generated (valid 10 years)."
fi

# The backend (a non-root user, uid 100 / gid 101 in backend/Dockerfile)
# replaces these files when a certificate is uploaded or regenerated in
# Settings. Left owned by root, as this script creates them, that failed with
# "permission denied". nginx itself runs as root here and reads them either way.
# The key stays readable by its owner only.
BACKEND_UID="${CERTS_OWNER_UID:-100}"
BACKEND_GID="${CERTS_OWNER_GID:-101}"
chown -R "$BACKEND_UID:$BACKEND_GID" /certs 2>/dev/null || echo "[entrypoint] warning: could not hand /certs to the backend user"
chmod 700 /certs
chmod 600 "$KEY"
chmod 644 "$CERT"

# The HTTPS port the browser is redirected to (outside review O5). Only
# digits are accepted, so nothing else can reach the nginx config.
HTTPS_PORT="${HTTPS_PORT:-443}"
case "$HTTPS_PORT" in
    ''|*[!0-9]*) echo "[entrypoint] warning: HTTPS_PORT '$HTTPS_PORT' isn't a port number; redirecting to 443"; HTTPS_PORT=443 ;;
esac
mkdir -p /var/cache/nginx
if [ "$HTTPS_PORT" = "443" ]; then
    echo 'set $https_port_suffix "";' > /var/cache/nginx/https-port.conf
else
    echo "set \$https_port_suffix \":$HTTPS_PORT\";" > /var/cache/nginx/https-port.conf
fi

# TLS_MODE (#256): "https" (the default) redirects port 80 to HTTPS; "proxy"
# serves the app over plain HTTP on port 80, for a reverse proxy in front that
# terminates TLS with your own certificate.
TLS_MODE="${TLS_MODE:-https}"
case "$TLS_MODE" in
    https|proxy) ;;
    *) echo "[entrypoint] warning: TLS_MODE '$TLS_MODE' isn't https or proxy; using https"; TLS_MODE=https ;;
esac
if [ "$TLS_MODE" = "proxy" ]; then
    echo 'include /etc/nginx/mtm-app.conf;' > /var/cache/nginx/http-mode.conf
    echo "[entrypoint] TLS_MODE=proxy: serving the app over plain HTTP on port 80 for a reverse proxy."
    echo "[entrypoint] Keep port ${HTTP_PORT:-80} reachable only by the proxy (BIND_ADDRESS, or a firewall), since logins cross it unencrypted."
else
    printf '%s\n' 'include /var/cache/nginx/https-port.conf;' 'return 301 https://$host$https_port_suffix$request_uri;' > /var/cache/nginx/http-mode.conf
fi

# TRUSTED_PROXIES (#256): reverse proxies whose X-Forwarded-For and
# X-Forwarded-Proto are believed, as addresses or CIDR ranges separated by
# commas or spaces. Anything else is ignored with a warning, so only address
# characters can reach the nginx config. Unset, no forwarded header from
# outside is trusted and a proxy's requests are logged as the proxy.
TRUST_FILE=/var/cache/nginx/proxy-trust.conf
TRUSTED=""
for p in $(echo "${TRUSTED_PROXIES:-}" | tr ',' ' '); do
    case "$p" in
        *[!0-9a-fA-F:./]*) echo "[entrypoint] warning: ignoring TRUSTED_PROXIES entry '$p' (not an address or range)" ;;
        *) TRUSTED="$TRUSTED $p" ;;
    esac
done
if [ -n "$TRUSTED" ]; then
    {
        for p in $TRUSTED; do echo "set_real_ip_from $p;"; done
        echo 'real_ip_header X-Forwarded-For;'
        echo 'real_ip_recursive on;'
        echo 'geo $realip_remote_addr $mtm_from_trusted_proxy {'
        echo '    default 0;'
        for p in $TRUSTED; do echo "    $p 1;"; done
        echo '}'
        echo 'map "$mtm_from_trusted_proxy:$http_x_forwarded_proto" $fwd_proto {'
        echo '    default $scheme;'
        echo '    "1:https" https;'
        echo '    "1:http" http;'
        echo '}'
    } > "$TRUST_FILE"
    echo "[entrypoint] Trusting forwarded client address and scheme from:$TRUSTED"
else
    echo 'map $scheme $fwd_proto { default $scheme; }' > "$TRUST_FILE"
    if [ "$TLS_MODE" = "proxy" ]; then
        echo "[entrypoint] warning: TLS_MODE=proxy without TRUSTED_PROXIES: every request will be logged as coming from the proxy, and per-address login limits apply to all users together. Set TRUSTED_PROXIES to the proxy's address."
    fi
fi

# IPv6 listeners (#231), only where the kernel has IPv6: on a host booted with
# it disabled, listening on [::] would stop nginx starting. Same test the
# official nginx image uses.
if [ -f /proc/net/if_inet6 ]; then
    echo 'listen [::]:80;' > /var/cache/nginx/listen-v6-http.conf
    echo 'listen [::]:443 ssl;' > /var/cache/nginx/listen-v6-https.conf
else
    echo "[entrypoint] IPv6 isn't available; listening on IPv4 only."
    : > /var/cache/nginx/listen-v6-http.conf
    : > /var/cache/nginx/listen-v6-https.conf
fi

# Background watcher: reload nginx when backend writes a .reload signal file
(while true; do
    if [ -f "$RELOAD_SIGNAL" ]; then
        rm -f "$RELOAD_SIGNAL"
        echo "[entrypoint] Certificate change detected — reloading nginx..."
        nginx -s reload 2>/dev/null || true
    fi
    sleep 5
done) &

echo "[entrypoint] Starting nginx..."
exec nginx -g "daemon off;"
