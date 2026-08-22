import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveWorkerAuditExecution } from "../src/production/worker-audit-execution.mjs";

describe("production audit routing", () => {
  it("uses only the isolated runner and never loads the host-network generator", async () => {
    const calls = [];
    const runnerClient = {
      async checkReadiness() {
        calls.push("ready");
        return { ready: true, protocolVersion: 1, renderedAuditAllowed: false };
      },
      async generateAudit(url, options) {
        calls.push({ url, options });
        return { normalizedUrl: url, scanner: { mode: "isolated-runner" } };
      }
    };
    const execution = await resolveWorkerAuditExecution(
      { env: "production", auditRunnerSocketPath: "/run/noqori-audit.sock", renderedAuditEnabled: false },
      {
        runnerClient,
        async loadLocalAuditGenerator() {
          throw new Error("production loaded the host-network generator");
        }
      }
    );

    assert.deepEqual(await execution.executorReadiness(), { ready: true, protocolVersion: 1, renderedAuditAllowed: false });
    assert.equal((await execution.securityValidator("https://example.com")).normalizedUrl, "https://example.com");
    const audit = await execution.auditGenerator("https://example.com", { renderedAuditEnabled: false });
    assert.equal(audit.scanner.mode, "isolated-runner");
    assert.deepEqual(calls, [
      "ready",
      { url: "https://example.com", options: { renderedAuditEnabled: false } }
    ]);
  });

  it("keeps a rendered worker unready until the runner advertises root-attested acceptance", async () => {
    const execution = await resolveWorkerAuditExecution(
      { env: "production", auditRunnerSocketPath: "/run/noqori-audit.sock", renderedAuditEnabled: true },
      {
        runnerClient: {
          async checkReadiness() { return { ready: true, protocolVersion: 1, renderedAuditAllowed: false }; },
          async generateAudit() { throw new Error("must not run"); }
        },
        async loadLocalAuditGenerator() { throw new Error("must not load"); }
      }
    );
    assert.deepEqual(await execution.executorReadiness(), { ready: false });
  });
});
