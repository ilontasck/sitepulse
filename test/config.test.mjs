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

  it("validates worker polling and keeps heartbeat shorter than the lease", () => {
    const config = loadConfig();

    assert.equal(config.auditWorkerPollIntervalMs, 500);
    assert.equal(config.auditJobLeaseMs, 30_000);
    assert.equal(config.auditJobHeartbeatMs, 10_000);
    assert.throws(() => loadConfig({ AUDIT_WORKER_POLL_INTERVAL_MS: 0 }), /positive integer/);
    assert.throws(() => loadConfig({ AUDIT_JOB_LEASE_MS: "soon" }), /positive integer/);
    assert.throws(
      () => loadConfig({ AUDIT_JOB_LEASE_MS: 10_000, AUDIT_JOB_HEARTBEAT_MS: 10_000 }),
      /shorter than AUDIT_JOB_LEASE_MS/
    );
  });

  it("bounds closed-beta scrypt concurrency", () => {
    assert.equal(loadConfig().authScryptMaxConcurrency, 1);
    assert.equal(loadConfig({ AUTH_SCRYPT_MAX_CONCURRENCY: 4 }).authScryptMaxConcurrency, 4);
    assert.throws(() => loadConfig({ AUTH_SCRYPT_MAX_CONCURRENCY: 0 }), /positive integer/);
    assert.throws(() => loadConfig({ AUTH_SCRYPT_MAX_CONCURRENCY: 5 }), /at most 4/);
  });

  it("validates and normalizes the trusted public origin", () => {
    assert.equal(loadConfig({ PUBLIC_ORIGIN: "http://localhost:3000/" }).publicOrigin, "http://localhost:3000");
    assert.equal(loadConfig({ NODE_ENV: "production", PUBLIC_ORIGIN: "https://sitepulse.example" }).publicOrigin, "https://sitepulse.example");
    assert.throws(() => loadConfig({ PUBLIC_ORIGIN: "https://sitepulse.example/path" }), /PUBLIC_ORIGIN/);
    assert.throws(() => loadConfig({ PUBLIC_ORIGIN: "https://sitepulse.example?query=1" }), /PUBLIC_ORIGIN/);
    assert.throws(() => loadConfig({ PUBLIC_ORIGIN: "file:///tmp/sitepulse" }), /PUBLIC_ORIGIN/);
    assert.throws(() => loadConfig({ NODE_ENV: "production", PUBLIC_ORIGIN: "http://sitepulse.example" }), /HTTPS/);
    assert.throws(() => loadConfig({ NODE_ENV: "production", PUBLIC_ORIGIN: "" }), /PUBLIC_ORIGIN/);
  });

  it("provides bounded beta auth rate-limit defaults", () => {
    const config = loadConfig();
    assert.equal(config.authRegisterRateLimitMax, 5);
    assert.equal(config.authRegisterRateLimitWindowMs, 3_600_000);
    assert.equal(config.authLoginRateLimitMax, 30);
    assert.equal(config.authLoginRateLimitWindowMs, 900_000);
    assert.equal(config.authGeneralRateLimitMax, 120);
    assert.equal(config.authGeneralRateLimitWindowMs, 60_000);
    assert.throws(() => loadConfig({ AUTH_LOGIN_RATE_LIMIT_MAX: 0 }), /positive integer/);
  });
});
