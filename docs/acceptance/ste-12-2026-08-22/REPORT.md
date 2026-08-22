# STE-12 production acceptance — 2026-08-22

## Result

**PASS** on a real disposable Hetzner x86 VM. The authoritative second run completed with:

- `BROWSER SANDBOX KERNEL PHASE: PASS`
- `WORKER CRASH/LEASE/FENCING VM ACCEPTANCE: PASS`
- `BROWSER_SANDBOX_VM_ACCEPTANCE_RECORDED`
- `BROWSER SANDBOX FULL VM ACCEPTANCE: PASS`

The first VM run was treated as non-authoritative after review found that its UDP/443 fixture was not actively probed and readiness-before-claim was not temporally proven. Both gaps were fixed without relaxing policy, the immutable bundle was rebuilt, and the complete two-boot suite was rerun from clean state. Only the second run supports this PASS.

The final runtime attestation is root-owned and bound to boot, config, immutable bundle, platform and namespace. Rendered production audits remain disabled in the checked-in deployment; acceptance does not enable the feature by itself.

## Tested source and platform

- Requested source commit: `bcb51cf4e32712bcc9639cf618ac06ac392a03e0`
- Branch: `ste-12-browser-network-sandbox`
- Base `main` and `origin/main`: `f7d24ec95c88d1bc728952efc9c3f0f7d2ffb2ee`
- OS: Ubuntu 26.04 LTS, x86_64
- Kernel: `7.0.0-29-generic`
- systemd: `259.5` (`259.5-0ubuntu3.3`)
- Node.js: `24.14.0`
- pnpm: `11.9.0`
- nftables: `1.1.6`
- iproute2: `6.19.0`
- Chromium: Chrome for Testing `149.0.7827.55`, Playwright revision `1228`
- Chromium SHA-256: `2d18db9d8608b052b6a552ee00ec1e830f93692e928b65ecc67d693bd33fe801`

Final security bindings:

- config: `9ebdcff7388adf7452ef37baf769a0a314fdeb9a62fa2eabc4e3fad9d6e42ca9`
- immutable bundle: `3dc9b6c760f4a0f3643b10dff95963f4d73e617b465a596e9de12885c77344ba`
- platform: `c45881a38ba46c29d9f670bc7842954a20b3dcb0facc1424fd81dc109524bc41`
- before-reboot boot ID: `ad96bebf-184c-4849-b731-2ee941fd515d`
- accepted boot ID: `c76106ff-b79c-477d-a472-d086715c06c3`
- accepted namespace inode: `4026532439`

## Mandatory gates

| Gate | Result | Evidence |
|---|---:|---|
| Exact installed systemd bytes, `systemd-analyze verify`, no NOQORI drop-ins | PASS | installed units/hashes, repository verifier and drop-in inventory |
| Network namespace and nftables default-deny | PASS | host/namespace rulesets, addresses and routes |
| Public IPv4 HTTP and trusted HTTPS | PASS | authoritative log and kernel result |
| IPv6 fail-closed | PASS | kernel result and namespace sysctls |
| QUIC / real UDP 443 probe fail-closed | PASS | kernel `EPERM`, independent HTTPS recorder assertion and `quic-udp-443` result |
| Loopback, RFC1918, CGNAT, link-local, metadata, reserved and encoded targets | PASS | kernel result and diagnostic trace |
| Private redirect | PASS | kernel result; private recorder remained untouched |
| Private subresource | PASS | kernel result; private recorder remained untouched |
| Private WebSocket | PASS | kernel result; private recorder remained untouched |
| DNS rebinding | PASS | DNS pcap shows public A then `198.19.0.1`; private recorder remained untouched |
| Mixed public A/private AAAA | PASS | DNS pcap/text, kernel result and private recorder |
| No direct fallback without runner/sandbox | PASS | kernel result |
| Policy corruption fails closed and owned state restores | PASS | kernel result and authoritative log |
| Worker readiness before claim | PASS | `readyAt=15:21:32.443Z`, `enqueuedAt=15:21:32.452Z`; journal event precedes claim |
| Chromium pipe/process tree; no TCP DevTools or inherited RPC descriptor | PASS | kernel result, process tree and diagnostic trace |
| Runner capability and socket isolation | PASS | kernel result and unit properties |
| Runner cgroup measurement | PASS | peak `632,528,896` bytes under `MemoryMax=2,147,483,648`; `TasksMax=512` |
| Client disconnect, timeout, SIGINT and SIGTERM cleanup | PASS | kernel result |
| Worker crash/restart, lease retry and fencing | PASS | attempt 2, replacement PID and exactly one persisted audit |
| Exactly one worker | PASS | `workerProcessCount=1` and cgroup evidence |
| Sandbox persistence across reboot | PASS | distinct before/after boot IDs |
| API independence | PASS | kernel result and journal |
| Two-stage root-owned acceptance attestation | PASS | kernel, queue, acceptance and runtime attestation JSON |

The authoritative queue job `c6c3dfaf-b212-48d1-89d2-845d4be3135f` completed on attempt 2, produced audit `dd3ce7e1-84ce-4ec0-ae63-8172a16c7ae0`, and maps to exactly one persisted audit.

## Defects found and fixed

Production acceptance and the subsequent Standards/Spec review found and corrected defects without weakening security requirements:

- production preflight/platform detection invoked the wrong systemd command;
- immutable pnpm closure, installed units, Chromium and platform identity were not completely bound;
- systemd hardening conflicted with `/run/netns`, credential modes, AF_NETLINK and required runtime paths;
- host ARP/gateway policy and AppArmor requirements were incomplete;
- RPC half-close/disconnect and Chromium abort paths could leave active work or a late rejection;
- cold readiness budgets, bounded probes and a `/proc/<pid>/stat` TOCTOU made acceptance unreliable;
- restored policy evidence was compared to a stale namespace inode;
- worker startup exposed health before proving database and isolated-executor readiness, and the queue harness enqueued before proving ready;
- the acceptance checklist claimed QUIC/UDP 443 without an actual datagram attempt and external recorder assertion;
- an OUTPUT-chain `EPERM` from the new UDP probe was initially treated as a harness failure instead of a valid kernel-level fail-closed outcome; the external recorder remains mandatory in either safe outcome;
- the public crash fixture delayed every retry instead of only the first `/slow-html` request.

The small duplicated runtime-artifact path list identified by Standards review was also consolidated. No broad platform-identity refactor was mixed into the acceptance fix.

## Local verification

- Frozen lockfile install: PASS
- Unit tests: **260 passed, 0 failed**
- Playwright E2E: **38 passed**
- JavaScript and shell syntax checks: PASS
- `git diff --check`: PASS
- Evidence/token/private-key secret-pattern scan: PASS

The standard local test command required permission to bind loopback test servers; inside the restricted macOS command sandbox it correctly failed with `listen EPERM`. The recorded successful run is the unchanged `pnpm test:all` executed with loopback access.

## Hetzner resources and cost

Two disposable runs were created with `purpose=ste12-acceptance` because the first PASS was revoked after review. Across both runs the following were created and deleted:

- 6 × Ubuntu 26.04 x86 `cx23` servers: two sets of acceptance, public fixture and DNS fixture;
- 6 × minimum-scope firewalls;
- 2 × temporary SSH keys.

No volumes, load balancers, backups, domains, Primary IPs, Floating IPs, private networks, placement groups or Hetzner certificates were created. The authoritative fixture used a trusted seven-day Let's Encrypt certificate for its bare IP; no domain was used. Public TCP/80 was opened only during ACME validation and immediately restored to acceptance-VM-only access.

Each server's listed gross monthly price was €6.5331, below the €15/server requirement. Conservative rounded-up runtime estimates were €0.1466 for the superseded run and €0.0314 for the authoritative run, cumulative **€0.1780**, below the €15 authorization.

All six servers, six firewalls and both cloud SSH keys were removed. Both cleanup records report zero remaining labeled resources across servers, firewalls, SSH keys, volumes, load balancers, Primary/Floating IPs, networks, placement groups and certificates. Both local private keys were securely removed with `rm -P` and verified absent.

## Evidence layout

- `ste12-evidence-final/`: authoritative root-owned VM JSON, exact units, nftables, AppArmor, process/cgroup, journal, version and queue evidence
- `external-fixtures/`: port-53-only DNS pcap/decoded trace, fixture implementations, units and public certificate metadata
- `cloud-resources-before-cleanup.json` / `cloud-resources-after-cleanup.json`: authoritative redacted resource/cost snapshot and zero-resource verification
- `cloud-resources-initial-run-*.json`: superseded-run resource and cleanup evidence
- `local-test-all.log`: final complete local unit and Playwright output

The authoritative VM tarball was copied before deletion and verified locally as SHA-256 `5e7979637c6e813fc74d1bb51f6fe8cae00ef722f6055c1adc25dbd7936bb89d`. Its relative internal manifest verifies all 44 files. `SHA256SUMS` covers the committed acceptance directory. Operator CIDR and non-DNS packet data were removed from committed evidence; no token, private key, password or authorization header is present.
