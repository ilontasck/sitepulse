# Asynchronous Audit Architecture v1

Status: approved implementation specification for Day 2.

Scope: SQLite-backed persistent audit jobs for a single SitePulse web process and a single worker process. This document is authoritative for v1 unless an implementation discovery proves a security or data-integrity issue.

## Current Problem

`POST /api/audits` currently owns the entire audit lifecycle. The HTTP request validates JSON, calls `generateAudit()`, waits for HTML scanning and optional Lighthouse/Chromium work, inserts the completed report into `audits`, and only then returns `201` with the full audit. A rendered audit can therefore keep a public HTTP connection open for tens of seconds and ties browser resource usage to the web process.

The current seams are suitable for extraction, but three implementation details must change:

- `audit-routes.mjs` must enqueue work instead of executing `generateAudit()`.
- SQLite setup is private to `audit-store.mjs`; migrations and cross-table transactions need a shared database module.
- `scanner-service.mjs` currently converts rendered timeout/crash into a successful HTML fallback. The worker needs a structured retryable failure signal when the failure policy requires a retry.

`generateAudit(inputUrl, options)` remains the reusable audit operation. Report shape, scoring, scanners, SSRF checks, rendered concurrency limit, and `GET /api/audits/:auditId` remain intact.

## Target Flow

```text
browser
  -> POST /api/audits
  -> JSON/request validation
  -> URL normalization and initial safety/DNS validation
  -> INSERT audit_jobs(status = queued)
  <- HTTP 202 + jobId

worker
  -> recover expired leases
  -> atomically claim oldest eligible queued job
  -> repeat URL and network safety validation
  -> generateAudit(normalizedUrl)
  -> atomically INSERT audits + UPDATE audit_jobs(completed, audit_id)

browser (frontend polling is a later task)
  -> GET /api/audit-jobs/:jobId
  -> when completed, GET /api/audits/:auditId
  -> render the existing report shape
```

The web and worker processes use one shared local SQLite database file configured by `DATABASE_FILE_PATH`. SQLite WAL and `busy_timeout` remain enabled.

## Database Schema

The only v1 statuses are `queued`, `running`, `completed`, and `failed`.

```sql
CREATE TABLE audit_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  normalized_url TEXT NOT NULL,
  audit_id TEXT REFERENCES audits(id),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts = 2),
  available_at TEXT NOT NULL,
  lease_expires_at TEXT,
  worker_id TEXT,
  lease_token TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  CHECK (
    (status = 'queued' AND audit_id IS NULL AND worker_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR
    (status = 'running' AND audit_id IS NULL AND worker_id IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status = 'completed' AND audit_id IS NOT NULL AND completed_at IS NOT NULL)
    OR
    (status = 'failed' AND audit_id IS NULL AND failed_at IS NOT NULL)
  )
);

CREATE INDEX idx_audit_jobs_claim
  ON audit_jobs (status, available_at, created_at);

CREATE INDEX idx_audit_jobs_expired_lease
  ON audit_jobs (status, lease_expires_at);

CREATE UNIQUE INDEX idx_audit_jobs_audit_id
  ON audit_jobs (audit_id)
  WHERE audit_id IS NOT NULL;
```

Timestamps are UTC ISO-8601 strings. IDs and `lease_token` are UUIDs. `attempt_count` increments only when a job is claimed; the first execution has attempt `1`, the retry has attempt `2`. Error fields contain allowlisted codes and safe user-facing text only. They must not contain stack traces, HTML, response bodies, tokens, query-string secrets, resolved internal addresses, or exception serialization.

## Migration Strategy

Add a minimal ordered migration runner instead of initializing schema inside stores.

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
```

Migration files are immutable ESM modules in `src/storage/migrations/`, named with monotonically increasing numeric versions:

```text
001_initial_audits.mjs
002_audit_jobs.mjs
```

Each exports `{ version, name, up(database) }`. The runner:

1. Opens the configured database and applies standard PRAGMAs.
2. Starts `BEGIN IMMEDIATE`.
3. Creates `schema_migrations` if absent.
4. Reads applied versions.
5. Runs each missing migration in numeric order.
6. Inserts its version only after `up()` succeeds.
7. Commits all pending migrations; any failure rolls back startup.

Migration `001` uses idempotent creation of the existing `audits` table and indexes so an existing beta database can be adopted, then records version 1. Migration `002` creates `audit_jobs` and its indexes. Stores never execute schema DDL. Both `server.mjs` and `worker.mjs` run migrations before accepting traffic or claiming jobs. `BEGIN IMMEDIATE` serializes concurrent startup migration attempts.

There are no automatic down migrations. Backups precede destructive migrations. Later users/subscriptions tables use the same mechanism.

## Storage Module Interfaces

`createAuditStore(databaseFilePath)` keeps its existing `create`, `list`, and `findById` interface for existing callers. Schema initialization moves out of its implementation.

The new deep job-storage module hides claiming, fencing, recovery, retry transitions, and the completion transaction:

```js
createAuditJobStore(databaseFilePath, { clock, idGenerator })

jobStore.enqueue({ normalizedUrl })
jobStore.findById(jobId)
jobStore.claimNext({ workerId, leaseMs })
jobStore.renewLease({ jobId, workerId, leaseToken, leaseMs })
jobStore.complete({ jobId, workerId, leaseToken, audit })
jobStore.handleFailure({ jobId, workerId, leaseToken, failure })
jobStore.recoverExpired()
```

Callers do not issue SQL or perform status transitions themselves. Tests use the same interface. Internal helpers may share audit serialization with `audit-store.mjs`, but no second public storage abstraction is introduced.

## API Contract

### Create job

`POST /api/audits`

Accepted request fields remain backward-compatible:

```json
{ "websiteUrl": "https://example.com" }
```

Legacy `{ "url": "..." }` remains accepted. The route performs body validation, `normalizeWebsiteUrl()`, and `assertSafeUrl()` before enqueue. Invalid or unsafe input returns the existing safe 4xx error and creates no job.

Success:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json; charset=utf-8
Location: /api/audit-jobs/7a76...
Retry-After: 1
```

```json
{
  "job": {
    "id": "7a76...",
    "status": "queued",
    "createdAt": "2026-08-13T10:00:00.000Z",
    "statusUrl": "/api/audit-jobs/7a76..."
  }
}
```

The response never contains an inline audit. This is the one intentional HTTP contract change; the frontend and backend must ship together.

### Read job

`GET /api/audit-jobs/:jobId`

Queued:

```json
{ "job": { "id": "...", "status": "queued", "createdAt": "..." } }
```

Running:

```json
{ "job": { "id": "...", "status": "running", "createdAt": "...", "startedAt": "..." } }
```

Completed:

```json
{
  "job": {
    "id": "...",
    "status": "completed",
    "createdAt": "...",
    "completedAt": "...",
    "auditId": "...",
    "auditUrl": "/api/audits/..."
  }
}
```

Failed:

```json
{
  "job": {
    "id": "...",
    "status": "failed",
    "createdAt": "...",
    "failedAt": "...",
    "error": {
      "code": "AUDIT_FAILED",
      "message": "The website could not be audited. Please try again."
    }
  }
}
```

Unknown or malformed UUIDs return a safe `404 AUDIT_JOB_NOT_FOUND`. Worker IDs, lease tokens, lease expiry, attempt counters, raw errors, and internal retry decisions are not exposed by the public response.

`GET /api/audits/:auditId` and its response remain unchanged.

## State Transitions

```text
queued --claim--> running --successful audit + commit--> completed
                          --terminal failure-----------> failed
                          --retryable failure----------> queued (attempt 1 only)
                          --retryable failure----------> failed (attempt 2)
                          --expired lease--------------> queued (attempt 1 only)
                          --expired lease--------------> failed (attempt 2)
```

There are no other v1 transitions. Terminal rows are immutable. A transition must include the expected current status and, for running jobs, the current `worker_id` and `lease_token` in its `WHERE` clause.

## Claim And Lease Algorithm

### Claim

`claimNext()` performs a short write transaction:

```sql
BEGIN IMMEDIATE;

UPDATE audit_jobs
SET status = 'running',
    attempt_count = attempt_count + 1,
    worker_id = :worker_id,
    lease_token = :new_lease_token,
    lease_expires_at = :lease_expires_at,
    started_at = COALESCE(started_at, :now),
    updated_at = :now,
    error_code = NULL,
    error_message = NULL
WHERE id = (
  SELECT id
  FROM audit_jobs
  WHERE status = 'queued'
    AND available_at <= :now
    AND attempt_count < max_attempts
  ORDER BY created_at ASC
  LIMIT 1
)
AND status = 'queued'
RETURNING *;

COMMIT;
```

`BEGIN IMMEDIATE` allows only one claimant to perform the selection/update sequence at a time. The conditional update is retained as defense in depth. The transaction ends before audit work begins.

### Lease

Recommended beta defaults:

- lease duration: 30 seconds;
- heartbeat interval: 10 seconds;
- worker poll interval while idle: 500 milliseconds;
- maximum attempts: exactly 2;
- rendered concurrency: exactly 1 in the single worker process.

`renewLease()` updates only a row matching `running`, `worker_id`, and `lease_token`. A zero-row update means ownership was lost; the stale worker must not commit a result.

The random `lease_token` is a fencing token. Reusing a stable worker ID is insufficient because a recovered job can later be claimed by the same restarted worker process.

### Expired lease recovery

`recoverExpired()` runs at worker startup and before each claim cycle inside `BEGIN IMMEDIATE`:

- `running` with expired lease and `attempt_count < max_attempts` becomes `queued`, clears ownership/lease fields, and sets `available_at = now`.
- `running` with expired lease and `attempt_count >= max_attempts` becomes `failed` with safe code `WORKER_LEASE_EXPIRED`.

Recovery never decrements `attempt_count` and never creates an audit.

## Retry Classification Policy

Add a pure function with an exhaustive, allowlist-based interface:

```js
classifyAuditFailure(error, { phase }) => ({
  disposition: "retry" | "fail",
  code: "SAFE_STABLE_CODE",
  message: "Safe user-facing message"
})
```

`phase` is `preflight` or `worker`. Preflight failures are returned synchronously and are never enqueued. The worker uses classification after it owns a job. Unknown errors default to terminal `AUDIT_FAILED`; retries are granted only to known transient classes or an explicit `error.retryable === true` produced inside a trusted module.

Retryable in the worker:

- process crash, represented by expired lease recovery;
- `SCAN_TIMEOUT` and a typed overall audit timeout, after cleanup is confirmed;
- transient DNS/network codes such as `EAI_AGAIN`, `ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `ENETUNREACH`, and `EHOSTUNREACH`;
- `HOSTNAME_NOT_RESOLVED` during worker revalidation, because DNS failure may be temporary;
- typed Chromium launch/crash/target-closed failures;
- typed temporary infrastructure/database-busy failures, provided no completion transaction committed.

Terminal in every phase:

- `URL_REQUIRED`, `URL_TOO_LONG`, `INVALID_URL`, `INVALID_PUBLIC_DOMAIN`;
- `UNSUPPORTED_URL_PROTOCOL`;
- `UNSAFE_URL`, `UNSAFE_REDIRECT`, and any SSRF/network-policy rejection;
- `TOO_MANY_REDIRECTS`, `HTML_TOO_LARGE`, `NON_HTML_RESPONSE`;
- deterministic invalid request/body failures;
- any failure explicitly marked `retryable: false`;
- unknown errors after safe redaction.

At attempt 1, a retryable failure transitions back to `queued`. At attempt 2, the same classification transitions to `failed`. A retry does not occur in memory; it is persisted as a new queued transition so a process restart cannot lose it.

Current rendered failures need a typed seam. In worker mode, retryable Lighthouse timeout/crash/infrastructure failures must reach the worker classifier instead of being reduced to warning strings. Security-policy failures remain terminal. Non-retryable or deliberately degraded rendered findings may continue to produce a completed HTML fallback only when the audit policy explicitly says fallback is a valid final report. Classification must never depend solely on regular-expression matching of an exception message.

## Transaction Boundaries

Each transaction is short and contains no network or browser work:

1. **Enqueue transaction:** insert one queued job.
2. **Recovery transaction:** requeue or fail expired running jobs.
3. **Claim transaction:** atomically transition one queued job to running.
4. **Heartbeat transaction:** conditionally extend one owned lease.
5. **Retry/fail transaction:** conditionally transition the owned running job.
6. **Completion transaction:** create the audit record and link the owned job.

Completion is one transaction:

```text
BEGIN IMMEDIATE
  verify job is running and ownership token matches
  build persisted audit record and UUID
  INSERT INTO audits
  UPDATE audit_jobs
    SET status = completed, audit_id = new audit ID, completed_at = now,
        ownership/lease/error fields = NULL
    WHERE id/status/worker_id/lease_token match
  assert exactly one job row changed
COMMIT
```

If ownership verification or the job update fails, the transaction rolls back the audit insert. This prevents orphan audits and duplicate completion. A stale worker can finish computation but cannot persist after its lease has been recovered and fenced with a new token.

## Worker Lifecycle

`worker.mjs` is a separate entrypoint and never starts an HTTP listener.

1. Load and validate configuration.
2. Run pending database migrations.
3. Create the job store, audit telemetry, rendered limiter with concurrency 1, and a stable process-level worker ID.
4. Recover expired leases.
5. Poll and claim one job.
6. Start heartbeat before security revalidation and audit work.
7. Revalidate the normalized URL with `assertSafeUrl()`; queued data is untrusted.
8. Run `generateAudit()` with worker policy, existing rendered timeout, limiter, telemetry, and an abort signal when supported.
9. Stop heartbeat.
10. Complete atomically, or classify and persist retry/failure.
11. Repeat after yielding to the event loop.

On `SIGINT` or `SIGTERM`, stop claiming new jobs, let the active audit finish within the hard shutdown grace period, continue heartbeats while it runs, then close cleanly. If the process is forcibly killed, its lease expires and recovery handles the job.

Do not implement an overall timeout as `Promise.race()` unless the underlying HTML/browser work is actually cancelled and Chromium cleanup has completed. Otherwise the worker could retry while the first attempt still runs. Day 2 should thread an `AbortSignal` through audit operations or rely on their bounded native timeouts until cancellation is real.

## Telemetry

Extend the existing structured collector with allowlisted, non-sensitive job events:

- `audit_job_enqueued`
- `audit_job_claimed`
- `audit_job_lease_renewed` (sampled or debug-only to avoid noise)
- `audit_job_completed`
- `audit_job_retry_scheduled`
- `audit_job_failed`
- `audit_job_lease_expired`
- `audit_job_recovered`

Useful fields are `jobId`, `auditId`, `attempt`, `durationMs`, `queueWaitMs`, `auditMode`, `outcome`, and safe `reason`. Full target URLs should not be logged; if correlation is later required, log only a normalized hostname or one-way keyed identifier. Never log HTML, request/response bodies, headers, query strings, lease tokens, environment contents, stack traces, or secrets.

Process-local counters remain acceptable for beta, while structured lines are the future external-monitoring seam.

## Security Boundaries

- The route validates JSON shape, accepted field, length, protocol, normalization, hostname/IP policy, and current DNS answers before enqueue.
- The worker repeats URL and DNS safety validation immediately before execution.
- Every redirect, browser subresource, WebSocket, and final rendered URL remains subject to existing checks.
- Preflight success is not authorization: DNS can change between enqueue and execution.
- Only the normalized URL is persisted; arbitrary request fields are discarded.
- Job lookup uses unguessable UUIDs and exposes the minimum status projection.
- POST creation remains rate-limited. Polling must have a separate, more permissive limiter so normal status checks do not consume the creation budget.
- Queue depth needs a configurable beta ceiling. When full, POST returns safe `503 AUDIT_QUEUE_FULL` with `Retry-After`; it must not create a job.
- SQLite parameters are bound; no job data is interpolated into SQL.
- Worker and Chromium production isolation requirements in `PRODUCTION_BROWSER_SECURITY.md` still apply. Application checks do not replace restricted egress.

## Failure Recovery

| Failure | Persisted outcome |
| --- | --- |
| Web crashes after enqueue | Job remains queued and the worker processes it. |
| Worker crashes before claim commit | Claim rolls back; job remains queued. |
| Worker crashes during audit | Job remains running until lease expiry, then is requeued or failed by attempt count. |
| Worker loses lease but later finishes | Completion is rejected by ownership token; no audit is inserted. |
| Completion transaction crashes before commit | Both audit insert and job update roll back. |
| Completion transaction commits but response/logging fails | Job and audit remain completed; telemetry may be incomplete but data is correct. |
| Temporary network/browser failure on attempt 1 | Persisted back to queued for attempt 2. |
| Retryable failure on attempt 2 | Failed with safe error. |
| Security or deterministic failure | Failed immediately, with no retry. |
| Worker unavailable | Jobs remain queued durably; API continues returning their state. |
| SQLite busy | Respect `busy_timeout`; known transient busy failures may retry without violating ownership fencing. |

## File-by-File Implementation Plan

### New files

- `src/storage/sqlite-database.mjs` — open/configure database, run transactions, run migrations.
- `src/storage/migrations/001_initial_audits.mjs` — adopt/create current audits schema.
- `src/storage/migrations/002_audit_jobs.mjs` — create jobs schema and indexes.
- `src/storage/audit-job-store.mjs` — deep persistent queue module and atomic completion.
- `src/audit/audit-failure-policy.mjs` — pure retry/terminal classification with safe errors.
- `src/audit/audit-job-worker.mjs` — claim/heartbeat/execute/transition loop with injected dependencies.
- `worker.mjs` — worker composition root and signal handling.
- `test/sqlite-migrations.test.mjs` — fresh and existing-database migration coverage.
- `test/audit-job-store.test.mjs` — transitions, atomic claim, fencing, recovery, atomic completion.
- `test/audit-failure-policy.test.mjs` — exhaustive retry classifications.
- `test/audit-job-worker.test.mjs` — success, retry, terminal failure, heartbeat, crash recovery.

### Existing files

- `src/storage/audit-store.mjs` — remove embedded DDL/opening helpers; use shared database implementation while preserving its interface.
- `src/http/audit-routes.mjs` — validate and enqueue on POST; add job status GET; retain audit GET/list behavior.
- `src/http/app.mjs` — compose/inject audit and job stores; remove audit execution/limiter ownership from the web process.
- `src/audit/scanner-service.mjs` — expose typed retryable rendered failures in worker mode without message-regex classification; preserve explicit HTML fallback policy.
- `src/audit/audit-engine.mjs` and scanner options — accept/forward cancellation only as needed; keep `generateAudit()` reusable.
- `src/config/env.mjs` — validate poll interval, lease duration, heartbeat interval, queue ceiling, attempts fixed at 2, and shutdown grace period.
- `src/telemetry/audit-telemetry.mjs` — add allowlisted job events/fields and counters.
- `server.mjs` — run migrations before listen.
- `package.json` — add `worker` and development worker commands.
- `.env.example`, `README.md`, `MACHINE_SETUP.md`, `PROJECT_HEALTH_REPORT.md` — document two-process startup, shared database, settings, and operational limits.
- `scripts/reset-db.mjs` — behavior remains database-file removal; documentation notes that it removes jobs and audits.
- `test/audit-api.test.mjs` — replace synchronous creation assertions with 202/status contract tests.
- `test/audit-store.test.mjs` and `test/config.test.mjs` — shared schema and worker configuration coverage.
- `e2e/sitepulse.spec.mjs` — frontend polling tests are deferred until frontend polling implementation.

## Day 2 Implementation Order

1. Add migration runner plus migrations 001/002; prove fresh DB, existing audits DB, idempotency, and concurrent startup.
2. Refactor `audit-store.mjs` onto the shared database implementation without changing behavior; run all existing tests.
3. Implement and test `audit-job-store.mjs`, especially two-claimant exclusion, fencing, expired leases, and atomic audit completion.
4. Implement and test the pure failure classification policy.
5. Add the worker module with injected clock/sleeper/generator/store, heartbeat, recovery, retry, and graceful shutdown tests.
6. Add `worker.mjs`, worker configuration, and telemetry events.
7. Convert POST to `202` enqueue and add job status GET; update API tests while preserving audit GET.
8. Add structured rendered-failure propagation and real cancellation/cleanup where required by retry semantics.
9. Run the complete unit/API/e2e suite and add a two-process integration test using one temporary SQLite file.
10. Update operational documentation. Frontend polling starts only after the backend contract and worker are stable.

The first implementation step is migrations, not routes: every later module depends on a shared, versioned, transaction-capable SQLite foundation.

## Explicitly Deferred

- Frontend polling and polling UX.
- `cancelled` status and cancellation endpoint.
- Progress percentages or named progress stages.
- Priorities and scheduling classes.
- Dead-letter status or dead-letter UI.
- More than two attempts or configurable per-job retry policies.
- Multiple concurrent worker processes as an operated beta topology.
- Distributed queue semantics, Redis, BullMQ, PostgreSQL, or message brokers.
- Cross-host leases and clock coordination.
- User ownership, authentication, subscriptions, billing, and per-tenant quotas.
- Webhooks, server-sent events, and WebSockets for job updates.
- Job deduplication and idempotency keys.
- Queue administration UI, manual retry, cancellation, and replay.
- Automatic data-retention cleanup and archival policy.
- CrUX/RUM, median-of-three, and historical Core Web Vitals.
- External metrics/log aggregation.

These are not required for the single-host public beta architecture and must not enlarge the Day 2 implementation.
