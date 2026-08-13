import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { createAuditStore } from "../src/storage/audit-store.mjs";
import { createAuditJobStore } from "../src/storage/audit-job-store.mjs";
import { runMigrations } from "../src/storage/migrations.mjs";

const temporaryDirectories = [];

function testStore({ now = "2026-08-13T10:00:00.000Z", ids = [] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sitepulse-job-store-"));
  temporaryDirectories.push(directory);
  const databaseFilePath = join(directory, "sitepulse.sqlite");
  let currentTime = now;
  let nextId = 0;
  runMigrations(databaseFilePath);

  return {
    databaseFilePath,
    setTime(value) {
      currentTime = value;
    },
    store: createAuditJobStore(databaseFilePath, {
      clock: () => currentTime,
      idGenerator: () => ids[nextId++] || `id-${nextId}`,
      leaseTokenGenerator: () => ids[nextId++] || `lease-${nextId}`
    })
  };
}

function fakeAudit(domain = "example.com") {
  return {
    normalizedUrl: `https://${domain}`,
    domain,
    overallScore: 82,
    categories: [],
    recommendations: [],
    priorityFixes: [],
    improvements: [],
    signals: {},
    scanner: { mode: "html-real-checks", adapters: ["test"], checkedAt: "2026-08-13T10:00:00.000Z", warnings: [] },
    warnings: []
  };
}

function auditCount(databaseFilePath) {
  const database = new DatabaseSync(databaseFilePath);

  try {
    return database.prepare("SELECT COUNT(*) AS count FROM audits").get().count;
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("audit job store", () => {
  it("enqueues and finds a normalized queued job", () => {
    const { store } = testStore({ ids: ["job-1"] });

    const created = store.enqueue({ normalizedUrl: "https://example.com" });

    assert.deepEqual(created, {
      id: "job-1",
      status: "queued",
      normalizedUrl: "https://example.com",
      auditId: null,
      attemptCount: 0,
      maxAttempts: 2,
      availableAt: "2026-08-13T10:00:00.000Z",
      leaseExpiresAt: null,
      workerId: null,
      leaseToken: null,
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-08-13T10:00:00.000Z",
      updatedAt: "2026-08-13T10:00:00.000Z",
      startedAt: null,
      completedAt: null,
      failedAt: null
    });
    assert.deepEqual(store.findById("job-1"), created);
    assert.equal(store.findById("missing"), null);
  });

  it("claims the oldest eligible queued job and skips future work", () => {
    const fixture = testStore({ ids: ["future-job", "oldest-job", "lease-1"] });
    fixture.setTime("2026-08-13T10:01:00.000Z");
    fixture.store.enqueue({ normalizedUrl: "https://future.example.com" });
    fixture.setTime("2026-08-13T10:00:00.000Z");
    fixture.store.enqueue({ normalizedUrl: "https://oldest.example.com" });

    const claimed = fixture.store.claimNext({ workerId: "worker-1", leaseMs: 30_000 });

    assert.equal(claimed.id, "oldest-job");
    assert.equal(claimed.status, "running");
    assert.equal(claimed.attemptCount, 1);
    assert.equal(claimed.workerId, "worker-1");
    assert.equal(claimed.leaseToken, "lease-1");
    assert.equal(claimed.leaseExpiresAt, "2026-08-13T10:00:30.000Z");
    assert.equal(claimed.startedAt, "2026-08-13T10:00:00.000Z");
    assert.equal(fixture.store.claimNext({ workerId: "worker-2", leaseMs: 30_000 }), null);
  });

  it("fences a running job and renews its lease only for the current owner", () => {
    const fixture = testStore({ ids: ["job-1", "lease-1"] });
    fixture.store.enqueue({ normalizedUrl: "https://example.com" });
    const claimed = fixture.store.claimNext({ workerId: "worker-1", leaseMs: 30_000 });
    const secondStore = createAuditJobStore(fixture.databaseFilePath, {
      clock: () => "2026-08-13T10:00:05.000Z",
      leaseTokenGenerator: () => "lease-from-worker-2"
    });

    assert.equal(secondStore.claimNext({ workerId: "worker-2", leaseMs: 30_000 }), null);
    assert.deepEqual(
      secondStore.renewLease({ jobId: claimed.id, workerId: "worker-2", leaseToken: claimed.leaseToken, leaseMs: 30_000 }),
      { renewed: false, job: null }
    );
    assert.deepEqual(
      secondStore.renewLease({ jobId: claimed.id, workerId: "worker-1", leaseToken: "wrong-token", leaseMs: 30_000 }),
      { renewed: false, job: null }
    );

    const renewed = secondStore.renewLease({
      jobId: claimed.id,
      workerId: "worker-1",
      leaseToken: claimed.leaseToken,
      leaseMs: 30_000
    });

    assert.equal(renewed.renewed, true);
    assert.equal(renewed.job.leaseExpiresAt, "2026-08-13T10:00:35.000Z");
    assert.equal(renewed.job.leaseToken, "lease-1");
  });

  it("atomically creates an audit and completes its owned job", async () => {
    const fixture = testStore({ ids: ["job-1", "lease-1", "audit-1"] });
    fixture.store.enqueue({ normalizedUrl: "https://example.com" });
    const claimed = fixture.store.claimNext({ workerId: "worker-1", leaseMs: 30_000 });

    const completed = fixture.store.complete({
      jobId: claimed.id,
      workerId: "worker-1",
      leaseToken: claimed.leaseToken,
      audit: fakeAudit()
    });

    assert.equal(completed.completed, true);
    assert.equal(completed.job.status, "completed");
    assert.equal(completed.job.auditId, "audit-1");
    assert.equal(completed.job.completedAt, "2026-08-13T10:00:00.000Z");
    assert.equal(completed.job.workerId, null);
    assert.equal(completed.job.leaseToken, null);
    const storedAudit = await createAuditStore(fixture.databaseFilePath).findById("audit-1");
    assert.equal(storedAudit.id, "audit-1");
    assert.equal(storedAudit.domain, "example.com");
    assert.deepEqual(
      fixture.store.complete({
        jobId: claimed.id,
        workerId: "worker-1",
        leaseToken: claimed.leaseToken,
        audit: fakeAudit("duplicate.example.com")
      }),
      { completed: false, job: null, audit: null }
    );
    assert.equal(auditCount(fixture.databaseFilePath), 1);
  });

  it("rejects stale completion without leaving an orphan audit", () => {
    const fixture = testStore({ ids: ["job-1", "lease-1", "unused-audit-id"] });
    fixture.store.enqueue({ normalizedUrl: "https://example.com" });
    const claimed = fixture.store.claimNext({ workerId: "worker-1", leaseMs: 30_000 });

    const result = fixture.store.complete({
      jobId: claimed.id,
      workerId: "worker-1",
      leaseToken: "stale-token",
      audit: fakeAudit()
    });

    assert.deepEqual(result, { completed: false, job: null, audit: null });
    assert.equal(auditCount(fixture.databaseFilePath), 0);
    assert.equal(fixture.store.findById(claimed.id).status, "running");
  });

  it("requeues a retryable first failure, uses a fresh lease, and fails after attempt two", () => {
    const fixture = testStore({ ids: ["job-1", "lease-1", "lease-2"] });
    fixture.store.enqueue({ normalizedUrl: "https://example.com" });
    const firstClaim = fixture.store.claimNext({ workerId: "worker-1", leaseMs: 30_000 });

    assert.deepEqual(
      fixture.store.handleFailure({
        jobId: firstClaim.id,
        workerId: "wrong-worker",
        leaseToken: firstClaim.leaseToken,
        failure: { disposition: "retry", code: "TEMPORARY", message: "Temporary." }
      }),
      { transitioned: false, job: null }
    );

    const retry = fixture.store.handleFailure({
      jobId: firstClaim.id,
      workerId: "worker-1",
      leaseToken: firstClaim.leaseToken,
      failure: { disposition: "retry", code: "TEMPORARY_NETWORK_ERROR", message: "The website is temporarily unavailable." }
    });

    assert.equal(retry.transitioned, true);
    assert.equal(retry.job.status, "queued");
    assert.equal(retry.job.attemptCount, 1);
    assert.equal(retry.job.workerId, null);
    assert.equal(retry.job.errorCode, "TEMPORARY_NETWORK_ERROR");

    const secondClaim = fixture.store.claimNext({ workerId: "worker-2", leaseMs: 30_000 });
    assert.equal(secondClaim.attemptCount, 2);
    assert.equal(secondClaim.leaseToken, "lease-2");
    assert.notEqual(secondClaim.leaseToken, firstClaim.leaseToken);

    const exhausted = fixture.store.handleFailure({
      jobId: secondClaim.id,
      workerId: "worker-2",
      leaseToken: secondClaim.leaseToken,
      failure: { disposition: "retry", code: "AUDIT_TIMEOUT", message: "The audit timed out." }
    });

    assert.equal(exhausted.transitioned, true);
    assert.equal(exhausted.job.status, "failed");
    assert.equal(exhausted.job.attemptCount, 2);
    assert.equal(exhausted.job.failedAt, "2026-08-13T10:00:00.000Z");
  });

  it("fails a terminal error immediately and keeps terminal jobs immutable", () => {
    const fixture = testStore({ ids: ["job-1", "lease-1"] });
    fixture.store.enqueue({ normalizedUrl: "https://example.com" });
    const claimed = fixture.store.claimNext({ workerId: "worker-1", leaseMs: 30_000 });

    const failed = fixture.store.handleFailure({
      jobId: claimed.id,
      workerId: "worker-1",
      leaseToken: claimed.leaseToken,
      failure: { disposition: "fail", code: "UNSAFE_URL", message: "This destination cannot be audited." }
    });

    assert.equal(failed.job.status, "failed");
    assert.equal(failed.job.attemptCount, 1);
    assert.equal(failed.job.errorCode, "UNSAFE_URL");
    assert.deepEqual(
      fixture.store.handleFailure({
        jobId: claimed.id,
        workerId: "worker-1",
        leaseToken: claimed.leaseToken,
        failure: { disposition: "retry", code: "TEMPORARY", message: "Temporary." }
      }),
      { transitioned: false, job: null }
    );
    assert.deepEqual(
      fixture.store.complete({
        jobId: claimed.id,
        workerId: "worker-1",
        leaseToken: claimed.leaseToken,
        audit: fakeAudit()
      }),
      { completed: false, job: null, audit: null }
    );
    assert.equal(auditCount(fixture.databaseFilePath), 0);
  });

  it("recovers an expired first attempt to queued without decrementing attempts", () => {
    const fixture = testStore({ ids: ["job-1", "lease-1", "lease-2"] });
    fixture.store.enqueue({ normalizedUrl: "https://example.com" });
    const firstClaim = fixture.store.claimNext({ workerId: "worker-1", leaseMs: 30_000 });
    fixture.setTime("2026-08-13T10:00:31.000Z");

    const recovery = fixture.store.recoverExpired();
    const recovered = fixture.store.findById(firstClaim.id);

    assert.deepEqual(recovery, { requeued: 1, failed: 0 });
    assert.equal(recovered.status, "queued");
    assert.equal(recovered.attemptCount, 1);
    assert.equal(recovered.workerId, null);
    assert.equal(recovered.leaseToken, null);
    const secondClaim = fixture.store.claimNext({ workerId: "worker-2", leaseMs: 30_000 });
    assert.equal(secondClaim.attemptCount, 2);
    assert.equal(secondClaim.leaseToken, "lease-2");
  });

  it("fails an expired second attempt and does not recover completed or failed jobs", () => {
    const fixture = testStore({ ids: ["job-1", "lease-1", "lease-2", "terminal-job", "terminal-lease"] });
    fixture.store.enqueue({ normalizedUrl: "https://example.com" });
    const first = fixture.store.claimNext({ workerId: "worker-1", leaseMs: 1_000 });
    fixture.store.handleFailure({
      jobId: first.id,
      workerId: "worker-1",
      leaseToken: first.leaseToken,
      failure: { disposition: "retry", code: "TEMPORARY", message: "Temporary." }
    });
    const second = fixture.store.claimNext({ workerId: "worker-2", leaseMs: 1_000 });
    fixture.setTime("2026-08-13T10:00:02.000Z");

    const recovery = fixture.store.recoverExpired();
    const exhausted = fixture.store.findById(second.id);

    assert.deepEqual(recovery, { requeued: 0, failed: 1 });
    assert.equal(exhausted.status, "failed");
    assert.equal(exhausted.attemptCount, 2);
    assert.equal(exhausted.errorCode, "WORKER_LEASE_EXPIRED");
    assert.equal(exhausted.workerId, null);
    assert.deepEqual(fixture.store.recoverExpired(), { requeued: 0, failed: 0 });
  });
});
