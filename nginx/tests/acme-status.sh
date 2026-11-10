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
case "$mode" in
    fail) echo 'test request failure'; exit 2 ;;
    renew) head -c 70000 /dev/zero | tr '\000' x; echo 'renewal output end'; exit 0 ;;
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
sh /source/nginx/entrypoint.sh > /tmp/acme-test-entrypoint.log 2>&1 &
wait_for test -f /certs/acme-last-attempt
test "$(sed -n '2p' /certs/acme-last-attempt)" = issue
test "$(sed -n '3p' /certs/acme-last-attempt)" = 2
grep -q 'test request failure' /certs/acme-last-attempt
test "$(stat -c '%u:%g %a' /certs/acme-last-attempt)" = '100:101 600'

mkdir -p /certs/letsencrypt/live/manager.example.com
: > /certs/letsencrypt/live/manager.example.com/fullchain.pem
echo renew > /tmp/acme-test-mode
sed -i 's/^ACME_EMAIL=.*/ACME_EMAIL=test@example.com/' /certs/acme-settings.conf
wait_for grep -q 'renewal output end' /certs/acme-last-attempt
test "$(sed -n '2p' /certs/acme-last-attempt)" = renew
test "$(sed -n '3p' /certs/acme-last-attempt)" = 0
test "$(tail -n +5 /certs/acme-last-attempt | wc -c)" -eq 65536

echo fail > /tmp/acme-test-mode
sed -i 's/^ACME_EMAIL=.*/ACME_EMAIL=failed@example.com/' /certs/acme-settings.conf
wait_for grep -q 'test request failure' /certs/acme-last-attempt
test "$(sed -n '2p' /certs/acme-last-attempt)" = renew
test "$(sed -n '3p' /certs/acme-last-attempt)" = 2

echo slow > /tmp/acme-test-mode
sed -i 's/^ACME_EMAIL=.*/ACME_EMAIL=other@example.com/' /certs/acme-settings.conf
wait_for test -f /tmp/acme-test-started
rm /certs/acme-settings.conf
wait_for test ! -e /certs/acme-last-attempt
sleep 6
test ! -e /certs/acme-last-attempt
echo 'Issue and renewal failures, bounded renewal output, and disable-during-attempt checks passed.'
