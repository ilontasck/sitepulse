> Historical evidence for the dated release below; not current release acceptance. See [current status](SOURCE-OF-TRUTH.md).

# STE-16 — implementation and review report

1. **Branch/worktree:** `feature/ste-16-production-observability`, existing checkout `/Users/stefanyavisenko/SitePuls /sitepulse`.
2. **Starting SHA:** `08ef007ba561bf86d2e5ddf76544e061d562dcac`. Local main/origin/main/HEAD matched before changes. No remote fetch was required or claimed.
3. **Final SHA:** use the final task response / branch HEAD; this report is committed with the review fixes. Implementation commit: `209da4447315e429e8bb31395de58e047b4e71f8`.
4. **Files changed:** 31 files, listed below. `docs/design-qa/` remains user-owned untracked and was neither read nor modified.
5. **Log schema:** UTC timestamp, level, event, legacy type; applicable requestId/jobId/auditId/worker, route/method/statusCode/durationMs, auditMode/attempt/phase/errorCode and bounded scanner timing/reasons. Existing telemetry seam/counters reused.
6. **Request IDs:** fresh server UUID for every handled HTTP request; client IDs ignored; response `X-Request-ID`; async context isolation across concurrent requests.
7. **Correlation:** migration 006 persists nullable request ID; job context restored in worker, retries and committed lease recovery; RPC v2 carries it into isolated runner/scanner events; completion adds saved audit ID. Mixed-version readiness fails before claim.
8. **Metrics:** durable queued/running/failed/completed counts, oldest queued age, last-15-minute terminal outcomes/failure rate/completion latency/last completion; bounded process-local API request/5xx/DB-error and average/max latency buckets.
9. **Operations endpoint:** `GET /api/operations`, existing admin key authorization, disabled 404 / missing or wrong key 403; no-store and aggregates only. Existing loopback worker readiness adds last-claim/last-poll timestamps.
10. **Error codes:** existing safe URL/network/timeout/browser/RPC taxonomy preserved; DB_FAILURE, QUEUE_FAILURE, WORKER_FAILURE plus stage fields; WORKER_LEASE_EXPIRED durable recovery category. Unknown errors stay generic and never expose message/stack.
11. **Alerts:** read-only script checks API/worker readiness, backlog >20, oldest queue >120s, terminal failure rate >=25% with >=5 outcomes, API latency/error rate, repeated DB events and worker starts/startup failures. Missing/partial journal access fails closed. Scheduling/delivery documented, not activated.
12. **Privacy protections:** headers/body/credentials/HTML/URLs/queries/user identifiers/exception strings excluded; route templates and server UUIDs; allowlisted fields and error codes; secrets tested through HTTP and production RPC. No external telemetry service.
13. **Validation:** see exact results below.
14. **Security/privacy/operations review:** no open actionable findings after fixes; detailed conclusions below.
15. **Known limitations:** no Linux/systemd/production VM execution on this Mac; new release requires migration and fresh sandbox attestation; no notification delivery configured; journal retention required for attempt history; unknown AUDIT_FAILED may need reproduction; no percentiles or persistent API counters. Historical requested mode is not persisted across deployment configuration changes. Readiness is not a guarantee that every job will succeed.
16. **Decision:** SAFE TO REVIEW. No merge, main push, feature push or production deployment performed.

## Exact validation

- `pnpm test`: **295 passed / 295**, 48 suites, 0 failed/cancelled/skipped/todo (2777.440833 ms).
- `node --test test/production-observability.test.mjs`: **7 passed / 7**, 0 failed/cancelled/skipped/todo (288.29475 ms).
- `pnpm test:e2e`: **51 passed / 51** (55.1 seconds), Chromium.
- `node --check` for all **28 changed .mjs files**: PASS.
- `git diff --check`: PASS.
- `pnpm verify:systemd`: **UNAVAILABLE**, reason: systemd verification requires Linux. Not a PASS and not deployment evidence.
- Initial sandbox launches could not bind local sockets (E2E explicitly returned EPERM); integration tests were rerun with approved local execution. Initial implementation run exposed seven stale contract assertions for migration/event/schema changes, which were updated; subsequent complete runs passed.

## SECURITY REVIEW

Existing authorization remains in place. Operations data is admin-only and contains aggregates. RPC accepts only validated correlation and protocol v2 prevents an old runner consuming new jobs. No shell-interpolated input or external credential transmission in the alert checker; key sent only to fixed loopback with redirects refused. Recovery logs happen after commit, and log-sink failure cannot roll back committed recovery.

## PRIVACY REVIEW

Regression tests inject a secret into credentials, request IDs, query strings, scan URLs, error messages, reasons, headers and bodies. Logs and aggregate endpoint output exclude it. No customer emails, user IDs, scanned content, paths or stacks are introduced. Existing database content and public report behavior are unchanged. Unknown code/reason values are suppressed or mapped to a safe generic code.

## OPERATIONS REVIEW

A known-category failed audit can be followed by job ID from enqueue through runner and storage, including retries/restarts and lease recovery. Queue and API metrics distinguish job-specific failures from broad degradation. Inspector/checker failure is explicit rather than silently healthy. Linux rollout, journal retention, timer and notification wiring remain operator work; the checker is fully manual until then.

## Standards

Independent reviewer initially found one P2: RPC payload changed without a protocol bump, violating the documented fail-closed handshake invariant. Fixed with protocol v2 and a mixed-version readiness/zero-claim regression. Re-review: **no remaining actionable findings**. No additional documented-standard violations or actionable heuristic smells found.

## Spec

Independent reviewer initially found one P2: successful journalctl with permission warnings could be treated as healthy empty evidence. Fixed by rejecting stderr diagnostics and adding empty/partial-output tests. Re-review: **no remaining actionable findings**. No scope creep or other missing requirements identified.

Standards: 0 open findings; Spec: 0 open findings.

## Investigation estimate

For a typical known-category failure with retained logs, estimated triage is **2–5 minutes**, compared with roughly **15–30+ minutes** before, when request/job/scanner correlation was missing. This is an engineering estimate, not a measured benchmark. Unknown programming errors and lost journal history can take longer.

## Changed files

- `docs/PRODUCTION-OBSERVABILITY.md`
- `docs/STE-16-CURRENT-OBSERVABILITY-GAPS.md`
- `docs/STE-16-REVIEW-REPORT.md`
- `scripts/check-observability.mjs`
- `server.mjs`
- `src/audit/audit-failure-classifier.mjs`
- `src/audit/audit-job-worker.mjs`
- `src/audit/audit-runner-client.mjs`
- `src/audit/audit-runner-protocol.mjs`
- `src/audit/audit-runner-server.mjs`
- `src/auth/session-cleanup-scheduler.mjs`
- `src/health/worker-health-server.mjs`
- `src/http/app.mjs`
- `src/http/audit-routes.mjs`
- `src/storage/audit-job-store.mjs`
- `src/storage/migrations.mjs`
- `src/storage/migrations/006_observability.mjs`
- `src/telemetry/alert-conditions.mjs`
- `src/telemetry/audit-telemetry.mjs`
- `src/telemetry/log-context.mjs`
- `src/telemetry/queue-metrics.mjs`
- `test/audit-api.test.mjs`
- `test/audit-job-store.test.mjs`
- `test/audit-queue-resilience.test.mjs`
- `test/audit-runner-rpc.test.mjs`
- `test/process-supervision.test.mjs`
- `test/production-audit-routing.test.mjs`
- `test/production-observability.test.mjs`
- `test/session-cleanup-scheduler.test.mjs`
- `test/sqlite-migrations.test.mjs`
- `worker.mjs`
