# NOQORI production browser network sandbox

## Security boundary

Production audit jobs are split across two trust zones. `noqori-worker.service` owns SQLite, leases, retries, fencing, and completion but never imports the audit engine or resolves/connects to a target. It calls `noqori-audit-runner.service` over the versioned, bounded `/run/noqori-audit.sock` Unix RPC. The runner has no application environment file, database access, credentials, or home access. It alone performs HTML, Playwright, Lighthouse, and Chromium network activity inside `/run/netns/noqori-audit`.

Application URL validation remains defense in depth. The enforcement boundary is nftables in the audit namespace plus host `netdev` ingress and scoped forward chains for the audit veth: default deny for audit traffic, fixed-resolver DNS on TCP/UDP 53, public IPv4 TCP 80/443, and established replies only. IPv6 has no route and is disabled; UDP 443/QUIC is denied and Chromium is launched with `--disable-quic`. Private, loopback, link-local, CGNAT, metadata, multicast, reserved, host-local, gateway, and VM-public destinations are denied before public HTTP/HTTPS. There is no proxy or DIRECT fallback.

| Process | Library/path | Protocol | DNS owner | Destination boundary |
| --- | --- | --- | --- | --- |
| API | enqueue-time URL normalization and safety validation | DNS plus SQLite/loopback HTTP | Node resolver on the host | DNS validation only; no target HTTP connection |
| queue worker | bounded RPC client | pathname Unix socket | none for target | `/run/noqori-audit.sock` only |
| runner HTML audit | Node `fetch`, manual redirects | DNS, TCP HTTP/HTTPS | runner libc/Node through namespace resolver file | namespace + host nftables |
| runner browser audit | Playwright, Lighthouse, Chrome | DNS, TCP HTTP/HTTPS, WebSocket over TCP | Chromium through the same resolver file | every actual connection crosses both nftables boundaries |
| runner control | Chrome DevTools | inherited anonymous pipes | none | no network listener |

Service workers are disabled in the page before application code, and Puppeteer request interception adds URL-level checks for HTTP(S) document/subresource requests. Redirects are fetched manually by the HTML scanner and revalidated. Puppeteer does not expose a trustworthy pre-connect WebSocket routing hook in this integration, so WebSocket destination safety is enforced by the kernel boundary, not claimed as application-level interception. Chromium redirects, subresources, XHR/fetch, fonts, and WebSockets remain subject to the kernel destination policy even if DNS answers change between checks and connect.

Chrome DevTools uses inherited anonymous pipes, not a TCP endpoint. The namespace has no loopback allow rule and VM acceptance inspects Chromium descriptors and listening sockets. Root compromise is outside the attestation threat model.

## Fixed production baseline

- Ubuntu 26.04 LTS x86_64 and its shipped kernel
- systemd 259 or newer (`NetworkNamespacePath=` is mandatory)
- nftables and iproute2
- Node.js 24 at `/usr/bin/node`
- Playwright 1.61.1 and its pinned Chromium build

There is no silent Ubuntu 24.04 fallback. If Hetzner does not offer or support the fixed Ubuntu 26.04 image, provisioning is blocked pending an explicit architecture decision.

## Provisioning contract

Create the service users without login shells. The worker receives the dedicated `noqori-audit-rpc` group only inside its systemd unit. The API process and `noqori-browser` are not members and cannot open the socket.

```bash
sudo useradd --system --home /var/lib/noqori --shell /usr/sbin/nologin noqori
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin noqori-browser
sudo groupadd --system noqori-audit-rpc
sudo install -d -o root -g noqori -m 0750 /etc/noqori
sudo install -d -o root -g root -m 0755 /etc/netns
sudo install -o root -g root -m 0440 deploy/network/noqori-audit-network.json.example /etc/noqori/audit-network.json
```

Install dependencies before activating a release, then make the complete application release tree root-owned and non-writable by service accounts. API and worker use that release. The runner and privileged sandbox setup/verification use the separate immutable copy described below.

```bash
sudo chown -R root:root /opt/noqori/releases/RELEASE_ID
sudo chmod -R go-w /opt/noqori/releases/RELEASE_ID
sudo chown -R root:root /opt/noqori/shared/ms-playwright
sudo chmod -R go-w /opt/noqori/shared/ms-playwright
```

The two privileged sandbox units never execute JavaScript from the mutable/current application release. Provision a separate root-owned, symlink-free copy of the security implementation and its dependency closure. `cp -aL` is intentional: it dereferences pnpm links into the immutable copy. Perform this while the sandbox units are stopped and publish the completed directory atomically with the provisioning tool; never edit it in place.

```bash
sudo install -d -o root -g root -m 0755 /usr/local/lib/noqori-browser-sandbox.new
sudo cp -aL deploy scripts src test node_modules package.json pnpm-lock.yaml /usr/local/lib/noqori-browser-sandbox.new/
sudo chown -R root:root /usr/local/lib/noqori-browser-sandbox.new
sudo chmod -R go-w /usr/local/lib/noqori-browser-sandbox.new
# Provisioning must atomically replace /usr/local/lib/noqori-browser-sandbox
# only after stopping noqori-audit-sandbox.service.
```

The sandbox setup, verifier, and unprivileged runner all execute the same immutable copy. The units reject any symlink, non-root-owned entry, or group/world-writable entry in it before Node starts. Acceptance is bound to a deterministic hash of the complete copied source, scripts, Linux tests, package manifests, and dependency tree. Installed unit bytes must exactly match the attested bundle and unapproved systemd drop-ins are rejected. This keeps root imports out of `/opt/noqori/current` and prevents the attested policy/runner code from drifting apart; API and queue worker continue to use the normal release. A protocol mismatch between worker and runner fails closed during the version handshake.

Before starting the target, replace every network placeholder with the VM public interface, public IPv4, and two explicit public IPv4 resolvers. Do not add search domains. Configure `net.ipv4.ip_forward=1` during host provisioning; sandbox startup checks it but does not silently mutate that global host setting. The deployment config is root-owned, not application `.env`, and contains no resolver credentials.

Install all units including the socket, then verify syntax on the Linux VM:

```bash
sudo cp deploy/systemd/noqori* /etc/systemd/system/
sudo systemctl daemon-reload
pnpm verify:systemd
sudo systemctl enable --now noqori.target
```

`noqori-audit-sandbox.service` idempotently creates only `noqori-audit`, `nq-audit-host`, `nq-audit-net`, and the uniquely named NOQORI nft tables. It never flushes the ruleset or edits unrelated chains. Its teardown deletes only those owned resources. A failed setup removes its partial owned resources, does not start the runner, and leaves the API independent.

The privileged setup unit intentionally does not use systemd filesystem namespacing directives: `ip netns add` must publish the named namespace mount into the host `/run/netns` so `NetworkNamespacePath=` can consume it after the oneshot exits. The unit still executes only the immutable, root-owned attested bundle with a narrow capability set. The verifier and unprivileged runner retain strict filesystem hardening. Setup is ordered after `network-online.target`; the two-boot VM gate must prove the namespace remains host-visible after cold boot.

The checked-in IPv4 deny data is a deterministic snapshot of the [IANA IPv4 Special-Purpose Address Registry](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml), last updated 2025-10-09, plus multicast coverage. Production startup never downloads registry data. Updating that snapshot or any hashed enforcement file invalidates prior VM acceptance.

The root verifier checks the namespace inode, routes/veth, host and namespace tables, default-drop chains, NAT, fixed resolver file, IPv6 sysctl, socket mode, and the boot-bound policy hash before each runner activation. Acceptance is also bound to a measured platform fingerprint covering the OS release, kernel, systemd, nftables, iproute2, Node, and the root-owned installed Chromium executable path/revision and SHA-256. Chromium is never executed as root to obtain this measurement. Any platform change clears VM acceptance until the two-boot suite is rerun. The root-owned attestation and expected hash contain no secrets. Missing, stale, writable, wrong-boot, wrong-inode, platform-mismatched, or configuration-mismatched files prevent the production worker from starting. An environment variable alone cannot enable rendered mode.

## Lifecycle and resource containment

The runner is socket activated, serves one request, and uses fresh Chrome profiles. RPC disconnect, request timeout, or runner SIGTERM aborts the audit; Playwright closes and Chrome is killed. `KillMode=control-group` and `TimeoutStopSec=65s` provide the final process-tree boundary. The worker does not claim while the runner handshake is unavailable. If the runner fails after claim, the typed infrastructure error follows the existing retry/lease/fencing policy, and a stale result cannot complete a newer attempt.

`MemoryMax=2G`, `CPUQuota=200%`, and `TasksMax=512` are provisional HTML-only/acceptance values. Re-measure the entire runner cgroup during VM acceptance before allowing rendered Chromium traffic. Do not add `CAP_NET_ADMIN` to the runner. `AF_INET6` and `AF_PACKET` remain unavailable; `AF_NETLINK` is not allowlisted by `RestrictAddressFamilies` and must be tested against the pinned Chromium build before any policy relaxation.

## Tests and release gate

Portable tests validate RPC bounds/schema/cancellation, production routing, attestation, systemd contracts, deterministic IANA data, resolver placeholders, QUIC/IPv6 settings, and descriptor/environment isolation. They do not claim kernel enforcement.

Run full acceptance as a two-boot procedure on a disposable Ubuntu 26.04 VM. First record the root-owned pre-reboot state, then reboot:

```bash
cd /usr/local/lib/noqori-browser-sandbox
sudo /usr/bin/node scripts/run-browser-sandbox-vm-acceptance.mjs prepare-reboot
sudo reboot
```

After reboot, provide purpose-built public/private fixture URLs and complete the suite. `NOQORI_SLOW_RENDERED_URL` must keep Chromium active long enough for descriptor inspection; `NOQORI_SLOW_HTML_URL` must keep the first HTML attempt active until the worker is killed.

```bash
cd /usr/local/lib/noqori-browser-sandbox
sudo --preserve-env=NOQORI_PUBLIC_HTTP_URL,NOQORI_PUBLIC_HTTPS_URL,NOQORI_PRIVATE_REDIRECT_URL,NOQORI_PRIVATE_SUBRESOURCE_URL,NOQORI_PRIVATE_WEBSOCKET_URL,NOQORI_DNS_REBIND_URL,NOQORI_MIXED_A_AAAA_URL,NOQORI_FIXTURE_ASSERT_BASE_URL,NOQORI_SLOW_RENDERED_URL,NOQORI_SLOW_HTML_URL \
  /usr/bin/node scripts/run-browser-sandbox-vm-acceptance.mjs complete
```

The kernel-only `pnpm test:sandbox:linux` command deliberately does not write VM acceptance. It writes root-owned kernel evidence only after real `systemd-analyze verify`, network, runner disconnect/client-timeout/SIGINT/SIGTERM cancellation, process-tree, identity, and cgroup-budget checks pass. The full command additionally proves reboot persistence and a real persisted queued job across a systemd worker crash/restart with attempt-two fencing, one worker process, and exactly one persisted audit. It must prove public HTTP/HTTPS; loopback, IPv6, RFC1918, CGNAT, link-local, metadata and reserved denial; private redirects/subresources/WebSockets; DNS rebinding and mixed A/private AAAA; no fallback when runner/sandbox is absent; failure after policy corruption; no runner nft/ip/setns/raw-socket capability; API independence; socket denial to API and browser identities; no inherited RPC descriptor or TCP DevTools listener; and runner cgroup resource limits. macOS reports Linux integration and systemd verification as `UNAVAILABLE`, never `PASS`.

Only after all VM checks pass may a root-controlled acceptance procedure atomically replace the attestation with `vmAcceptancePassed: true`; the checked-in deployment still leaves `RENDERED_AUDIT_ENABLED` unset/false. Enabling it is a separate reviewed deployment change.
