import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createAuditJobWorker } from "../src/audit/audit-job-worker.mjs";
import { HttpError } from "../src/http/http-error.mjs";
import { createAuditJobStore } from "../src/storage/audit-job-store.mjs";
import { createAuditStore } from "../src/storage/audit-store.mjs";
import { runMigrations } from "../src/storage/migrations.mjs";

function auditResult() {
  return {
    normalizedUrl: "https://example.com",
    domain: "example.com",
    overallScore: 82,
    categories: [],
    scanner: { mode: "html-real-checks", adapters: ["test"] }
  };
}

function runningJob(overrides = {}) {
  return {
    id: "job-1",
    status: "running",
    normalizedUrl: "https://example.com",
    attemptCount: 1,
    maxAttempts: 2,
    leaseToken: "lease-1",
    ...overrides
  };
}

function fakeJobStore({ job = runningJob(), completion = true } = {}) {
  const calls = { recover: 0, claim: 0, renew: 0, complete: [], failures: [] };
  let lastClaimed = null;

  return {
    calls,
    recoverExpired() {
      calls.recover += 1;
      return { requeued: 0, failed: 0 };
    },
    claimNext() {
      calls.claim += 1;
      const claimed = job;
      job = null;
      lastClaimed = claimed;
      return claimed;
    },
    renewLease() {
      calls.renew += 1;
      return { renewed: true, job: runningJob() };
    },
    complete(input) {
      calls.complete.push(input);
      return completion
        ? { completed: true, job: { ...runningJob(), status: "completed", auditId: "audit-1" }, audit: { id: "audit-1", ...input.audit } }
        : { completed: false, job: null, audit: null };
    },
    handleFailure(input) {
      calls.failures.push(input);
      const status = input.failure.disposition === "retry" && lastClaimed?.attemptCount < lastClaimed?.maxAttempts ? "queued" : "failed";
      return { transitioned: true, job: { ...runningJob(), status } };
    }
  };
}

function workerWith(store, overrides = {}) {
  return createAuditJobWorker({
    jobStore: store,
    auditGenerator: async () => auditResult(),
    securityValidator: async () => true,
    renderedAuditLimiter: { run: (task) => task() },
    telemetry: { record() {} },
    workerId: "worker-1",
    leaseMs: 30_000,
    heartbeatMs: 10_000,
    pollIntervalMs: 1,
    ...overrides
  });
}

describe("audit job worker", () => {
  it("recovers, claims, validates, generates, and completes one job", async () => {
    const store = fakeJobStore();
    const generated = [];
    const worker = workerWith(store, {
      auditGenerator: async (url, options) => {
        generated.push({ url, options });
        return auditResult();
      }
    });

    const result = await worker.runOnce();

    assert.equal(store.calls.recover, 1);
    assert.equal(store.calls.claim, 1);
    assert.equal(generated[0].url, "https://example.com");
    assert.equal(generated[0].options.renderedAuditLimiter !== undefined, true);
    assert.equal(store.calls.complete.length, 1);
    assert.equal(result.status, "completed");
    assert.equal(result.auditId, "audit-1");
  });

  it("returns idle without invoking the audit generator when no job exists", async () => {
    const store = fakeJobStore({ job: null });
    let generated = 0;
    const worker = workerWith(store, { auditGenerator: async () => { generated += 1; } });

    const result = await worker.runOnce();

    assert.equal(result.status, "idle");
    assert.equal(store.calls.recover, 1);
    assert.equal(generated, 0);
  });

  it("persists terminal and retryable failures using only safe classifier output", async () => {
    const terminalStore = fakeJobStore();
    const terminalWorker = workerWith(terminalStore, {
      securityValidator: async () => {
        throw new HttpError(400, "raw internal address and secret token", "UNSAFE_URL");
      }
    });
    const terminalResult = await terminalWorker.runOnce();

    assert.equal(terminalResult.status, "failed");
    assert.equal(terminalStore.calls.failures[0].failure.disposition, "fail");
    assert.equal(terminalStore.calls.failures[0].failure.code, "UNSAFE_URL");
    assert.doesNotMatch(terminalStore.calls.failures[0].failure.message, /raw|secret|token/i);

    const retryStore = fakeJobStore();
    const retryWorker = workerWith(retryStore, {
      auditGenerator: async () => {
        throw Object.assign(new Error("raw connection secret"), { code: "ECONNRESET" });
      }
    });
    const retryResult = await retryWorker.runOnce();

    assert.equal(retryResult.status, "queued");
    assert.equal(retryStore.calls.failures[0].failure.disposition, "retry");
    assert.doesNotMatch(retryStore.calls.failures[0].failure.message, /raw|secret/i);
  });

  it("fails unknown audit exceptions safely", async () => {
    const store = fakeJobStore();
    const worker = workerWith(store, {
      auditGenerator: async () => {
        const error = new Error("password=hunter2");
        error.stack = "private stack";
        throw error;
      }
    });

    await worker.runOnce();

    assert.deepEqual(store.calls.failures[0].failure, {
      disposition: "fail",
      code: "AUDIT_FAILED",
      message: "The website could not be audited. Please try again."
    });
  });

  it("fails a retryable exception when the claimed job is already on attempt two", async () => {
    const store = fakeJobStore({ job: runningJob({ attemptCount: 2 }) });
    const worker = workerWith(store, {
      auditGenerator: async () => {
        throw Object.assign(new Error("timeout internals"), { code: "AUDIT_TIMEOUT" });
      }
    });

    const result = await worker.runOnce();

    assert.equal(result.status, "failed");
    assert.equal(store.calls.failures[0].failure.disposition, "retry");
  });

  it("renews the lease without overlapping heartbeats and cleans the timer after success", async () => {
    const store = fakeJobStore();
    let intervalCallback;
    let cleared = 0;
    let finishRenewal;
    const renewalGate = new Promise((resolve) => { finishRenewal = resolve; });
    store.renewLease = async () => {
      store.calls.renew += 1;
      await renewalGate;
      return { renewed: true, job: runningJob() };
    };
    let finishAudit;
    const auditGate = new Promise((resolve) => { finishAudit = resolve; });
    const worker = workerWith(store, {
      auditGenerator: async () => {
        await auditGate;
        return auditResult();
      },
      setIntervalFn(callback) {
        intervalCallback = callback;
        return "timer-1";
      },
      clearIntervalFn(timer) {
        assert.equal(timer, "timer-1");
        cleared += 1;
      }
    });

    const running = worker.runOnce();
    await Promise.resolve();
    const firstHeartbeat = intervalCallback();
    await Promise.resolve();
    await intervalCallback();
    assert.equal(store.calls.renew, 1);
    finishRenewal();
    await firstHeartbeat;
    finishAudit();
    const result = await running;

    assert.equal(result.status, "completed");
    assert.equal(cleared, 1);
  });

  it("prevents persistence after heartbeat ownership loss and cleans the timer", async () => {
    const store = fakeJobStore();
    let intervalCallback;
    let cleared = 0;
    let finishAudit;
    const auditGate = new Promise((resolve) => { finishAudit = resolve; });
    store.renewLease = async () => {
      store.calls.renew += 1;
      return { renewed: false, job: null };
    };
    const worker = workerWith(store, {
      auditGenerator: async () => {
        await auditGate;
        return auditResult();
      },
      setIntervalFn(callback) {
        intervalCallback = callback;
        return "timer-1";
      },
      clearIntervalFn() {
        cleared += 1;
      }
    });

    const running = worker.runOnce();
    await Promise.resolve();
    await intervalCallback();
    finishAudit();
    const result = await running;

    assert.equal(result.status, "ownership-lost");
    assert.equal(store.calls.complete.length, 0);
    assert.equal(store.calls.failures.length, 0);
    assert.equal(cleared, 1);
  });

  it("cleans the heartbeat timer after an audit error", async () => {
    const store = fakeJobStore();
    let cleared = 0;
    const worker = workerWith(store, {
      auditGenerator: async () => {
        throw Object.assign(new Error("network"), { code: "ECONNRESET" });
      },
      setIntervalFn() {
        return "timer-1";
      },
      clearIntervalFn() {
        cleared += 1;
      }
    });

    await worker.runOnce();

    assert.equal(cleared, 1);
  });

  it("graceful stop during active work prevents another claim", async () => {
    const firstJob = runningJob({ id: "job-1" });
    const secondJob = runningJob({ id: "job-2", leaseToken: "lease-2" });
    const store = fakeJobStore({ job: firstJob });
    const originalClaim = store.claimNext;
    store.claimNext = () => {
      if (store.calls.claim === 0) return originalClaim();
      store.calls.claim += 1;
      return secondJob;
    };
    let worker;
    worker = workerWith(store, {
      auditGenerator: async () => {
        worker.stop();
        return auditResult();
      },
      sleep: async () => {}
    });

    const result = await worker.run();

    assert.equal(result.status, "stopped");
    assert.equal(store.calls.claim, 1);
    assert.equal(store.calls.complete.length, 1);
    assert.equal(worker.snapshot().activeJob, false);
  });

  it("integrates a queued SQLite job with a lightweight audit and persisted report", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sitepulse-worker-integration-"));
    const databaseFilePath = join(directory, "sitepulse.sqlite");
    const ids = ["job-1", "audit-1"];

    try {
      runMigrations(databaseFilePath);
      const jobStore = createAuditJobStore(databaseFilePath, {
        clock: () => "2026-08-13T10:00:00.000Z",
        idGenerator: () => ids.shift(),
        leaseTokenGenerator: () => "lease-1"
      });
      jobStore.enqueue({ normalizedUrl: "https://example.com" });
      const worker = workerWith(jobStore);

      const result = await worker.runOnce();
      const completedJob = jobStore.findById("job-1");
      const audit = await createAuditStore(databaseFilePath).findById("audit-1");

      assert.deepEqual(result, { status: "completed", jobId: "job-1", auditId: "audit-1" });
      assert.equal(completedJob.status, "completed");
      assert.equal(completedJob.auditId, "audit-1");
      assert.equal(audit.domain, "example.com");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
