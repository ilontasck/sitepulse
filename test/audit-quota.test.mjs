import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { AuditQuotaExceededError, createAuditJobStore } from "../src/storage/audit-job-store.mjs";
import { runMigrations } from "../src/storage/migrations.mjs";
import { createAuditStore } from "../src/storage/audit-store.mjs";

const userId = "11111111-1111-4111-8111-111111111111";
function fixture(plan = "free") {
  const file = join(mkdtempSync(join(tmpdir(), "noqori-quota-")), "db.sqlite");
  runMigrations(file);
  const db = new DatabaseSync(file);
  db.prepare(`INSERT INTO users
    (id,email_original,email_normalized,password_hash,created_at,updated_at,plan_code)
    VALUES (?, 'a@example.com','a@example.com', ?, ?, ?, ?)`)
    .run(userId, "x".repeat(64), "2026-09-20T12:00:00.000Z", "2026-09-20T12:00:00.000Z", plan);
  db.close();
  let n = 0;
  let currentTime = "2026-09-20T12:00:00.000Z";
  const store = createAuditJobStore(file, {
    clock: () => currentTime,
    idGenerator: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    leaseTokenGenerator: () => `lease-${n}`
  });
  return { file, store, setTime(value) { currentTime = value; } };
}

describe("monthly audit quota", () => {
  it("reserves each accepted free audit atomically and rejects the fourth", () => {
    const { store } = fixture();
    for (let i = 0; i < 3; i += 1) store.enqueue({ normalizedUrl: `https://${i}.example.com`, userId });
    assert.throws(() => store.enqueue({ normalizedUrl: "https://four.example.com", userId }), AuditQuotaExceededError);
    assert.deepEqual(store.quotaForUser(userId), {
      plan: "free",
      quota: { limit: 3, used: 3, remaining: 0,
        periodStart: "2026-09-01T00:00:00.000Z", resetsAt: "2026-10-01T00:00:00.000Z" },
      features: { renderedEligible: true, renderedAvailable: false, retention: "30 days" }
    });
  });

  it("refunds a terminal failure exactly once but keeps retry charged", () => {
    const { store } = fixture();
    const job = store.enqueue({ normalizedUrl: "https://example.com", userId });
    const claimed = store.claimNext({ workerId: "w", leaseMs: 1000 });
    const retry = store.handleFailure({ jobId: job.id, workerId: "w", leaseToken: claimed.leaseToken,
      failure: { disposition: "retry", code: "TEMPORARY", message: "Temporary." } });
    assert.equal(retry.job.status, "queued");
    assert.equal(store.quotaForUser(userId).quota.used, 1);
    const claimedAgain = store.claimNext({ workerId: "w", leaseMs: 1000 });
    store.handleFailure({ jobId: job.id, workerId: "w", leaseToken: claimedAgain.leaseToken,
      failure: { disposition: "fail", code: "FAILED", message: "Failed." } });
    assert.equal(store.quotaForUser(userId).quota.used, 0);
    assert.deepEqual(store.handleFailure({ jobId: job.id, workerId: "w", leaseToken: claimedAgain.leaseToken,
      failure: { disposition: "fail", code: "FAILED", message: "Failed." } }), { transitioned: false, job: null });
    assert.equal(store.quotaForUser(userId).quota.used, 0);
  });

  it("snapshots pro plan, applies calendar-year retention, and does not refund report deletion", async () => {
    const { file, store } = fixture("pro");
    const job = store.enqueue({ normalizedUrl: "https://example.com", userId });
    const db = new DatabaseSync(file);
    db.prepare("UPDATE users SET plan_code = 'free' WHERE id = ?").run(userId);
    db.close();
    const claimed = store.claimNext({ workerId: "w", leaseMs: 1000 });
    store.complete({ jobId: job.id, workerId: "w", leaseToken: claimed.leaseToken,
      audit: { normalizedUrl: "https://example.com", domain: "example.com", overallScore: 80, categories: [], recommendations: [], priorityFixes: [], improvements: [], signals: {}, scanner: { mode: "test", adapters: [], checkedAt: "2026-09-20T12:00:00.000Z", warnings: [] }, warnings: [] } });
    const verify = new DatabaseSync(file);
    assert.equal(verify.prepare("SELECT plan_code_snapshot FROM audit_jobs WHERE id=?").get(job.id).plan_code_snapshot, "pro");
    assert.equal(verify.prepare("SELECT expires_at FROM audits").get().expires_at, "2027-09-20T12:00:00.000Z");
    verify.close();
    assert.equal(store.quotaForUser(userId).quota.used, 1);
    assert.equal(await createAuditStore(file).softDeleteForUser("00000000-0000-4000-8000-000000000002", userId), true);
    assert.equal(store.quotaForUser(userId).quota.used, 1);
  });

  it("persists usage across store recreation and resets at the UTC month boundary", () => {
    const { file, store } = fixture();
    store.enqueue({ normalizedUrl: "https://example.com", userId });
    assert.equal(createAuditJobStore(file, { clock: () => "2026-09-30T23:59:59.999Z" }).quotaForUser(userId).quota.used, 1);
    const october = createAuditJobStore(file, { clock: () => "2026-10-01T00:00:00.000Z" });
    assert.deepEqual(october.quotaForUser(userId).quota, {
      limit: 3, used: 0, remaining: 3,
      periodStart: "2026-10-01T00:00:00.000Z", resetsAt: "2026-11-01T00:00:00.000Z"
    });
  });

  it("accepts 25 internal pro requests and rejects the 26th", () => {
    const { store } = fixture("pro");
    for (let index = 0; index < 25; index += 1) {
      store.enqueue({ normalizedUrl: `https://${index}.example.com`, userId });
    }
    assert.equal(store.quotaForUser(userId).quota.remaining, 0);
    assert.throws(() => store.enqueue({ normalizedUrl: "https://blocked.example.com", userId }), AuditQuotaExceededError);
  });

  it("allows exactly one concurrent reservation for the last slot", async () => {
    const { file, store } = fixture();
    store.enqueue({ normalizedUrl: "https://one.example.com", userId });
    store.enqueue({ normalizedUrl: "https://two.example.com", userId });
    const moduleUrl = new URL("../src/storage/audit-job-store.mjs", import.meta.url).href;
    const run = index => new Promise((resolve, reject) => {
      const worker = new Worker(`
        import { parentPort, workerData } from 'node:worker_threads';
        const { createAuditJobStore } = await import(workerData.moduleUrl);
        try {
          createAuditJobStore(workerData.file, { idGenerator: () => workerData.id }).enqueue({
            normalizedUrl: 'https://race.example.com', userId: workerData.userId
          });
          parentPort.postMessage('accepted');
        } catch (error) { parentPort.postMessage(error.name); }
      `, { eval: true, type: "module", workerData: { moduleUrl, file, userId,
        id: `00000000-0000-4000-8001-${String(index).padStart(12, "0")}` } });
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    const results = await Promise.all([run(1), run(2)]);
    assert.deepEqual(results.sort(), ["AuditQuotaExceededError", "accepted"]);
    assert.equal(store.quotaForUser(userId).quota.used, 3);
  });

  it("refunds once when an exhausted worker lease becomes terminal", () => {
    const { store, setTime } = fixture();
    store.enqueue({ normalizedUrl: "https://lease.example.com", userId });
    store.claimNext({ workerId: "w1", leaseMs: 1000 });
    setTime("2026-09-20T12:00:02.000Z");
    assert.deepEqual(store.recoverExpired(), { failed: 0, requeued: 1 });
    assert.equal(store.quotaForUser(userId).quota.used, 1);
    store.claimNext({ workerId: "w2", leaseMs: 1000 });
    setTime("2026-09-20T12:00:04.000Z");
    assert.deepEqual(store.recoverExpired(), { failed: 1, requeued: 0 });
    assert.equal(store.quotaForUser(userId).quota.used, 0);
    assert.deepEqual(store.recoverExpired(), { failed: 0, requeued: 0 });
    assert.equal(store.quotaForUser(userId).quota.used, 0);
  });
});
