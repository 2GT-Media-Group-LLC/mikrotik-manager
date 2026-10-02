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
