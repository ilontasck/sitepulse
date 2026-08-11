import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAuditTelemetry } from "../src/telemetry/audit-telemetry.mjs";

describe("audit telemetry", () => {
  it("records beta counters and emits allowlisted structured fields only", () => {
    const lines = [];
    const telemetry = createAuditTelemetry({ write: (line) => lines.push(line), now: () => "2026-08-11T00:00:00.000Z" });

    telemetry.record("rendered_completed", { auditMode: "rendered", lighthouseDurationMs: 6400, outcome: "completed", token: "secret" });
    telemetry.record("rendered_timeout", { lighthouseDurationMs: 45000, reason: "timeout" });
    telemetry.record("rendered_crash", { reason: "chromium-crash" });
    telemetry.record("rendered_concurrency_rejected", { reason: "concurrency-limit" });
    telemetry.record("rendered_fallback", { fallbackReason: "timeout" });
    telemetry.record("audit_completed", { auditMode: "html", durationMs: 300, outcome: "success" });

    assert.deepEqual(telemetry.snapshot(), {
      auditTotal: 1,
      auditSuccess: 1,
      auditFailure: 0,
      renderedSuccess: 1,
      renderedFailure: 3,
      fallbackCount: 1,
      timeoutCount: 1,
      chromiumCrashCount: 1,
      concurrencyRejectionCount: 1,
      totalAuditDurationMs: 300,
      totalLighthouseDurationMs: 51400
    });
    assert.equal(JSON.parse(lines[0]).token, undefined);
    assert.equal(JSON.parse(lines[0]).type, "sitepulse.audit");
  });
});
