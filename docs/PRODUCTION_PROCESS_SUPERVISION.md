# NOQORI production process supervision

## Decision

NOQORI uses systemd for the first production deployment on one Hetzner x86 VM. The repository already has independent Node.js entrypoints for the API and audit worker and a single durable SQLite queue. systemd supervises those processes directly, starts them after reboot, restarts either one without coupling its lifecycle to the other, owns their logs, and provides bounded cgroup shutdown without adding a second container orchestration layer.

This is intentionally one production model. Docker Compose is not configured in parallel. The worker service remains a clean seam for STE-12: its `ExecStart` can later point to an isolated browser runner or network namespace with a restricted egress proxy while the API service stays unchanged.

## Topology and guarantees

- `noqori.target` starts the release after reboot.
- `noqori-migrate.service` is a oneshot prerequisite kept active after success. API and worker startup cannot race schema migrations, and a restart of only one runtime service does not rerun them beside the other service.
- `noqori-api.service` starts the API through the guarded production entrypoint and restarts on failure.
- `noqori-worker.service` starts the worker through the guarded production entrypoint and restarts on failure after a five-second delay. systemd start limiting is disabled so repeated crashes cannot strand the worker in `start-limit-hit`.
- A worker failure does not stop or restart the API. An API failure does not stop or restart the worker.
- SIGTERM stops new claims, keeps the active worker lease heartbeat running, and allows the active job to finish. systemd applies the 90-second upper shutdown bound and then kills the entire worker cgroup if necessary; the expired lease makes an interrupted job recoverable.
- `/api/health` is API liveness, `/api/ready` verifies the current SQLite schema, `/healthz` is worker liveness, and `/readyz` combines worker state with SQLite readiness.
- `ExecStartPost` gates a successful systemd start on the applicable readiness endpoint.

`noqori.target` is a lifecycle grouping, not a health signal. API and worker are deliberately `Wants` rather than runtime `Requires`: independently restarting or stopping one service must not propagate through the target and stop the other. Operational health is the conjunction of both service states and both readiness endpoints shown below.

The production entrypoint binds the API to `127.0.0.1`, fixes SQLite to `/var/lib/noqori/sitepulse.sqlite`, delegates migrations exclusively to the migration unit, disables rendered audits, and fixes rendered concurrency to `1`. These protected values are deliberately absent from `noqori.env` and cannot be overridden by `EnvironmentFile`. An attempt to enable rendered audits fails startup with the safe `RENDERED_AUDIT_REQUIRES_STE12` error. The directory is created through `StateDirectory=noqori`; do not put it on `/tmp`, a release directory, a container writable layer, or another ephemeral filesystem. Back up the database together with its WAL state using a SQLite-safe procedure.

## Host preparation

The units require Node.js at `/usr/bin/node`, the service account `noqori`, and the active release at `/opt/noqori/current`. This path has not been verified on the future VM: provisioning must install Node.js 24 there and pass the checks below. `ExecStartPre=/usr/bin/test -x /usr/bin/node` fails startup before migrations if the path is absent.

```bash
sudo useradd --system --home /var/lib/noqori --shell /usr/sbin/nologin noqori
sudo install -d -o noqori -g noqori -m 0750 /var/lib/noqori
sudo install -d -o root -g noqori -m 0750 /etc/noqori
sudo install -d -o noqori -g noqori -m 0755 /opt/noqori/shared/ms-playwright
sudo cp deploy/systemd/noqori.env.example /etc/noqori/noqori.env
sudo chown root:noqori /etc/noqori/noqori.env
sudo chmod 0640 /etc/noqori/noqori.env
/usr/bin/test -x /usr/bin/node
/usr/bin/node --version
```

Set `PUBLIC_ORIGIN` to the real HTTPS origin in `/etc/noqori/noqori.env`. The tracked example contains no credentials. If an operator enables `ADMIN_API_KEY`, inject it from a separately managed root-only file through a local `systemctl edit noqori-api.service` drop-in with `EnvironmentFile=/etc/noqori/noqori-secrets.env`; never add the file or value to this repository or the non-secret example.

Install production dependencies and the pinned Chromium build as the service user. Keep the browser outside a release directory so release rotation does not remove it.

```bash
sudo -u noqori pnpm install --prod --frozen-lockfile
sudo -u noqori env PLAYWRIGHT_BROWSERS_PATH=/opt/noqori/shared/ms-playwright pnpm exec playwright install chromium
```

Install the units and enable reboot startup:

```bash
sudo cp deploy/systemd/noqori.target /etc/systemd/system/
sudo cp deploy/systemd/noqori-*.service /etc/systemd/system/
sudo systemctl daemon-reload
pnpm verify:systemd
sudo systemctl enable --now noqori.target
```

`pnpm verify:systemd` invokes `systemd-analyze verify` for the target and all three services. It may report `PASS` only on Linux with `systemd-analyze` installed; macOS reports `UNAVAILABLE` and is not deployment evidence.

## Operations

Start, stop, or restart the complete release:

```bash
sudo systemctl start noqori.target
sudo systemctl stop noqori.target
sudo systemctl restart noqori.target
```

Inspect independent service state and readiness:

```bash
systemctl status noqori-api.service noqori-worker.service
curl --fail http://127.0.0.1:3000/api/ready
curl --fail http://127.0.0.1:3001/readyz
pnpm health:api
pnpm health:worker
```

The TLS reverse proxy must not expose `/api/health`, `/api/ready`, or the worker health port publicly. These operational endpoints are intended for loopback probes only and do not consume the public API rate-limit bucket.

Follow structured stdout/stderr logs without exposing environment contents:

```bash
journalctl -u noqori-api.service -u noqori-worker.service -f
```

Restart one failed component without disturbing the other:

```bash
sudo systemctl restart noqori-api.service
sudo systemctl restart noqori-worker.service
```

For a release update, stop the target, atomically switch `/opt/noqori/current` to the fully installed release, then start the target. Starting the target runs the migration unit before either runtime service. Do not mix old and new API/worker binaries around an ownership migration.

## Failure and recovery behavior

`Restart=on-failure` and `RestartSec=5s` provide crash recovery without a tight loop. `StartLimitIntervalSec=0` prevents repeated failures from permanently stranding the worker. A deliberate `systemctl stop` is a clean stop and is not restarted by `Restart=on-failure`. systemd never starts a replacement instance until the prior service process has exited, so the configured unit does not create two active workers. If a worker dies after claiming a job, its lease expires; the replacement worker calls `recoverExpired()`, requeues the job while attempts remain, and claims it with a new fencing token. The API continues serving job state throughout an automatic worker restart.

Normal SIGTERM is different from a crash: `worker.stop()` prevents another claim but allows the current audit and its heartbeat to finish. `KillMode=mixed` sends the initial stop signal only to the Node main process and reserves a cgroup-wide SIGKILL for `TimeoutStopSec`, preventing orphan Chromium processes after a hard timeout.

## STE-12 and STE-14 boundaries

This change does not claim that application-level SSRF checks isolate Chromium. The current `MemoryMax=2G` budget is approved only for the HTML-only worker. Before enabling rendered audits for external users, STE-12 must run the browser side of the worker in a dedicated network namespace or container with an egress proxy, DNS controls, private/reserved range denial, and explicit CPU/RAM/process limits. Re-measure worker and browser memory on the target VM before changing the enforced rendered-off policy. The systemd worker unit is the handoff point for that sandbox; do not weaken its one-worker/concurrency-one policy while adding it.

For STE-14 deployment work, add the TLS reverse proxy, host firewall, encrypted off-host SQLite backups with restore tests, release rollback procedure, disk/RAM/CPU alerting, and journal shipping. Continuous readiness monitoring is also deferred; current systemd supervision detects process failures and gates startup readiness, while the endpoints expose real runtime state for the future monitor.

Before STE-14 sign-off, run a VM boot and crash acceptance test on the actual Linux host: verify all four units with `systemd-analyze`, reboot and confirm both service/readiness pairs after target startup, kill the worker during a persisted job, observe its automatic replacement and lease recovery, confirm the API remains available, verify only one worker PID/cgroup is active, independently restart the worker while the API remains ready, and test SIGTERM drain followed by clean exit. The portable JavaScript test is only a queue crash-recovery harness; it does not emulate systemd.
