import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config/env.mjs";

process.env.AUTH_REGISTRATION_MODE = "closed";

describe("configuration", () => {
  it("keeps email capabilities disabled and fails closed for production dependencies",()=>{const base={NODE_ENV:"test",AUTH_REGISTRATION_MODE:"closed"};const config=loadConfig(base);assert.equal(config.transactionalEmailEnabled,false);assert.equal(config.emailVerificationRequired,false);assert.equal(config.auditEmailNotificationsEnabled,false);assert.throws(()=>loadConfig({NODE_ENV:"production",PUBLIC_ORIGIN:"https://example.test",LEGAL_PUBLICATION_READY:"true",AUTH_REGISTRATION_MODE:"closed",EMAIL_VERIFICATION_REQUIRED:"true"}),/TRANSACTIONAL_EMAIL_ENABLED/);const enabled=loadConfig({...base,TRANSACTIONAL_EMAIL_ENABLED:"true",EMAIL_VERIFICATION_REQUIRED:"true",AUDIT_EMAIL_NOTIFICATIONS_ENABLED:"true"});assert.equal(enabled.emailVerificationTtlMs,86400000);assert.equal(enabled.emailOutboxMaxAttempts,5)});
  const productionLegal = {
    LEGAL_PUBLICATION_READY: "true",
    LEGAL_OPERATOR_NAME: "Example Operator",
    LEGAL_OPERATOR_ADDRESS_LINE1: "Example Street 1",
    LEGAL_OPERATOR_POSTAL_CODE: "12345",
    LEGAL_OPERATOR_CITY: "Example City",
    LEGAL_OPERATOR_COUNTRY: "Germany",
    LEGAL_CONTACT_EMAIL: "legal@example.test",
    LEGAL_PUBLICATION_DATE: "2026-09-20",
    LEGAL_HOSTING_PROVIDER: "Example Hosting",
    LEGAL_HOSTING_COUNTRY: "Germany",
    LEGAL_SERVER_LOCATION: "Example Region",
    LEGAL_PROCESS_LOG_RETENTION: "30 days",
    LEGAL_AUDIT_REPORT_RETENTION: "90 days"
  };
  it("defaults production registration to closed and requires explicit non-production modes", () => {
    assert.equal(loadConfig({ AUTH_REGISTRATION_MODE: "closed" }).authRegistrationMode, "closed");
    assert.equal(loadConfig({ AUTH_REGISTRATION_MODE: "public" }).authRegistrationMode, "public");
    assert.throws(() => loadConfig({ AUTH_REGISTRATION_MODE: "invite" }), /AUTH_REGISTRATION_MODE/);
    assert.throws(() => loadConfig({ AUTH_REGISTRATION_MODE: "PUBLIC" }), /AUTH_REGISTRATION_MODE/);

    const configuredMode = process.env.AUTH_REGISTRATION_MODE;
    delete process.env.AUTH_REGISTRATION_MODE;
    try {
      assert.throws(() => loadConfig({ NODE_ENV: "development" }), /required in development and test/);
      assert.throws(() => loadConfig({ NODE_ENV: "test" }), /required in development and test/);
      assert.equal(loadConfig({
        NODE_ENV: "production",
        PUBLIC_ORIGIN: "https://sitepulse.example",
        ...productionLegal
      }).authRegistrationMode, "closed");
    } finally {
      process.env.AUTH_REGISTRATION_MODE = configuredMode;
    }
  });

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
    assert.equal(loadConfig({ NODE_ENV: "production", PUBLIC_ORIGIN: "https://sitepulse.example", ...productionLegal }).publicOrigin, "https://sitepulse.example");
    assert.throws(() => loadConfig({ PUBLIC_ORIGIN: "https://sitepulse.example/path" }), /PUBLIC_ORIGIN/);
    assert.throws(() => loadConfig({ PUBLIC_ORIGIN: "https://sitepulse.example?query=1" }), /PUBLIC_ORIGIN/);
    assert.throws(() => loadConfig({ PUBLIC_ORIGIN: "file:///tmp/sitepulse" }), /PUBLIC_ORIGIN/);
    assert.throws(() => loadConfig({ NODE_ENV: "production", PUBLIC_ORIGIN: "http://sitepulse.example", ...productionLegal }), /HTTPS/);
    assert.throws(() => loadConfig({ NODE_ENV: "production", PUBLIC_ORIGIN: "" }), /PUBLIC_ORIGIN/);
  });

  it("provides bounded beta auth rate-limit defaults", () => {
    const config = loadConfig();
    assert.equal(config.authRegisterRateLimitMax, 5);
    assert.equal(config.authRegisterRateLimitWindowMs, 3_600_000);
    assert.equal(config.authLoginRateLimitMax, 30);
    assert.equal(config.authLoginEmailRateLimitMax, 10);
    assert.equal(config.authLoginRateLimitWindowMs, 900_000);
    assert.equal(config.authGeneralRateLimitMax, 120);
    assert.equal(config.authGeneralRateLimitWindowMs, 60_000);
    assert.equal(config.auditUserRateLimitMax, 10);
    assert.equal(config.auditUserRateLimitWindowMs, 3_600_000);
    assert.throws(() => loadConfig({ AUTH_LOGIN_RATE_LIMIT_MAX: 0 }), /positive integer/);
    assert.throws(() => loadConfig({ AUTH_LOGIN_EMAIL_RATE_LIMIT_MAX: 0 }), /positive integer/);
    assert.throws(() => loadConfig({ AUDIT_USER_RATE_LIMIT_MAX: 0 }), /positive integer/);
  });

  it("keeps legal drafts usable but fails closed when publication is asserted without required values", () => {
    const draft = loadConfig({ LEGAL_PUBLICATION_READY: "false" });
    assert.equal(draft.legal.publicationReady, false);
    assert.equal(draft.legal.operatorName, "");
    assert.equal(draft.legal.missingRequiredFields.includes("LEGAL_AUDIT_REPORT_RETENTION"), true);
    assert.throws(
      () => loadConfig({ LEGAL_PUBLICATION_READY: "true" }),
      /LEGAL_PUBLICATION_READY requires.*LEGAL_OPERATOR_NAME.*LEGAL_AUDIT_REPORT_RETENTION/
    );
    assert.throws(
      () => loadConfig({ LEGAL_PUBLICATION_READY: "sometimes" }),
      /LEGAL_PUBLICATION_READY must be true or false/
    );
    assert.throws(
      () => loadConfig({ NODE_ENV: "production", PUBLIC_ORIGIN: "https://sitepulse.example" }),
      /Production requires LEGAL_PUBLICATION_READY=true/
    );
  });

  it("validates legal field formats and optional register pairs", () => {
    assert.throws(() => loadConfig({ LEGAL_CONTACT_EMAIL: "not-an-email" }), /LEGAL_CONTACT_EMAIL/);
    assert.throws(() => loadConfig({ LEGAL_PUBLICATION_DATE: "20 September 2026" }), /LEGAL_PUBLICATION_DATE/);
    assert.throws(() => loadConfig({ LEGAL_PUBLICATION_DATE: "2026-02-30" }), /LEGAL_PUBLICATION_DATE/);
    assert.throws(() => loadConfig({ LEGAL_REGISTER_NAME: "Register", LEGAL_REGISTER_NUMBER: "" }), /provided together/);
    assert.doesNotThrow(() => loadConfig({
      LEGAL_REGISTER_NAME: "Register",
      LEGAL_REGISTER_NUMBER: "EX 123"
    }));
  });

  it("configures bounded periodic data-retention cleanup", () => {
    const config = loadConfig({ DATA_RETENTION_CLEANUP_INTERVAL_MS: 7_200_000, DATA_RETENTION_CLEANUP_BATCH_SIZE: 25 });
    assert.equal(config.dataRetentionCleanupIntervalMs, 7_200_000);
    assert.equal(config.dataRetentionCleanupBatchSize, 25);
    assert.throws(() => loadConfig({ DATA_RETENTION_CLEANUP_INTERVAL_MS: 0 }), /positive integer/);
    assert.throws(() => loadConfig({ DATA_RETENTION_CLEANUP_BATCH_SIZE: 0 }), /positive integer/);
  });
});
