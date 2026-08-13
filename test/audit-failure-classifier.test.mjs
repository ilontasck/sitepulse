import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyAuditFailure } from "../src/audit/audit-failure-classifier.mjs";
import { HttpError } from "../src/http/http-error.mjs";

describe("audit failure classifier", () => {
  it("fails deterministic validation and security errors without exposing raw details", () => {
    for (const code of [
      "URL_REQUIRED",
      "URL_TOO_LONG",
      "INVALID_URL",
      "INVALID_PUBLIC_DOMAIN",
      "UNSUPPORTED_URL_PROTOCOL",
      "UNSAFE_URL",
      "UNSAFE_REDIRECT",
      "SSRF_BLOCKED",
      "NETWORK_POLICY_REJECTED",
      "TOO_MANY_REDIRECTS",
      "HTML_TOO_LARGE",
      "NON_HTML_RESPONSE"
    ]) {
      const error = new HttpError(400, "private raw detail /Users/person/token=secret", code);
      const result = classifyAuditFailure(error, { phase: "worker" });

      assert.equal(result.disposition, "fail", code);
      assert.equal(result.code, code);
      assert.doesNotMatch(result.message, /Users|token|secret/i);
    }
  });

  it("retries known transient worker failures", () => {
    for (const code of [
      "SCAN_TIMEOUT",
      "AUDIT_TIMEOUT",
      "EAI_AGAIN",
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "HOSTNAME_NOT_RESOLVED",
      "CHROMIUM_CRASH",
      "BROWSER_CRASH",
      "RENDERED_CONCURRENCY_LIMIT",
      "SQLITE_BUSY"
    ]) {
      const result = classifyAuditFailure(Object.assign(new Error("raw infrastructure failure"), { code }), { phase: "worker" });
      assert.equal(result.disposition, "retry", code);
      assert.equal(result.code, code);
      assert.doesNotMatch(result.message, /raw infrastructure/i);
    }
  });

  it("classifies trusted browser failure types without parsing their messages", () => {
    const error = new Error("unstructured message that may change");
    error.name = "ChromiumCrashError";

    assert.deepEqual(classifyAuditFailure(error, { phase: "worker" }), {
      disposition: "retry",
      code: "CHROMIUM_CRASH",
      message: "The browser audit stopped unexpectedly."
    });
  });

  it("does not retry transient DNS preflight failures before enqueue", () => {
    const result = classifyAuditFailure(Object.assign(new Error("dns"), { code: "HOSTNAME_NOT_RESOLVED" }), { phase: "preflight" });

    assert.deepEqual(result, {
      disposition: "fail",
      code: "HOSTNAME_NOT_RESOLVED",
      message: "The website hostname could not be resolved safely."
    });
  });

  it("fails unknown exceptions with a stable safe result", () => {
    const error = new Error("database password=hunter2 at /Users/person/project");
    error.stack = "very secret stack";

    assert.deepEqual(classifyAuditFailure(error, { phase: "worker" }), {
      disposition: "fail",
      code: "AUDIT_FAILED",
      message: "The website could not be audited. Please try again."
    });
  });
});
