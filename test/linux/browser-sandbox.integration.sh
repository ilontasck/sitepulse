#!/bin/bash
set -euo pipefail

# Mandatory VM suite. It performs real kernel/network checks; no mocks are used.
# Fixture URLs are provisioned by the disposable VM acceptance environment.
: "${NOQORI_PUBLIC_HTTP_URL:?required}"
: "${NOQORI_PUBLIC_HTTPS_URL:?required}"
: "${NOQORI_PRIVATE_REDIRECT_URL:?required}"
: "${NOQORI_PRIVATE_SUBRESOURCE_URL:?required}"
: "${NOQORI_PRIVATE_WEBSOCKET_URL:?required}"
: "${NOQORI_DNS_REBIND_URL:?required}"
: "${NOQORI_MIXED_A_AAAA_URL:?required}"
: "${NOQORI_FIXTURE_ASSERT_BASE_URL:?required}"
: "${NOQORI_SLOW_RENDERED_URL:?required}"

ns=noqori-audit
runner_memory_peak_max=0
timeout_log=""
wait_for_runner_pid() {
  local pid
  for _ in $(seq 1 100); do
    pid="$(systemctl show noqori-audit-runner.service --property=MainPID --value)"
    if test "$pid" -gt 1 2>/dev/null; then
      printf '%s\n' "$pid"
      return 0
    fi
    sleep 0.1
  done
  return 1
}
record_runner_memory_peak() {
  local observed
  observed="$(systemctl show noqori-audit-runner.service --property=MemoryPeak --value)"
  case "$observed" in
    ''|*[!0-9]*) return 1 ;;
  esac
  test "$observed" -gt 0
  test "$observed" -le 2147483648
  if test "$observed" -gt "$runner_memory_peak_max"; then
    runner_memory_peak_max="$observed"
  fi
}
wait_for_runner_cgroup_cleanup() {
  local cgroup="$1"
  local main_pid="$2"
  local processes
  for _ in $(seq 1 100); do
    processes="$(cat "/sys/fs/cgroup${cgroup}/cgroup.procs" 2>/dev/null || true)"
    if test "$processes" = "$main_pid"; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}
units=(
  deploy/systemd/noqori.target
  deploy/systemd/noqori-audit-sandbox.service
  deploy/systemd/noqori-audit-sandbox-verify.service
  deploy/systemd/noqori-audit-runner.socket
  deploy/systemd/noqori-audit-runner.service
  deploy/systemd/noqori-api.service
  deploy/systemd/noqori-worker.service
  deploy/systemd/noqori-migrate.service
)
systemd-analyze verify "${units[@]}"
cleanup_acceptance_mode() {
  test -z "$timeout_log" || rm -f "$timeout_log"
  /usr/bin/node scripts/configure-browser-sandbox-acceptance-mode.mjs disable >/dev/null 2>&1 || true
  systemctl try-restart noqori-audit-runner.service >/dev/null 2>&1 || true
}
trap cleanup_acceptance_mode EXIT
/usr/bin/node scripts/configure-browser-sandbox-acceptance-mode.mjs enable >/dev/null
systemctl restart noqori-audit-runner.service
stat /run/netns/noqori-audit >/dev/null
ip netns list | awk '{print $1}' | grep -qx "$ns"
nft list table netdev noqori_audit_host >/dev/null
ip netns exec "$ns" nft list table inet noqori_audit_namespace >/dev/null

ip netns exec "$ns" curl --fail --max-time 15 "$NOQORI_PUBLIC_HTTP_URL" >/dev/null
ip netns exec "$ns" curl --fail --max-time 15 "$NOQORI_PUBLIC_HTTPS_URL" >/dev/null
/usr/bin/node scripts/run-isolated-audit.mjs "$NOQORI_PUBLIC_HTTPS_URL" --rendered >/dev/null

# During an active browser audit the socket-activation listener must not be
# present in Chromium, and CDP must not expose a TCP listener.
/usr/bin/node scripts/run-isolated-audit.mjs "$NOQORI_SLOW_RENDERED_URL" --rendered >/dev/null &
audit_client_pid=$!
runner_pid="$(wait_for_runner_pid)"
chrome_pid=""
for _ in $(seq 1 100); do
  chrome_pid="$(pgrep -P "$runner_pid" -f 'chrome|chromium' | head -n 1 || true)"
  test -n "$chrome_pid" && break
  sleep 0.1
done
test -n "$chrome_pid"
rpc_listener="$(readlink "/proc/$runner_pid/fd/3")"
for descriptor in /proc/${chrome_pid}/fd/*; do
  test "$(readlink "$descriptor" 2>/dev/null || true)" != "$rpc_listener"
done
test -z "$(ip netns exec "$ns" ss -ltnH)"
wait "$audit_client_pid"
record_runner_memory_peak

# runner-client-disconnect-cancellation: closing the only RPC client must abort
# the active audit and remove Chromium from the runner cgroup.
/usr/bin/node scripts/run-isolated-audit.mjs "$NOQORI_SLOW_RENDERED_URL" --rendered >/dev/null &
disconnect_client_pid=$!
runner_pid="$(wait_for_runner_pid)"
runner_cgroup="$(systemctl show noqori-audit-runner.service --property=ControlGroup --value)"
for _ in $(seq 1 100); do
  pgrep -P "$runner_pid" -f 'chrome|chromium' >/dev/null && break
  sleep 0.1
done
pgrep -P "$runner_pid" -f 'chrome|chromium' >/dev/null
record_runner_memory_peak
kill -TERM "$disconnect_client_pid"
! wait "$disconnect_client_pid"
for _ in $(seq 1 100); do
  ! pgrep -P "$runner_pid" -f 'chrome|chromium' >/dev/null && break
  sleep 0.1
done
wait_for_runner_cgroup_cleanup "$runner_cgroup" "$runner_pid"

# runner-client-timeout-cancellation: a bounded client timeout closes RPC and
# produces the same process-tree cancellation without a DIRECT/local fallback.
timeout_log="$(mktemp /run/noqori-audit/client-timeout.XXXXXX)"
/usr/bin/node scripts/run-isolated-audit.mjs "$NOQORI_SLOW_RENDERED_URL" --rendered --client-timeout-ms=1000 >/dev/null 2>"$timeout_log" &
timeout_client_pid=$!
runner_pid="$(wait_for_runner_pid)"
runner_cgroup="$(systemctl show noqori-audit-runner.service --property=ControlGroup --value)"
for _ in $(seq 1 100); do
  pgrep -P "$runner_pid" -f 'chrome|chromium' >/dev/null && break
  sleep 0.1
done
pgrep -P "$runner_pid" -f 'chrome|chromium' >/dev/null
record_runner_memory_peak
! wait "$timeout_client_pid"
grep -qx 'AUDIT_RUNNER_TIMEOUT' "$timeout_log"
wait_for_runner_cgroup_cleanup "$runner_cgroup" "$runner_pid"
record_runner_memory_peak

# runner-sigterm-cancellation: the runner owns SIGTERM/SIGINT handling and its
# entire active Chromium tree must disappear before the service is considered stopped.
/usr/bin/node scripts/run-isolated-audit.mjs "$NOQORI_SLOW_RENDERED_URL" --rendered >/dev/null &
sigterm_client_pid=$!
runner_pid="$(wait_for_runner_pid)"
runner_cgroup="$(systemctl show noqori-audit-runner.service --property=ControlGroup --value)"
for _ in $(seq 1 100); do
  pgrep -P "$runner_pid" -f 'chrome|chromium' >/dev/null && break
  sleep 0.1
done
pgrep -P "$runner_pid" -f 'chrome|chromium' >/dev/null
record_runner_memory_peak
systemctl kill --kill-whom=main --signal=SIGTERM noqori-audit-runner.service
! wait "$sigterm_client_pid"
for _ in $(seq 1 100); do
  test ! -s "/sys/fs/cgroup${runner_cgroup}/cgroup.procs" && break
  sleep 0.1
done
test ! -s "/sys/fs/cgroup${runner_cgroup}/cgroup.procs"

# runner-sigint-cancellation: chrome-launcher must not own SIGINT; the runner's
# graceful handler aborts the audit and systemd contains the remaining tree.
/usr/bin/node scripts/run-isolated-audit.mjs "$NOQORI_SLOW_RENDERED_URL" --rendered >/dev/null &
sigint_client_pid=$!
runner_pid="$(wait_for_runner_pid)"
runner_cgroup="$(systemctl show noqori-audit-runner.service --property=ControlGroup --value)"
for _ in $(seq 1 100); do
  pgrep -P "$runner_pid" -f 'chrome|chromium' >/dev/null && break
  sleep 0.1
done
pgrep -P "$runner_pid" -f 'chrome|chromium' >/dev/null
record_runner_memory_peak
systemctl kill --kill-whom=main --signal=SIGINT noqori-audit-runner.service
! wait "$sigint_client_pid"
for _ in $(seq 1 100); do
  test ! -s "/sys/fs/cgroup${runner_cgroup}/cgroup.procs" && break
  sleep 0.1
done
test ! -s "/sys/fs/cgroup${runner_cgroup}/cgroup.procs"

host_public="$(/usr/bin/node -p 'JSON.parse(require("fs").readFileSync("/etc/noqori/audit-network.json", "utf8")).hostPublicIpv4')"
blocked=(127.0.0.1 10.0.0.1 100.64.0.1 169.254.169.254 172.16.0.1 192.168.0.1 198.19.0.1 224.0.0.1 240.0.0.1 "$host_public")
for address in "${blocked[@]}"; do
  ! ip netns exec "$ns" curl --fail --connect-timeout 2 "http://$address/" >/dev/null 2>&1
done
! ip netns exec "$ns" curl -g --fail --connect-timeout 2 'http://[::1]/' >/dev/null 2>&1
for address in 2130706433 0x7f000001 017700000001 '[::ffff:127.0.0.1]' '[fc00::1]' '[fe80::1]' '[ff02::1]' '[::]'; do
  ! ip netns exec "$ns" curl -g --fail --connect-timeout 2 "http://$address/" >/dev/null 2>&1
done
! ip netns exec "$ns" curl --fail --max-time 8 -L "$NOQORI_PRIVATE_REDIRECT_URL" >/dev/null 2>&1

# Browser fixture endpoints record whether their private subresource/WebSocket/rebinding
# targets were reached and return failure unless the connection was kernel-blocked.
/usr/bin/node scripts/run-isolated-audit.mjs "$NOQORI_PRIVATE_SUBRESOURCE_URL" --rendered >/dev/null
record_runner_memory_peak
/usr/bin/node scripts/run-isolated-audit.mjs "$NOQORI_PRIVATE_WEBSOCKET_URL" --rendered >/dev/null
record_runner_memory_peak
/usr/bin/node scripts/run-isolated-audit.mjs "$NOQORI_DNS_REBIND_URL" --rendered >/dev/null
record_runner_memory_peak
/usr/bin/node scripts/run-isolated-audit.mjs "$NOQORI_MIXED_A_AAAA_URL" --rendered >/dev/null
record_runner_memory_peak
for scenario in private-subresource private-websocket dns-rebind mixed-a-private-aaaa; do
  curl --fail --max-time 10 "$NOQORI_FIXTURE_ASSERT_BASE_URL/$scenario/not-reached" >/dev/null
done

# Corrupting a mandatory policy prevents the next runner activation; restoring the
# root setup recreates only NOQORI-owned resources.
systemctl stop noqori-audit-runner.service
ip netns exec "$ns" nft delete table inet noqori_audit_namespace
! /usr/bin/node scripts/run-isolated-audit.mjs "$NOQORI_PUBLIC_HTTPS_URL" >/dev/null 2>&1
systemctl restart noqori-audit-sandbox.service
systemctl reset-failed noqori-audit-sandbox-verify.service noqori-audit-runner.service
systemctl stop noqori-audit-runner.service
nft delete table inet noqori_audit_forward
! /usr/bin/node scripts/run-isolated-audit.mjs "$NOQORI_PUBLIC_HTTPS_URL" >/dev/null 2>&1
systemctl restart noqori-audit-sandbox.service
systemctl reset-failed noqori-audit-sandbox-verify.service noqori-audit-runner.service

# A successful RPC activation after policy restoration is required before
# inspecting runner capabilities; MainPID must never be zero here.
/usr/bin/node scripts/run-isolated-audit.mjs "$NOQORI_PUBLIC_HTTPS_URL" >/dev/null
runner_pid="$(wait_for_runner_pid)"
test "$runner_pid" -gt 1

! ip netns exec "$ns" runuser -u noqori-browser -- nft list ruleset >/dev/null 2>&1
! ip netns exec "$ns" runuser -u noqori-browser -- unshare --net true >/dev/null 2>&1
! ip netns exec "$ns" runuser -u noqori-browser -- /bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/9' >/dev/null 2>&1
test -z "$(systemctl show noqori-audit-runner.service --property=CapabilityBoundingSet --value)"
test "$(systemctl show noqori-audit-runner.service --property=NoNewPrivileges --value)" = "yes"
grep -Eq '^CapEff:\s*0+$' "/proc/$runner_pid/status"
grep -Eq '^CapBnd:\s*0+$' "/proc/$runner_pid/status"
grep -Eq '^NoNewPrivs:\s*1$' "/proc/$runner_pid/status"

systemctl is-active --quiet noqori-api.service
systemctl is-active --quiet noqori-audit-sandbox.service
systemctl stop noqori-audit-runner.socket noqori-audit-runner.service noqori-audit-sandbox.service
! curl --fail --max-time 3 http://127.0.0.1:3001/readyz >/dev/null 2>&1
systemctl is-active --quiet noqori-api.service
systemctl start noqori-audit-sandbox.service
systemctl start noqori-audit-runner.socket
systemctl restart noqori-worker.service
systemctl is-active --quiet noqori-api.service
systemctl is-active --quiet noqori-worker.service
! runuser -u noqori-browser -- /usr/bin/node -e 'require("net").connect("/run/noqori-audit.sock").on("connect",()=>process.exit(1)).on("error",()=>process.exit(0))'
! runuser -u noqori -- /usr/bin/node -e 'require("net").connect("/run/noqori-audit.sock").on("connect",()=>process.exit(1)).on("error",()=>process.exit(0))'

# The production topology permits one queue worker only. Chromium belongs to
# the runner cgroup, never to the worker cgroup. Resource limits are measured,
# not inferred from unit text.
worker_pid="$(systemctl show noqori-worker.service --property=MainPID --value)"
worker_cgroup="$(systemctl show noqori-worker.service --property=ControlGroup --value)"
test "$worker_pid" -gt 1
test "$(wc -l < "/sys/fs/cgroup${worker_cgroup}/cgroup.procs")" -eq 1
test "$(systemctl show noqori-audit-runner.service --property=MemoryMax --value)" = "2147483648"
test "$(systemctl show noqori-audit-runner.service --property=TasksMax --value)" = "512"
test "$runner_memory_peak_max" -gt 0
printf '%s\n' "$runner_memory_peak_max" > /run/noqori-audit/kernel-memory-peak

echo "BROWSER SANDBOX KERNEL PHASE: PASS (VM acceptance is not recorded by this command)"
