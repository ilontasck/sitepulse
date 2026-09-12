# Production observability (STE-16)

## Architecture and rollout

One existing `createAuditTelemetry` layer emits newline-delimited JSON to stdout (journald in production). SQLite is the durable source of queue state and safe terminal error codes; no external error tracker is required. See [baseline gaps](STE-16-CURRENT-OBSERVABILITY-GAPS.md).

Migration 006 adds nullable `audit_jobs.request_id` and completion/failure timestamp indexes. Apply with the existing supervised migration service before starting the new API/worker. Old jobs have no originating request ID but retain job correlation. The existing production browser bundle hashes include changed source files: a future release needs fresh Linux sandbox acceptance/attestation. This task does not install units, enable monitoring, merge or deploy.

Set `TELEMETRY_ENABLED=true` (default). Disabling telemetry disables API/worker journal evidence, not SQLite metrics; runner diagnostics remain enabled in its deliberately restricted environment. Retain persistent journald logs with restricted operator access; choose retention according to the deployment privacy policy (suggested operational starting point: 14 days and a disk cap). Rotation or disabled logging can remove earlier attempts. No raw stacks are emitted.

## Log contract

Every entry has `timestamp` (UTC ISO), `level`, `event` and legacy `type: sitepulse.audit`. Applicable fields are `requestId`, `jobId`, `auditId`, `worker` (boot UUID), `auditMode` (`basic`/`rendered`; legacy scanner events use `html`), `attempt`, `phase`, `errorCode`, `route`, `method`, `statusCode`, `durationMs`, `queueWaitMs`, `lighthouseDurationMs`, `outcome`, and allowlisted fallback reasons. IDs and values are validated; absent context is omitted. There is no `userId` because it is unnecessary for operations.

Examples (identifiers are illustrative):

```json
{"timestamp":"2026-09-12T10:00:00.000Z","level":"info","type":"sitepulse.audit","event":"audit.queued","requestId":"11111111-1111-4111-8111-111111111111","jobId":"22222222-2222-4222-8222-222222222222","auditMode":"basic","durationMs":0,"outcome":"queued"}
{"timestamp":"2026-09-12T10:00:01.000Z","level":"error","type":"sitepulse.audit","event":"audit.failed","requestId":"11111111-1111-4111-8111-111111111111","jobId":"22222222-2222-4222-8222-222222222222","worker":"33333333-3333-4333-8333-333333333333","auditMode":"basic","attempt":2,"phase":"generate","errorCode":"AUDIT_TIMEOUT","durationMs":45001,"outcome":"failed"}
```

The HTTP server always generates a fresh UUID and returns `X-Request-ID`, including errors, readiness and static responses. Client IDs are ignored, even valid UUIDs: format validation alone cannot establish that an input is free of secrets. AsyncLocalStorage isolates concurrent request/job contexts. Enqueue persists the server ID. Worker restores it when claiming/retrying. Production RPC version 2 rejects old runners during the readiness handshake before any claim. It uses the job UUID as its existing protocol request ID and carries an optional validated originating request ID. Local and isolated scanner logs therefore share job context. A successful persistence event adds the final audit/report ID.

Events:

- `http.request_completed`: one per response/connection close, with route template, method, status and elapsed time. Premature close is 499. `http.request_failed` records safe error categories, never exception text.
- `audit.queued`, `audit.started`, `audit.completed`, `audit.failed`, `audit.retry_scheduled`: durable workflow transitions. Completion means the report and job update committed. Failure means terminal state committed; an attempt failure before retry is `worker.job_failed` plus `audit.retry_scheduled`.
- `worker.started`, `worker.ready`, `worker.job_claimed`, `worker.job_completed`, `worker.job_failed`, `worker.shutdown`, `worker.error`. Executor readiness logs only state changes, never each poll. Startup errors are contained and exit nonzero for systemd.
- `runner.started`, `runner.completed`, `runner.failed`: isolated execution, before worker persistence. Runner completion alone does not mean a saved report.
- Existing `rendered_completed`, `rendered_timeout`, `rendered_crash`, `rendered_failure`, `rendered_concurrency_rejected`, `rendered_fallback`, `html_fallback`, `audit_job_ownership_lost`, `auth_session_cleanup_failed` remain available. Fallback is a degraded successful audit, not a terminal failed job.

Normal audit/worker duration is elapsed time of the current attempt. `queueWaitMs` is age since original enqueue at claim (includes earlier attempts on retry). Recovery events use elapsed time since enqueue and phase `recover`; the recovery worker UUID is the observer, not the dead worker. Mode on worker/recovery events is the current configured requested mode; scanner events describe actual fallback mode. Historical mode across a configuration change is not persisted.

## Metrics and health

`GET /api/operations` requires the existing `X-Admin-Key` and enabled `ADMIN_API_KEY`. Wrong/missing key: 403; feature disabled: 404. It returns `Cache-Control: private, no-store` and only aggregates:

- `database.reachable: true` on successful query; DB query errors return generic 500, not partial or false healthy data.
- `queue.queued/running/failed/completed`: all current retained rows, including jobs owned by any user and historical jobs. `oldestQueuedAgeMs`: oldest original enqueue timestamp among queued jobs, zero when empty.
- `recent.completed/failed/failureRate`: terminal outcomes in the last 15 minutes. Retries count only once when finally completed/failed. `completionLatencyAvgMs`: enqueue-to-completion latency, including queueing/retries; null without completions. `lastCompletedAt`: most recent completion in that window, otherwise null.
- `api.requests/errors/dbErrors/latencyAvgMs/latencyMaxMs`: bounded minute buckets for approximately the last 15 minutes (up to one extra minute), process-local and reset on restart. Includes health and unauthorized API requests; current operations response is recorded after the snapshot. Latency measures HTTP lifecycle, not just handler compute.

Public `/api/health` stays liveness; `/api/ready` checks current SQLite schema and shutdown state. Existing worker loopback `/healthz` and `/readyz` stay minimal and return no customers or paths; `/readyz` adds `lastJobAt` (last claim) and `lastPollAt`, with `activeJob`, combined SQLite/runner readiness and stopping state. Never expose the worker port through the reverse proxy. An idle worker's last job may be old without being unhealthy. A stuck event loop is caught by probe timeouts; readiness is not a proof that every possible audit can complete.

## Alert checks

Run `node --env-file=/etc/noqori/noqori.env --env-file=/etc/noqori/noqori-secrets.env scripts/check-observability.mjs` from the release directory as an authorized operator with journal access. The secret environment file follows the existing root-owned 0600 policy; never put the actual key in a command argument. The checker only sends the admin key to a fixed loopback origin, refuses redirects and has bounded probe/journal timeouts. PORT/WORKER_HEALTH_PORT select local ports. Any journalctl stderr diagnostic (including partial system-journal access warnings) fails closed. Missing admin configuration/journal access produces an explicit monitoring alert, not a green result.

The script emits a safe `operations.alert_check` JSON object containing condition codes only. Exit 0 = healthy, 1 = active conditions, 2 = checker/configuration failure. It queries journal messages from the last 15 minutes with an 8 MiB buffer limit; exceeding it reports journal unavailable.

Defaults are reviewable in `src/telemetry/alert-conditions.mjs`:

| Condition | Trigger |
| --- | --- |
| API/worker unavailable | readiness non-200, invalid response or probe timeout |
| Queue backlog | more than 20 queued jobs |
| Old queue | oldest queued age over 120 seconds |
| Audit failure rate | at least 5 terminal jobs and failure fraction at least 25% in 15 minutes |
| API latency | at least 10 requests and average latency over 2 seconds |
| API errors | at least 10 requests and 5xx fraction at least 10% |
| Repeated DB errors | at least 3 DB_FAILURE journal events or API metric errors in 15 minutes |
| Repeated worker restarts | at least 4 worker starts or startup failures in 15 minutes (also catches forced-kill restart loops) |
| Monitoring failure | missing operations endpoint/key or unreadable journal |

These are absolute guardrails, not an adaptive anomaly baseline. DB events can include both failure and completion records for one incident; use the journal timeline to distinguish independent faults. Tune thresholds to workload and check failure/fallback events before changing them. Existing systemd `Restart=on-failure` and five-second backoff remain unchanged.

For production scheduling, an operator can configure a oneshot systemd service running this command with the two existing EnvironmentFiles, WorkingDirectory `/opt/noqori/current`, and a timer with `OnBootSec=2min`, `OnUnitActiveSec=1min`. Use the deployment's existing notification destination via `OnFailure`; require two consecutive unhealthy checks for availability/backlog paging and notify on recovery. No timer or external message delivery is installed by this change. Until scheduled/delivery is wired, checks are manual and no proactive notifications occur. Do not modify existing attested service units through drop-ins.

## Privacy and error taxonomy

The field allowlist excludes all headers (Authorization/Cookie/X-Admin-Key included), cookies, bodies, passwords, tokens, email, personal form data, URLs, raw HTML, responses, exception messages and stacks. URL handling in logs is omission, not query stripping: even hosts/path segments can contain sensitive customer data. API routes use fixed templates; unknown paths become `/api/unknown`. IDs are server-generated or validated internal UUIDs. No end-user ID is emitted. Free-form reasons are dropped; error codes are restricted to known classifier/infrastructure categories, otherwise UNKNOWN_ERROR. A failing log sink is contained so it cannot change a committed job outcome.

Existing safe codes remain authoritative: UNSAFE_URL/UNSAFE_REDIRECT/SSRF_BLOCKED for blocked destinations, SCAN_TIMEOUT/AUDIT_TIMEOUT and network codes for scan problems, CHROMIUM_CRASH/BROWSER_CRASH for browser failures, AUDIT_RUNNER_UNAVAILABLE/TIMEOUT/PROTOCOL_MISMATCH/BUSY for RPC, WORKER_LEASE_EXPIRED for crash recovery. DB_FAILURE identifies SQLite errors; QUEUE_FAILURE identifies recover/claim errors without a narrower code; WORKER_FAILURE is the process-level failure category. Unknown audit errors remain AUDIT_FAILED with a generic public message. `phase` separates preflight, generation, persistence, lease heartbeat, recovery and failure-transition errors. Raw exception text is never needed to select the first investigation path, but unknown programming errors can require a local reproduction.

## Investigating “audit X failed”

1. Obtain the job ID from the 202 response/status URL; a failed job has no report/audit ID. If only a successful report ID is known, find its `audit.completed` event to recover the job ID.
2. Search all process journals for the job, restricting time appropriately:

   ```bash
   journalctl -u noqori-api -u noqori-worker -u noqori-audit-runner --since '1 hour ago' -o cat |
     jq -R 'fromjson? | select(.jobId == "22222222-2222-4222-8222-222222222222")'
   ```

3. Read `audit.failed.errorCode`, `phase`, attempt and preceding `worker.job_failed`. Follow `requestId` back to enqueue and HTTP status/duration; follow worker UUID across restarts.
4. `phase=generate`: inspect matching runner/scanner events. `persist`/`failure-transition`: check DB readiness and DB_FAILURE. `recover` + WORKER_LEASE_EXPIRED: inspect systemd worker exit/restart timeline. An ownership-loss event means fencing prevented a stale worker from saving a report; find the later attempt for the same job.
5. Read authorized queue/API metrics and worker readiness. Distinguish a slow customer job, widespread runner errors, queue overload and storage failure. Run the alert checker to see active aggregate conditions.
6. If journal retention removed the original event, an operator may read only `id, request_id, audit_id, status, attempt_count, error_code` from SQLite by job ID; avoid dumping whole customer rows. Durable terminal state survives process restarts; attempt-by-attempt history lives in journald.

Estimated triage for known categories after rollout with retained logs: 2–5 minutes versus roughly 15–30+ minutes of manual cross-checking before this change. This is an engineering estimate, not a measured incident benchmark. Unknown AUDIT_FAILED exceptions may still need reproduction and take longer. No Sentry grouping, stack capture, percentile histogram, distributed collector or automated notifications are claimed.
