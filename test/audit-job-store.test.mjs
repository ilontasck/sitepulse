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
const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";

function insertTestUser(databaseFilePath, userId, email) {
  const database = new DatabaseSync(databaseFilePath);

  try {
    const now = "2026-08-13T10:00:00.000Z";
    database.prepare(`
      INSERT INTO users (
        id, email_original, email_normalized, password_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, email, email, "x".repeat(64), now, now);
  } finally {
    database.close();
  }
}

function enqueue(store, normalizedUrl, userId = TEST_USER_ID) {
  return store.enqueue({ normalizedUrl, userId });
}

function testStore({ now = "2026-08-13T10:00:00.000Z", ids = [] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sitepulse-job-store-"));
  temporaryDirectories.push(directory);
  const databaseFilePath = join(directory, "sitepulse.sqlite");
  let currentTime = now;
  let nextId = 0;
  runMigrations(databaseFilePath);
  insertTestUser(databaseFilePath, TEST_USER_ID, "owner@example.com");
  insertTestUser(databaseFilePath, OTHER_USER_ID, "other@example.com");

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

    const created = enqueue(store, "https://example.com");

    assert.deepEqual(created, {
      id: "job-1",
      status: "queued",
      normalizedUrl: "https://example.com",
      userId: TEST_USER_ID,
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
    assert.deepEqual(store.findByIdForUser("job-1", TEST_USER_ID), created);
    assert.equal(store.findByIdForUser("job-1", OTHER_USER_ID), null);
    assert.equal(store.findById("missing"), null);
  });

  it("requires a valid persisted user owner for every new job", () => {
    const { store } = testStore({ ids: ["job-1", "job-2", "job-3"] });

    assert.throws(() => store.enqueue({ normalizedUrl: "https://example.com" }), /userId/i);
    assert.throws(
      () => store.enqueue({ normalizedUrl: "https://example.com", userId: "not-a-uuid" }),
      /userId/i
    );
    assert.throws(
      () => store.enqueue({
        normalizedUrl: "https://example.com",
        userId: "33333333-3333-4333-8333-333333333333"
      }),
      /foreign key constraint/i
    );
  });

  it("claims the oldest eligible queued job and skips future work", () => {
    const fixture = testStore({ ids: ["future-job", "oldest-job", "lease-1"] });
    fixture.setTime("2026-08-13T10:01:00.000Z");
    enqueue(fixture.store, "https://future.example.com");
    fixture.setTime("2026-08-13T10:00:00.000Z");
    enqueue(fixture.store, "https://oldest.example.com");

    const claimed = fixture.store.claimNext({ workerId: "worker-1", leaseMs: 30_000 });

    assert.equal(claimed.id, "oldest-job");
    assert.equal(claimed.status, "running");
    assert.equal(claimed.attemptCount, 1);
    assert.equal(claimed.workerId, "worker-1");
    assert.equal(claimed.leaseToken, "lease-1");
    assert.equal(claimed.leaseExpiresAt, "2026-08-13T10:00:30.000Z");
    assert.equal(claimed.startedAt, "2026-08-13T10:00:00.000Z");
    assert.equal(claimed.userId, TEST_USER_ID);
    assert.equal(fixture.store.claimNext({ workerId: "worker-2", leaseMs: 30_000 }), null);
  });

  it("fences a running job and renews its lease only for the current owner", () => {
    const fixture = testStore({ ids: ["job-1", "lease-1"] });
    enqueue(fixture.store, "https://example.com");
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
    enqueue(fixture.store, "https://example.com");
    const claimed = fixture.store.claimNext({ workerId: "worker-1", leaseMs: 30_000 });

    const completed = fixture.store.complete({
      jobId: claimed.id,
      workerId: "worker-1",
      leaseToken: claimed.leaseToken,
      userId: OTHER_USER_ID,
      audit: { ...fakeAudit(), userId: OTHER_USER_ID }
    });

    assert.equal(completed.completed, true);
    assert.equal(completed.job.status, "completed");
    assert.equal(completed.job.auditId, "audit-1");
    assert.equal(completed.job.completedAt, "2026-08-13T10:00:00.000Z");
    assert.equal(completed.job.workerId, null);
    assert.equal(completed.job.leaseToken, null);
    assert.equal(completed.job.userId, TEST_USER_ID);
    const storedAudit = await createAuditStore(fixture.databaseFilePath).findById("audit-1");
    assert.equal(storedAudit.id, "audit-1");
    assert.equal(storedAudit.domain, "example.com");
    const database = new DatabaseSync(fixture.databaseFilePath);
    const relationalAudit = database.prepare("SELECT user_id, report_json FROM audits WHERE id = ?").get("audit-1");
    database.close();
    assert.equal(relationalAudit.user_id, TEST_USER_ID);
    assert.equal(JSON.parse(relationalAudit.report_json).userId, undefined);
    assert.equal(await createAuditStore(fixture.databaseFilePath).findByIdForUser("audit-1", TEST_USER_ID) !== null, true);
    assert.equal(await createAuditStore(fixture.databaseFilePath).findByIdForUser("audit-1", OTHER_USER_ID), null);
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
    enqueue(fixture.store, "https://example.com");
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
    enqueue(fixture.store, "https://example.com");
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
    assert.equal(retry.job.userId, TEST_USER_ID);

    const secondClaim = fixture.store.claimNext({ workerId: "worker-2", leaseMs: 30_000 });
    assert.equal(secondClaim.attemptCount, 2);
    assert.equal(secondClaim.leaseToken, "lease-2");
    assert.notEqual(secondClaim.leaseToken, firstClaim.leaseToken);
    assert.equal(secondClaim.userId, TEST_USER_ID);

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
    enqueue(fixture.store, "https://example.com");
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
    enqueue(fixture.store, "https://example.com");
    const firstClaim = fixture.store.claimNext({ workerId: "worker-1", leaseMs: 30_000 });
    fixture.setTime("2026-08-13T10:00:31.000Z");

    const recovery = fixture.store.recoverExpired();
    const recovered = fixture.store.findById(firstClaim.id);

    assert.deepEqual(recovery, { requeued: 1, failed: 0 });
    assert.equal(recovered.status, "queued");
    assert.equal(recovered.attemptCount, 1);
    assert.equal(recovered.workerId, null);
    assert.equal(recovered.leaseToken, null);
    assert.equal(recovered.userId, TEST_USER_ID);
    const secondClaim = fixture.store.claimNext({ workerId: "worker-2", leaseMs: 30_000 });
    assert.equal(secondClaim.attemptCount, 2);
    assert.equal(secondClaim.leaseToken, "lease-2");
  });

  it("fails an expired second attempt and does not recover completed or failed jobs", () => {
    const fixture = testStore({ ids: ["job-1", "lease-1", "lease-2", "terminal-job", "terminal-lease"] });
    enqueue(fixture.store, "https://example.com");
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
