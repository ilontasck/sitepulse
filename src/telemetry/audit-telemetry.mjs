const allowedFields = new Set(["auditMode", "durationMs", "lighthouseDurationMs", "outcome", "fallbackReason", "reason"]);

function safeFields(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) => allowedFields.has(key) && ["string", "number", "boolean"].includes(typeof value)));
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
      if (event === "audit_completed") {
        counters.auditTotal += 1;
        counters.auditSuccess += 1;
        counters.totalAuditDurationMs += Number(fields.durationMs) || 0;
      } else if (event === "audit_failed") {
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

      const entry = { timestamp: now(), type: "sitepulse.audit", event, ...safeFields(fields) };

      if (enabled) {
        write(JSON.stringify(entry));
      }

      return entry;
    },

    snapshot() {
      return { ...counters };
    }
  };
}
