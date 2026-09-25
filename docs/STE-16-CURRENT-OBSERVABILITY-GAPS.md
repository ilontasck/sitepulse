> Historical evidence for the dated release below; not current release acceptance. See [current status](SOURCE-OF-TRUTH.md).

# CURRENT OBSERVABILITY GAPS

Baseline: 08ef007ba561bf86d2e5ddf76544e061d562dcac (before implementation).

- `server.mjs` creates the HTTP app; app has safe public liveness/readiness and authenticated audit routes, but no request IDs, access timing or unexpected-error logs.
- `createAuditTelemetry` is the existing JSON allowlist seam with local scanner counters. Extend it, keeping its counters compatible; do not introduce a competing logger.
- SQLite `audit_jobs` persists queued/running/completed/failed, attempts, leases and safe failure codes. Request correlation is absent; worker events omit job IDs. Add a nullable request ID migration; old jobs remain usable.
- Worker claims with lease fencing and retry classification. Production execution goes over a Unix socket to an isolated runner; local telemetry objects cannot cross that boundary. Carry validated correlation only.
- `generateAudit` delegates scanning and report generation. Scanner fallback is successful degraded output, not a failed job. Keep semantics, expose fallback events.
- Existing readiness checks validate SQLite and runner readiness. Use the existing admin-key mechanism for aggregate queue/API metrics; keep worker readiness loopback-only.
- systemd already restarts failed workers and journals output. Add a read-only alert checker and documented scheduling/delivery; no external monitoring platform or deployment.
- Tests cover queue/recovery, RPC, health, auth and scanner telemetry. Add privacy/correlation/metrics/authorization tests and retain lease/crash coverage.

Implementation boundaries: no public UI/auth UX/billing/recommendation changes. No customer URLs, request bodies, credentials, raw errors or stacks in logs. Persisted IDs + bounded aggregates + journal events form the error-tracking layer.
