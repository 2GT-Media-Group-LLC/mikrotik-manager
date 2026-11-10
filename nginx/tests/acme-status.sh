#!/bin/sh
# Run in an isolated nginx image with the repository mounted at /source.
set -eu

mkdir -p /certs /tmp/acme-test-bin
: > /certs/server.crt
: > /certs/server.key
cat > /tmp/acme-test-bin/nginx <<'EOF'
#!/bin/sh
while :; do sleep 60; done
EOF
cat > /tmp/acme-test-bin/su-exec <<'EOF'
#!/bin/sh
mode=$(cat /tmp/acme-test-mode)
if [ "$mode" = real ]; then
    exec /sbin/su-exec "$@"
fi
log_dir=
while [ "$#" -gt 0 ]; do
    if [ "$1" = --logs-dir ]; then
        log_dir=$2
        break
    fi
    shift
done
test -n "$log_dir" || exit 98
case "$mode" in
    fail) echo 'failure detail unique to failed attempt' > "$log_dir/letsencrypt.log"; echo 'test request failure'; exit 2 ;;
    renew)
        head -c 70000 /dev/zero | tr '\000' y > "$log_dir/letsencrypt.log"
        echo 'renewal detailed log end' >> "$log_dir/letsencrypt.log"
        head -c 70000 /dev/zero | tr '\000' x; echo 'renewal output end'; exit 0 ;;
    missing) echo 'failed before log setup'; exit 2 ;;
    slow) touch /tmp/acme-test-started; sleep 3; echo 'completed after disable'; exit 0 ;;
    *) exit 99 ;;
esac
EOF
chmod +x /tmp/acme-test-bin/nginx /tmp/acme-test-bin/su-exec
export PATH="/tmp/acme-test-bin:$PATH"

wait_for() {
    count=0
    until "$@"; do
        count=$((count + 1))
        if [ "$count" -ge 25 ]; then
            echo "Timed out waiting for $*" >&2
            cat /tmp/acme-test-entrypoint.log >&2
            exit 1
        fi
        sleep 1
    done
}

if [ "${1:-}" = proxy ]; then
    echo stale > /certs/acme-last-attempt
    TLS_MODE=proxy sh /source/nginx/entrypoint.sh > /tmp/acme-test-entrypoint.log 2>&1 &
    wait_for test ! -e /certs/acme-last-attempt
    echo 'Proxy mode clears the saved attempt.'
    exit 0
fi

cat > /certs/acme-settings.conf <<'EOF'
ACME_DOMAIN=manager.example.com
ACME_EMAIL=
ACME_SERVER=https://ca.example.com/directory
EOF
echo fail > /tmp/acme-test-mode
if [ "${1:-}" = real ]; then
    echo real > /tmp/acme-test-mode
    sed -i 's|^ACME_SERVER=.*|ACME_SERVER=https://127.0.0.1:1/directory|' /certs/acme-settings.conf
fi
sh /source/nginx/entrypoint.sh > /tmp/acme-test-entrypoint.log 2>&1 &
wait_for test -f /certs/acme-last-attempt
if [ "${1:-}" = real ]; then
    grep -q 'Certbot detailed log (last 64 KiB):' /certs/acme-last-attempt
    grep -q 'certbot._internal' /certs/acme-last-attempt
    grep -q 'ConnectionError' /certs/acme-last-attempt
    echo 'Real Certbot detailed log was saved for an offline failure.'
    exit 0
fi
test "$(sed -n '2p' /certs/acme-last-attempt)" = issue
test "$(sed -n '3p' /certs/acme-last-attempt)" = 2
grep -q 'test request failure' /certs/acme-last-attempt
grep -q 'failure detail unique to failed attempt' /certs/acme-last-attempt
test "$(stat -c '%u:%g %a' /certs/acme-last-attempt)" = '100:101 600'

mkdir -p /certs/letsencrypt/live/manager.example.com
: > /certs/letsencrypt/live/manager.example.com/fullchain.pem
echo renew > /tmp/acme-test-mode
sed -i 's/^ACME_EMAIL=.*/ACME_EMAIL=test@example.com/' /certs/acme-settings.conf
wait_for grep -q 'renewal output end' /certs/acme-last-attempt
test "$(sed -n '2p' /certs/acme-last-attempt)" = renew
test "$(sed -n '3p' /certs/acme-last-attempt)" = 0
grep -q 'renewal detailed log end' /certs/acme-last-attempt
if grep -q 'failure detail unique to failed attempt' /certs/acme-last-attempt; then
    echo 'Previous attempt log leaked into the latest attempt.' >&2
    exit 1
fi
test "$(sed -n '6p' /certs/acme-last-attempt | wc -c)" -eq 65536
test "$(sed -n '10p' /certs/acme-last-attempt | wc -c)" -eq 65536

echo fail > /tmp/acme-test-mode
sed -i 's/^ACME_EMAIL=.*/ACME_EMAIL=failed@example.com/' /certs/acme-settings.conf
wait_for grep -q 'test request failure' /certs/acme-last-attempt
test "$(sed -n '2p' /certs/acme-last-attempt)" = renew
test "$(sed -n '3p' /certs/acme-last-attempt)" = 2

echo missing > /tmp/acme-test-mode
sed -i 's/^ACME_EMAIL=.*/ACME_EMAIL=missing@example.com/' /certs/acme-settings.conf
wait_for grep -q 'No Certbot log was produced for this attempt.' /certs/acme-last-attempt
if grep -q 'failure detail unique to failed attempt' /certs/acme-last-attempt; then
    echo 'Missing log reused the previous attempt log.' >&2
    exit 1
fi

echo slow > /tmp/acme-test-mode
sed -i 's/^ACME_EMAIL=.*/ACME_EMAIL=other@example.com/' /certs/acme-settings.conf
wait_for test -f /tmp/acme-test-started
rm /certs/acme-settings.conf
wait_for test ! -e /certs/acme-last-attempt
sleep 6
test ! -e /certs/acme-last-attempt
echo 'Attempt log isolation, bounded output, missing logs, and disable-during-attempt checks passed.'
