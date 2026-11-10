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

# The HTTP-01 challenge webroot is separate from /certs so nginx workers can
# read challenge files without gaining access to the private key. It lives on
# the /var/cache/nginx tmpfs, writable under read_only in every compose file
# (#439: a path needing a new volume stopped nginx on existing installs). The
# files only matter while Certbot runs, so nothing is lost on restart. If it
# can't be made, ACME is off and nginx starts regardless.
ACME_WEBROOT=/var/cache/nginx/acme
ACME_WEBROOT_OK=1
if ! mkdir -p "$ACME_WEBROOT" 2>/dev/null || ! chown "$BACKEND_UID:$BACKEND_GID" "$ACME_WEBROOT" 2>/dev/null || ! chmod 755 "$ACME_WEBROOT" 2>/dev/null; then
    ACME_WEBROOT_OK=0
fi

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
    printf '%s\n' 'location / {' '    include /var/cache/nginx/https-port.conf;' '    return 301 https://$host$https_port_suffix$request_uri;' '}' > /var/cache/nginx/http-mode.conf
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

# Optional HTTP-01 ACME issuance and renewal. Web settings are stored in the
# shared certificate volume and checked here every few seconds. A complete
# environment configuration takes precedence over the web settings.
ACME_SETTINGS_FILE=/certs/acme-settings.conf
ACME_STATUS_FILE=/certs/acme-last-attempt
ACME_ENV_DOMAIN="${ACME_DOMAIN:-}"
ACME_ENV_EMAIL="${ACME_EMAIL:-}"
ACME_ENV_SERVER="${ACME_SERVER:-}"
has_non_space() {
    case "$1" in
        *[![:space:]]*) return 0 ;;
        *) return 1 ;;
    esac
}
ACME_ENV_LOCKED=0
if has_non_space "$ACME_ENV_DOMAIN" && has_non_space "$ACME_ENV_EMAIL" && has_non_space "$ACME_ENV_SERVER"; then
    ACME_ENV_LOCKED=1
fi
read_acme_settings() {
    if [ "$ACME_ENV_LOCKED" = 0 ] && [ -f "$ACME_SETTINGS_FILE" ]; then
        acme_domain_seen=0
        acme_email_seen=0
        acme_server_seen=0
        acme_invalid=0
        if ! {
            while IFS= read -r acme_line || [ -n "$acme_line" ]; do
                case "$acme_line" in
                    ACME_DOMAIN=*) ACME_DOMAIN=${acme_line#ACME_DOMAIN=}; acme_domain_seen=$((acme_domain_seen + 1)) ;;
                    ACME_EMAIL=*) ACME_EMAIL=${acme_line#ACME_EMAIL=}; acme_email_seen=$((acme_email_seen + 1)) ;;
                    ACME_SERVER=*) ACME_SERVER=${acme_line#ACME_SERVER=}; acme_server_seen=$((acme_server_seen + 1)) ;;
                    '') ;;
                    *) acme_invalid=1 ;;
                esac
            done < "$ACME_SETTINGS_FILE"
        }; then
            acme_invalid=1
        fi
        if [ "$acme_invalid" -ne 0 ] || [ "$acme_domain_seen" -ne 1 ] || [ "$acme_server_seen" -ne 1 ]; then
            echo "[entrypoint] error: invalid ACME settings file; ACME is disabled."
            ACME_DOMAIN=
            ACME_EMAIL=
            ACME_SERVER=
        fi
    else
        ACME_DOMAIN=$ACME_ENV_DOMAIN
        ACME_EMAIL=$ACME_ENV_EMAIL
        ACME_SERVER=${ACME_ENV_SERVER:-https://acme-v02.api.letsencrypt.org/directory}
    fi
}
read_acme_settings
if [ "$TLS_MODE" = "https" ] && [ "$ACME_WEBROOT_OK" = 0 ]; then
    echo "[entrypoint] error: could not create the ACME challenge directory $ACME_WEBROOT; ACME is off."
elif [ "$TLS_MODE" = "https" ]; then
    (
        ACME_CONFIG=/certs/letsencrypt
        ACME_WORK=/tmp/letsencrypt-work
        ACME_DEPLOY_HOOK='cp "$RENEWED_LINEAGE/fullchain.pem" /certs/server.crt && cp "$RENEWED_LINEAGE/privkey.pem" /certs/server.key && chmod 644 /certs/server.crt && chmod 600 /certs/server.key && touch /certs/.reload'
        LAST_DOMAIN=
        LAST_EMAIL=
        LAST_SERVER=
        LAST_CA_CHECKSUM=
        FIRST_CHECK=1
        NEXT_RUN=0
        while true; do
            read_acme_settings
            if ! has_non_space "$ACME_DOMAIN"; then
                if ! rm -f "$ACME_STATUS_FILE"; then
                    echo "[entrypoint] error: could not clear the ACME attempt status."
                fi
            fi
            CA_CHECKSUM=none
            if [ -f /certs/acme-ca-bundle.crt ]; then
                if ! CA_CHECKSUM=$(cksum < /certs/acme-ca-bundle.crt); then
                    echo "[entrypoint] error: cannot read the ACME CA bundle; ACME check deferred."
                    sleep 5
                    continue
                fi
            fi
            if [ $FIRST_CHECK -eq 1 ] || [ "$ACME_DOMAIN" != "$LAST_DOMAIN" ] || [ "$ACME_EMAIL" != "$LAST_EMAIL" ] || [ "$ACME_SERVER" != "$LAST_SERVER" ] || [ "$CA_CHECKSUM" != "$LAST_CA_CHECKSUM" ]; then
                PREVIOUS_DOMAIN="$LAST_DOMAIN"
                LAST_DOMAIN="$ACME_DOMAIN"
                LAST_EMAIL="$ACME_EMAIL"
                LAST_SERVER="$ACME_SERVER"
                LAST_CA_CHECKSUM="$CA_CHECKSUM"
                FIRST_CHECK=0
                NEXT_RUN=0
                if ! has_non_space "$ACME_DOMAIN"; then
                    # Most installs never set ACME up: say nothing unless it was on.
                    if has_non_space "$PREVIOUS_DOMAIN"; then
                        echo "[entrypoint] ACME turned off; the current certificate stays in place."
                    fi
                else
                    echo "[entrypoint] ACME enabled for $ACME_DOMAIN via $ACME_SERVER."
                    if [ -z "$ACME_EMAIL" ]; then
                        echo "[entrypoint] warning: ACME is configured without an email; account or expiry notices may not be received."
                    fi
                fi
            fi

            if has_non_space "$ACME_DOMAIN"; then
                NOW=$(date +%s)
                if [ "$NEXT_RUN" -eq 0 ] || [ "$NOW" -ge "$NEXT_RUN" ]; then
                    ATTEMPT_DOMAIN=$ACME_DOMAIN
                    ATTEMPT_TIME=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
                    ATTEMPT_OUTPUT="/tmp/acme-attempt-$$.log"
                    if ! ATTEMPT_LOG_DIR=$(mktemp -d /tmp/acme-certbot-XXXXXX); then
                        echo "[entrypoint] error: could not create the Certbot log directory; ACME check deferred."
                        sleep 5
                        continue
                    fi
                    if ! chown "$BACKEND_UID:$BACKEND_GID" "$ATTEMPT_LOG_DIR"; then
                        echo "[entrypoint] error: could not hand the Certbot log directory to the backend user; ACME check deferred."
                        rmdir "$ATTEMPT_LOG_DIR" || echo "[entrypoint] error: could not remove the Certbot log directory."
                        sleep 5
                        continue
                    fi
                    if [ -f /certs/acme-ca-bundle.crt ]; then
                        export REQUESTS_CA_BUNDLE=/certs/acme-ca-bundle.crt
                    else
                        unset REQUESTS_CA_BUNDLE
                    fi
                    if [ -f "$ACME_CONFIG/live/$ACME_DOMAIN/fullchain.pem" ]; then
                        ATTEMPT_ACTION=renew
                        if su-exec "$BACKEND_UID:$BACKEND_GID" certbot \
                            --config-dir "$ACME_CONFIG" --work-dir "$ACME_WORK" --logs-dir "$ATTEMPT_LOG_DIR" --max-log-backups 1 \
                            --server "$ACME_SERVER" renew --cert-name "$ACME_DOMAIN" --deploy-hook "$ACME_DEPLOY_HOOK" > "$ATTEMPT_OUTPUT" 2>&1; then
                            CERTBOT_RET=0
                        else
                            CERTBOT_RET=$?
                        fi
                        test "$CERTBOT_RET" -eq 0 || echo "[entrypoint] ACME renewal failed; it will be retried."
                    else
                        ATTEMPT_ACTION=issue
                        if [ -n "$ACME_EMAIL" ]; then
                            set -- --email "$ACME_EMAIL"
                        else
                            set -- --register-unsafely-without-email
                        fi
                        if su-exec "$BACKEND_UID:$BACKEND_GID" certbot \
                            --config-dir "$ACME_CONFIG" --work-dir "$ACME_WORK" --logs-dir "$ATTEMPT_LOG_DIR" --max-log-backups 1 \
                            --server "$ACME_SERVER" certonly --webroot -w "$ACME_WEBROOT" --non-interactive --agree-tos \
                            "$@" --cert-name "$ACME_DOMAIN" -d "$ACME_DOMAIN" \
                            --deploy-hook "$ACME_DEPLOY_HOOK" > "$ATTEMPT_OUTPUT" 2>&1; then
                            CERTBOT_RET=0
                        else
                            CERTBOT_RET=$?
                        fi
                        test $CERTBOT_RET -eq 0 || echo "[entrypoint] ACME certificate request failed; it will be retried."
                    fi
                    if ! cat "$ATTEMPT_OUTPUT"; then
                        echo "[entrypoint] error: could not read Certbot output."
                    fi
                    read_acme_settings
                    if has_non_space "$ACME_DOMAIN"; then
                        STATUS_TMP="${ACME_STATUS_FILE}.$$.tmp"
                        if { printf '%s\n%s\n%s\n%s\n' "$ATTEMPT_TIME" "$ATTEMPT_ACTION" "$CERTBOT_RET" "$ATTEMPT_DOMAIN" &&
                             printf '%s\n' 'Certbot command output (last 64 KiB):' &&
                             tail -c 65536 "$ATTEMPT_OUTPUT" &&
                             printf '\n\n%s\n' 'Certbot detailed log (last 64 KiB):' &&
                             if [ -f "$ATTEMPT_LOG_DIR/letsencrypt.log" ]; then
                                 tail -c 65536 "$ATTEMPT_LOG_DIR/letsencrypt.log"
                             else
                                 printf '%s\n' 'No Certbot log was produced for this attempt.'
                             fi; } > "$STATUS_TMP" &&
                           chmod 600 "$STATUS_TMP" &&
                           chown "$BACKEND_UID:$BACKEND_GID" "$STATUS_TMP" &&
                           mv -f "$STATUS_TMP" "$ACME_STATUS_FILE"; then
                            :
                        else
                            echo "[entrypoint] error: could not save the ACME attempt status."
                            rm -f "$STATUS_TMP"
                        fi
                    else
                        if ! rm -f "$ACME_STATUS_FILE"; then
                            echo "[entrypoint] error: could not clear the ACME attempt status."
                        fi
                    fi
                    rm -f "$ATTEMPT_OUTPUT"
                    if ! rm -f "$ATTEMPT_LOG_DIR/letsencrypt.log" "$ATTEMPT_LOG_DIR/letsencrypt.log.1" ||
                       ! rmdir "$ATTEMPT_LOG_DIR"; then
                        echo "[entrypoint] error: could not remove the Certbot attempt logs in $ATTEMPT_LOG_DIR."
                    fi
                    NOW=$(date +%s)
                    if [ $CERTBOT_RET -eq 0 ]; then
                        NEXT_RUN=$((NOW + 43200))
                    else
                        NEXT_RUN=$((NOW + 3600))
                    fi
                fi
            fi
            sleep 5
        done
    ) &
else
    if ! rm -f "$ACME_STATUS_FILE"; then
        echo "[entrypoint] error: could not clear the ACME attempt status."
    fi
    if [ -n "$ACME_DOMAIN" ] || [ -n "$ACME_EMAIL" ]; then
        echo "[entrypoint] warning: ACME requires a domain and TLS_MODE=https; ACME is disabled."
    fi
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
