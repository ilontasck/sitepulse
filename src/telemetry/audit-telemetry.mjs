import { safeErrorCode } from "../audit/audit-failure-classifier.mjs";
import { isCorrelationId, logContext } from "./log-context.mjs";

const numericFields = new Set(["durationMs", "lighthouseDurationMs", "queueWaitMs", "attempt", "statusCode"]);
const enumFields = {
  auditMode: new Set(["basic", "html", "rendered"]),
  level: new Set(["info", "warn", "error"]),
  method: new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]),
  phase: new Set(["preflight", "generate", "persist", "recover", "claim", "heartbeat", "failure-transition", "readiness", "startup", "shutdown"]),
  outcome: new Set(["queued", "running", "failed", "completed", "success", "failure", "not-ready", "ready", "partial", "timed-out", "temporarily-unavailable"]),
  reason: new Set(["timeout", "chromium-crash", "concurrency-limit", "network-safety", "navigation", "rendered-error", "html-scan-error", "storage_error", "readiness-check", "lease-renewal-rejected", "lease-renewal-error", "completion-rejected", "failure-transition-rejected"])
};
function safeFields(fields) {
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (numericFields.has(key) && Number.isFinite(value) && value >= 0) safe[key] = value;
    else if (["requestId", "jobId", "auditId", "worker", "rpcId"].includes(key) && isCorrelationId(value)) safe[key] = value;
    else if (enumFields[key]?.has?.(value)) safe[key] = value;
    else if (key === "fallbackReason" && enumFields.reason.has(value)) safe[key] = value;
    else if (key === "errorCode" && typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)) safe[key] = safeErrorCode({ code: value }, "UNKNOWN_ERROR");
    else if (key === "route" && typeof value === "string" && /^\/(?:api\/(?:health|ready|operations|audits(?::id|\/:id|\/quota)?|audit-jobs\/:id|auth\/(?:config|register|login|logout|me)|unknown)|static)$/.test(value)) safe[key] = value;
  }
  return safe;
}

export function createAuditTelemetry({ enabled = true, write = console.log, now = () => new Date().toISOString() } = {}) {
  const counters = {
    auditTotal: 0,
    auditSuccess: 0,
    auditFailure: 0,
    renderedSuccess: 0,
    renderedFailure: 0,
    fallbackCount: 0,
    timeoutCount: 0,
    chromiumCrashCount: 0,
    concurrencyRejectionCount: 0,
    totalAuditDurationMs: 0,
    totalLighthouseDurationMs: 0
  };

  return {
    record(event, fields = {}) {
      if (["audit_completed", "audit.completed"].includes(event)) {
        counters.auditTotal += 1;
        counters.auditSuccess += 1;
        counters.totalAuditDurationMs += Number(fields.durationMs) || 0;
      } else if (["audit_failed", "audit.failed"].includes(event)) {
        counters.auditTotal += 1;
        counters.auditFailure += 1;
        counters.totalAuditDurationMs += Number(fields.durationMs) || 0;
      } else if (event === "rendered_completed") {
        counters.renderedSuccess += 1;
        counters.totalLighthouseDurationMs += Number(fields.lighthouseDurationMs) || 0;
      } else if (event === "html_fallback" || event === "rendered_fallback") {
        counters.fallbackCount += 1;
      } else if (event === "rendered_timeout") {
        counters.renderedFailure += 1;
        counters.timeoutCount += 1;
        counters.totalLighthouseDurationMs += Number(fields.lighthouseDurationMs) || 0;
      } else if (event === "rendered_crash") {
        counters.renderedFailure += 1;
        counters.chromiumCrashCount += 1;
        counters.totalLighthouseDurationMs += Number(fields.lighthouseDurationMs) || 0;
      } else if (event === "rendered_concurrency_rejected") {
        counters.renderedFailure += 1;
        counters.concurrencyRejectionCount += 1;
      } else if (event === "rendered_failure") {
        counters.renderedFailure += 1;
        counters.totalLighthouseDurationMs += Number(fields.lighthouseDurationMs) || 0;
      }

      const entry = { timestamp: now(), level: /failed|error|crash/.test(event) ? "error" : "info", type: "sitepulse.audit",
        event: /^[a-z][a-z0-9_.]{0,79}$/.test(event) ? event : "telemetry.invalid_event",
        ...safeFields({ ...logContext(), ...fields }) };

      if (enabled) {
        try { write(JSON.stringify(entry)); } catch { /* Logging failure must not change job or HTTP outcomes. */ }
      }

      return entry;
    },

    snapshot() {
      return { ...counters };
    }
  };
}
