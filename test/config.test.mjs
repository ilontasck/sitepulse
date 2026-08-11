import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config/env.mjs";

describe("configuration", () => {
  it("rejects invalid resource and rate-limit values", () => {
    assert.throws(() => loadConfig({ REQUEST_BODY_LIMIT_BYTES: "unlimited" }), /positive integer/);
    assert.throws(() => loadConfig({ RATE_LIMIT_WINDOW_MS: 0 }), /positive integer/);
    assert.throws(() => loadConfig({ RATE_LIMIT_MAX: -1 }), /positive integer/);
  });

  it("keeps rendered audits off by default and validates their settings", () => {
    assert.equal(loadConfig().renderedAuditEnabled, false);
    assert.equal(loadConfig().renderedAuditMaxConcurrency, 1);
    assert.equal(loadConfig().telemetryEnabled, true);
    assert.equal(loadConfig({ RENDERED_AUDIT_ENABLED: "true" }).renderedAuditEnabled, true);
    assert.throws(() => loadConfig({ RENDERED_AUDIT_ENABLED: "sometimes" }), /true or false/);
    assert.throws(() => loadConfig({ RENDERED_AUDIT_TIMEOUT_MS: 0 }), /positive integer/);
    assert.throws(() => loadConfig({ RENDERED_AUDIT_MAX_CONCURRENCY: 0 }), /positive integer/);
    assert.throws(() => loadConfig({ TELEMETRY_ENABLED: "verbose" }), /true or false/);
  });
});
