import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { createAuditJobWorker } from "../src/audit/audit-job-worker.mjs";
import { loadConfig } from "../src/config/env.mjs";
import { createApp } from "../src/http/app.mjs";
import { createAuditJobStore } from "../src/storage/audit-job-store.mjs";
import { createAuditStore } from "../src/storage/audit-store.mjs";
import { runMigrations } from "../src/storage/migrations.mjs";

const temporaryDirectories = [];

function temporaryDatabase(prefix = "sitepulse-queue-resilience-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  const databaseFilePath = join(directory, "sitepulse.sqlite");
  runMigrations(databaseFilePath);
  return databaseFilePath;
}

function emptyTemporaryDatabase(prefix = "sitepulse-empty-resilience-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return join(directory, "sitepulse.sqlite");
}

function fakeAuditForUrl(normalizedUrl) {
  const domain = new URL(normalizedUrl).hostname;

  return {
    normalizedUrl,
    domain,
    overallScore: 82,
    categories: [],
    recommendations: [],
    priorityFixes: [],
    improvements: [],
    signals: {},
    scanner: {
      mode: "html-real-checks",
      adapters: ["resilience-fixture"],
      checkedAt: "2026-08-14T10:00:00.000Z",
      warnings: []
    },
    warnings: []
  };
}

function workerFor(jobStore, workerId, options = {}) {
  return createAuditJobWorker({
    jobStore,
    workerId,
    securityValidator: async () => true,
    auditGenerator: async (normalizedUrl) => fakeAuditForUrl(normalizedUrl),
    leaseMs: 30_000,
    heartbeatMs: 10_000,
    ...options
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

async function runSynchronizedWorkers(source, workerDataList) {
  const gateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const gate = new Int32Array(gateBuffer);
  let readyCount = 0;
  const workers = workerDataList.map((workerData) => new Worker(source, {
    eval: true,
    workerData: { ...workerData, gateBuffer }
  }));
  const results = workers.map((worker) => new Promise((resolve, reject) => {
    let settled = false;

    worker.on("message", (message) => {
      if (message.type === "ready") {
        readyCount += 1;

        if (readyCount === workers.length) {
          Atomics.store(gate, 1, 1);
          Atomics.notify(gate, 1, workers.length);
        }

        return;
      }

      if (message.type === "result") {
        settled = true;
        resolve(message.value);
      } else if (message.type === "error") {
        settled = true;
        reject(Object.assign(new Error(message.message), { code: message.code }));
      }
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (!settled) reject(new Error(`Resilience worker exited before returning a result (code ${code}).`));
    });
  }));

  try {
    return await Promise.all(results);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

function holdShortWriteLock(databaseFilePath, milliseconds) {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(workerData.databaseFilePath);
    database.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
    parentPort.postMessage({ type: "locked" });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.milliseconds);
    database.exec("COMMIT;");
    database.close();
    parentPort.postMessage({ type: "released" });
  `, {
    eval: true,
    workerData: { databaseFilePath, milliseconds }
  });
  const locked = deferred();
  const released = deferred();

  worker.on("message", (message) => {
    if (message.type === "locked") locked.resolve();
    if (message.type === "released") released.resolve();
  });
  worker.on("error", (error) => {
    locked.reject(error);
    released.reject(error);
  });

  return {
    locked: locked.promise,
    async released() {
      await released.promise;
      await worker.terminate();
    }
  };
}

function inspectDatabase(databaseFilePath, callback) {
  const database = new DatabaseSync(databaseFilePath);

  try {
    database.exec("PRAGMA foreign_keys = ON;");
    return callback(database);
  } finally {
    database.close();
  }
}

function assertDatabaseInvariants(databaseFilePath, { expectEveryAuditLinked = true } = {}) {
  const violations = inspectDatabase(databaseFilePath, (database) => ({
    completedWithoutAudit: database.prepare("SELECT COUNT(*) AS count FROM audit_jobs WHERE status = 'completed' AND audit_id IS NULL").get().count,
    failedWithAudit: database.prepare("SELECT COUNT(*) AS count FROM audit_jobs WHERE status = 'failed' AND audit_id IS NOT NULL").get().count,
    queuedWithOwnership: database.prepare(`
      SELECT COUNT(*) AS count FROM audit_jobs
      WHERE status = 'queued' AND (worker_id IS NOT NULL OR lease_token IS NOT NULL OR lease_expires_at IS NOT NULL)
    `).get().count,
    runningWithoutOwnership: database.prepare(`
      SELECT COUNT(*) AS count FROM audit_jobs
      WHERE status = 'running' AND (worker_id IS NULL OR lease_token IS NULL OR lease_expires_at IS NULL)
    `).get().count,
    missingAuditReference: database.prepare(`
      SELECT COUNT(*) AS count
      FROM audit_jobs AS jobs
      LEFT JOIN audits ON audits.id = jobs.audit_id
      WHERE jobs.audit_id IS NOT NULL AND audits.id IS NULL
    `).get().count,
    duplicateAuditLinks: database.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT audit_id FROM audit_jobs WHERE audit_id IS NOT NULL GROUP BY audit_id HAVING COUNT(*) > 1
      )
    `).get().count,
    unlinkedAudits: database.prepare(`
      SELECT COUNT(*) AS count
      FROM audits
      LEFT JOIN audit_jobs AS jobs ON jobs.audit_id = audits.id
      WHERE jobs.id IS NULL
    `).get().count
  }));

  assert.equal(violations.completedWithoutAudit, 0);
  assert.equal(violations.failedWithAudit, 0);
  assert.equal(violations.queuedWithOwnership, 0);
  assert.equal(violations.runningWithoutOwnership, 0);
  assert.equal(violations.missingAuditReference, 0);
  assert.equal(violations.duplicateAuditLinks, 0);

  if (expectEveryAuditLinked) {
    assert.equal(violations.unlinkedAudits, 0);
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("audit queue resilience", () => {
  it("drains ten same-time jobs once in the current FIFO tie-break order", async () => {
    const databaseFilePath = temporaryDatabase();
    const queuedIds = Array.from({ length: 10 }, (_, index) => `job-${String(9 - index).padStart(2, "0")}`);
    const generatedIds = [...queuedIds];
    let auditNumber = 0;
    let leaseNumber = 0;
    const store = createAuditJobStore(databaseFilePath, {
      clock: () => "2026-08-14T10:00:00.000Z",
      idGenerator: () => generatedIds.shift() || `audit-${String(auditNumber += 1).padStart(2, "0")}`,
      leaseTokenGenerator: () => `lease-${leaseNumber += 1}`
    });
    const enqueued = Array.from({ length: 10 }, (_, index) =>
      store.enqueue({ normalizedUrl: `https://queue-${index}.example.com` })
    );
    const generatedUrls = [];
    const worker = workerFor(store, "worker-single", {
      auditGenerator: async (normalizedUrl) => {
        generatedUrls.push(normalizedUrl);
        return fakeAuditForUrl(normalizedUrl);
      }
    });
    const results = [];

    for (let index = 0; index < 10; index += 1) {
      results.push(await worker.runOnce());
    }

    const completedJobs = enqueued.map(({ id }) => store.findById(id));
    const auditIds = completedJobs.map(({ auditId }) => auditId);
    const storedAudits = await createAuditStore(databaseFilePath).list({ limit: 100 });

    assert.deepEqual(results.map(({ jobId }) => jobId), [...queuedIds].sort());
    assert.equal(new Set(generatedUrls).size, 10);
    assert.equal(generatedUrls.length, 10);
    assert.equal(completedJobs.every(({ status }) => status === "completed"), true);
    assert.equal(new Set(auditIds).size, 10);
    assert.equal(storedAudits.length, 10);
    assert.equal((await worker.runOnce()).status, "idle");
    assertDatabaseInvariants(databaseFilePath);
  });

  it("lets two worker cores drain ten jobs without duplicate claims or audits", async () => {
    const databaseFilePath = temporaryDatabase();
    const enqueueStore = createAuditJobStore(databaseFilePath);
    const enqueued = Array.from({ length: 10 }, (_, index) =>
      enqueueStore.enqueue({ normalizedUrl: `https://parallel-${index}.example.com` })
    );
    const generatorCalls = new Map();
    const auditGenerator = async (normalizedUrl) => {
      generatorCalls.set(normalizedUrl, (generatorCalls.get(normalizedUrl) || 0) + 1);
      await Promise.resolve();
      return fakeAuditForUrl(normalizedUrl);
    };
    const workerA = workerFor(createAuditJobStore(databaseFilePath), "worker-a", { auditGenerator });
    const workerB = workerFor(createAuditJobStore(databaseFilePath), "worker-b", { auditGenerator });
    const results = [];

    for (let round = 0; round < 5; round += 1) {
      results.push(...await Promise.all([workerA.runOnce(), workerB.runOnce()]));
    }

    const jobs = enqueued.map(({ id }) => enqueueStore.findById(id));
    const auditIds = jobs.map(({ auditId }) => auditId);
    const storedAudits = await createAuditStore(databaseFilePath).list({ limit: 100 });

    assert.equal(results.every(({ status }) => status === "completed"), true);
    assert.equal(new Set(results.map(({ jobId }) => jobId)).size, 10);
    assert.equal([...generatorCalls.values()].every((count) => count === 1), true);
    assert.equal(jobs.every(({ status }) => status === "completed"), true);
    assert.equal(new Set(auditIds).size, 10);
    assert.equal(storedAudits.length, 10);
    assert.equal((await workerA.runOnce()).status, "idle");
    assert.equal((await workerB.runOnce()).status, "idle");
    assertDatabaseInvariants(databaseFilePath);
  });

  it("recovers a crashed first attempt and fences its stale result", async () => {
    const databaseFilePath = temporaryDatabase();
    let now = "2026-08-14T10:00:00.000Z";
    const storeA = createAuditJobStore(databaseFilePath, {
      clock: () => now,
      idGenerator: () => "job-crash-1",
      leaseTokenGenerator: () => "lease-worker-a"
    });
    const queued = storeA.enqueue({ normalizedUrl: "https://crash.example.com" });
    const firstClaim = storeA.claimNext({ workerId: "worker-a", leaseMs: 30_000 });
    now = "2026-08-14T10:00:31.000Z";
    const storeB = createAuditJobStore(databaseFilePath, {
      clock: () => now,
      idGenerator: () => "audit-worker-b",
      leaseTokenGenerator: () => "lease-worker-b"
    });

    assert.deepEqual(storeB.recoverExpired(), { requeued: 1, failed: 0 });
    const secondClaim = storeB.claimNext({ workerId: "worker-b", leaseMs: 30_000 });
    const staleCompletion = storeA.complete({
      jobId: firstClaim.id,
      workerId: "worker-a",
      leaseToken: firstClaim.leaseToken,
      audit: fakeAuditForUrl(queued.normalizedUrl)
    });
    const completion = storeB.complete({
      jobId: secondClaim.id,
      workerId: "worker-b",
      leaseToken: secondClaim.leaseToken,
      audit: fakeAuditForUrl(queued.normalizedUrl)
    });
    const finalJob = storeB.findById(queued.id);
    const audits = await createAuditStore(databaseFilePath).list({ limit: 100 });

    assert.equal(firstClaim.attemptCount, 1);
    assert.equal(secondClaim.attemptCount, 2);
    assert.deepEqual(staleCompletion, { completed: false, job: null, audit: null });
    assert.equal(completion.completed, true);
    assert.equal(finalJob.status, "completed");
    assert.equal(finalJob.auditId, "audit-worker-b");
    assert.equal(audits.length, 1);
    assert.equal(audits[0].id, "audit-worker-b");
    assertDatabaseInvariants(databaseFilePath);
  });

  it("fails an expired second attempt without creating a third claim or audit", async () => {
    const databaseFilePath = temporaryDatabase();
    let now = "2026-08-14T10:00:00.000Z";
    let leaseNumber = 0;
    const store = createAuditJobStore(databaseFilePath, {
      clock: () => now,
      idGenerator: () => "job-crash-2",
      leaseTokenGenerator: () => `lease-${leaseNumber += 1}`
    });
    const queued = store.enqueue({ normalizedUrl: "https://double-crash.example.com" });
    const firstClaim = store.claimNext({ workerId: "worker-a", leaseMs: 1_000 });
    now = "2026-08-14T10:00:02.000Z";
    assert.deepEqual(store.recoverExpired(), { requeued: 1, failed: 0 });
    const secondClaim = store.claimNext({ workerId: "worker-b", leaseMs: 1_000 });
    now = "2026-08-14T10:00:04.000Z";

    assert.deepEqual(store.recoverExpired(), { requeued: 0, failed: 1 });
    const finalJob = store.findById(queued.id);

    assert.equal(firstClaim.attemptCount, 1);
    assert.equal(secondClaim.attemptCount, 2);
    assert.equal(finalJob.status, "failed");
    assert.equal(finalJob.attemptCount, 2);
    assert.equal(finalJob.errorCode, "WORKER_LEASE_EXPIRED");
    assert.equal(finalJob.auditId, null);
    assert.equal(store.claimNext({ workerId: "worker-c", leaseMs: 1_000 }), null);
    assert.equal((await createAuditStore(databaseFilePath).list({ limit: 100 })).length, 0);
    assertDatabaseInvariants(databaseFilePath);
  });

  it("retries known transient network and browser failures once before completing", async () => {
    const transientCases = [
      { label: "EAI_AGAIN", code: "EAI_AGAIN" },
      { label: "ETIMEDOUT", code: "ETIMEDOUT" },
      { label: "ECONNRESET", code: "ECONNRESET" },
      { label: "CHROMIUM_CRASH", code: "CHROMIUM_CRASH" },
      { label: "typed Chromium crash", name: "ChromiumCrashError", expectedCode: "CHROMIUM_CRASH" }
    ];

    for (const failureCase of transientCases) {
      const databaseFilePath = temporaryDatabase(`sitepulse-retry-${failureCase.label.replaceAll(" ", "-")}-`);
      const store = createAuditJobStore(databaseFilePath);
      const queued = store.enqueue({ normalizedUrl: `https://${failureCase.label.toLowerCase().replaceAll("_", "-").replaceAll(" ", "-")}.example.com` });
      let generatorCalls = 0;
      const worker = workerFor(store, `worker-${failureCase.label}`, {
        auditGenerator: async (normalizedUrl) => {
          generatorCalls += 1;

          if (generatorCalls === 1) {
            const error = new Error(`raw secret from ${failureCase.label}`);
            error.stack = `private stack for ${failureCase.label}`;
            if (failureCase.code) error.code = failureCase.code;
            if (failureCase.name) error.name = failureCase.name;
            throw error;
          }

          return fakeAuditForUrl(normalizedUrl);
        }
      });

      const firstResult = await worker.runOnce();
      const retryJob = store.findById(queued.id);
      const secondResult = await worker.runOnce();
      const finalJob = store.findById(queued.id);

      assert.equal(firstResult.status, "queued", failureCase.label);
      assert.equal(retryJob.status, "queued", failureCase.label);
      assert.equal(retryJob.attemptCount, 1, failureCase.label);
      assert.equal(retryJob.errorCode, failureCase.expectedCode || failureCase.code, failureCase.label);
      assert.doesNotMatch(retryJob.errorMessage, /raw|secret|private stack/i, failureCase.label);
      assert.equal(secondResult.status, "completed", failureCase.label);
      assert.equal(finalJob.status, "completed", failureCase.label);
      assert.equal(finalJob.attemptCount, 2, failureCase.label);
      assert.equal(generatorCalls, 2, failureCase.label);
      assert.equal((await createAuditStore(databaseFilePath).list({ limit: 100 })).length, 1, failureCase.label);
      assertDatabaseInvariants(databaseFilePath);
    }
  });

  it("fails an exhausted retry with only classified safe error data", async () => {
    const databaseFilePath = temporaryDatabase();
    const store = createAuditJobStore(databaseFilePath);
    const queued = store.enqueue({ normalizedUrl: "https://exhausted.example.com" });
    const worker = workerFor(store, "worker-exhausted", {
      auditGenerator: async () => {
        const error = Object.assign(new Error("raw upstream token=secret"), { code: "ECONNRESET" });
        error.stack = "private infrastructure stack";
        throw error;
      }
    });

    assert.equal((await worker.runOnce()).status, "queued");
    assert.equal((await worker.runOnce()).status, "failed");
    const failedJob = store.findById(queued.id);

    assert.equal(failedJob.status, "failed");
    assert.equal(failedJob.attemptCount, 2);
    assert.equal(failedJob.errorCode, "ECONNRESET");
    assert.equal(failedJob.errorMessage, "The website connection was interrupted.");
    assert.doesNotMatch(JSON.stringify(failedJob), /raw upstream|token=secret|private infrastructure/i);
    assert.equal((await worker.runOnce()).status, "idle");
    assert.equal((await createAuditStore(databaseFilePath).list({ limit: 100 })).length, 0);
    assertDatabaseInvariants(databaseFilePath);
  });

  it("fails deterministic URL and security errors immediately without an audit", async () => {
    const terminalCodes = ["UNSAFE_URL", "UNSAFE_REDIRECT", "INVALID_URL", "UNSUPPORTED_URL_PROTOCOL"];

    for (const code of terminalCodes) {
      const databaseFilePath = temporaryDatabase(`sitepulse-terminal-${code.toLowerCase()}-`);
      const store = createAuditJobStore(databaseFilePath);
      const queued = store.enqueue({ normalizedUrl: `https://${code.toLowerCase().replaceAll("_", "-")}.example.com` });
      let generated = 0;
      const worker = workerFor(store, `worker-${code}`, {
        securityValidator: async () => {
          const error = Object.assign(new Error(`raw internal destination for ${code}`), { code });
          error.stack = `private security stack for ${code}`;
          throw error;
        },
        auditGenerator: async () => {
          generated += 1;
          return fakeAuditForUrl(queued.normalizedUrl);
        }
      });

      const result = await worker.runOnce();
      const failedJob = store.findById(queued.id);

      assert.equal(result.status, "failed", code);
      assert.equal(failedJob.status, "failed", code);
      assert.equal(failedJob.attemptCount, 1, code);
      assert.equal(failedJob.errorCode, code, code);
      assert.doesNotMatch(failedJob.errorMessage, /raw|internal destination|private security stack/i, code);
      assert.equal(generated, 0, code);
      assert.equal((await worker.runOnce()).status, "idle", code);
      assert.equal((await createAuditStore(databaseFilePath).list({ limit: 100 })).length, 0, code);
      assertDatabaseInvariants(databaseFilePath);
    }
  });

  it("keeps a long audit owned by renewing its lease before another worker recovers", async () => {
    const databaseFilePath = temporaryDatabase();
    let now = "2026-08-14T10:00:00.000Z";
    const storeA = createAuditJobStore(databaseFilePath, { clock: () => now });
    const storeB = createAuditJobStore(databaseFilePath, { clock: () => now });
    const queued = storeA.enqueue({ normalizedUrl: "https://long-running.example.com" });
    const auditStarted = deferred();
    const finishAudit = deferred();
    let heartbeatCallback;
    let clearedTimers = 0;
    const worker = workerFor(storeA, "worker-long-running", {
      auditGenerator: async (normalizedUrl) => {
        auditStarted.resolve();
        await finishAudit.promise;
        return fakeAuditForUrl(normalizedUrl);
      },
      setIntervalFn(callback) {
        heartbeatCallback = callback;
        return "heartbeat-long-running";
      },
      clearIntervalFn(timer) {
        assert.equal(timer, "heartbeat-long-running");
        clearedTimers += 1;
      }
    });

    const running = worker.runOnce();
    await auditStarted.promise;
    const initialLease = storeA.findById(queued.id).leaseExpiresAt;
    now = "2026-08-14T10:00:20.000Z";
    await heartbeatCallback();
    const renewedLease = storeA.findById(queued.id).leaseExpiresAt;
    now = "2026-08-14T10:00:31.000Z";
    const recovery = storeB.recoverExpired();
    const competingClaim = storeB.claimNext({ workerId: "worker-competing", leaseMs: 30_000 });
    finishAudit.resolve();
    const result = await running;
    const finalJob = storeA.findById(queued.id);

    assert.equal(initialLease, "2026-08-14T10:00:30.000Z");
    assert.equal(renewedLease, "2026-08-14T10:00:50.000Z");
    assert.deepEqual(recovery, { requeued: 0, failed: 0 });
    assert.equal(competingClaim, null);
    assert.equal(result.status, "completed");
    assert.equal(finalJob.status, "completed");
    assert.equal(finalJob.attemptCount, 1);
    assert.equal(clearedTimers, 1);
    assert.equal((await createAuditStore(databaseFilePath).list({ limit: 100 })).length, 1);
    assertDatabaseInvariants(databaseFilePath);
  });

  it("drops a stale result when heartbeat renewal loses ownership", async () => {
    const databaseFilePath = temporaryDatabase();
    const store = createAuditJobStore(databaseFilePath);
    const queued = store.enqueue({ normalizedUrl: "https://ownership-lost.example.com" });
    const auditStarted = deferred();
    const finishAudit = deferred();
    let heartbeatCallback;
    let clearedTimers = 0;
    const rejectingStore = {
      ...store,
      renewLease() {
        return { renewed: false, job: null };
      }
    };
    const worker = workerFor(rejectingStore, "worker-stale", {
      auditGenerator: async (normalizedUrl) => {
        auditStarted.resolve();
        await finishAudit.promise;
        return fakeAuditForUrl(normalizedUrl);
      },
      setIntervalFn(callback) {
        heartbeatCallback = callback;
        return "heartbeat-stale";
      },
      clearIntervalFn(timer) {
        assert.equal(timer, "heartbeat-stale");
        clearedTimers += 1;
      }
    });

    const running = worker.runOnce();
    await auditStarted.promise;
    await heartbeatCallback();
    finishAudit.resolve();
    const result = await running;
    const staleJob = store.findById(queued.id);

    assert.equal(result.status, "ownership-lost");
    assert.equal(staleJob.status, "running");
    assert.equal(staleJob.attemptCount, 1);
    assert.equal((await createAuditStore(databaseFilePath).list({ limit: 100 })).length, 0);
    assert.equal(clearedTimers, 1);
    assertDatabaseInvariants(databaseFilePath);
  });

  it("serializes concurrent enqueues from independent Node workers without losing jobs", async () => {
    const databaseFilePath = temporaryDatabase();
    const storeModuleUrl = new URL("../src/storage/audit-job-store.mjs", import.meta.url).href;
    const workerSource = `
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        try {
          const { createAuditJobStore } = await import(workerData.storeModuleUrl);
          const gate = new Int32Array(workerData.gateBuffer);
          Atomics.add(gate, 0, 1);
          parentPort.postMessage({ type: "ready" });
          Atomics.wait(gate, 1, 0);
          const store = createAuditJobStore(workerData.databaseFilePath);
          const ids = [];
          for (let index = 0; index < workerData.count; index += 1) {
            ids.push(store.enqueue({
              normalizedUrl: "https://enqueue-" + workerData.workerIndex + "-" + index + ".example.com"
            }).id);
          }
          parentPort.postMessage({ type: "result", value: ids });
        } catch (error) {
          parentPort.postMessage({ type: "error", message: error.message, code: error.code });
        }
      })();
    `;
    const results = await runSynchronizedWorkers(
      workerSource,
      Array.from({ length: 4 }, (_, workerIndex) => ({
        databaseFilePath,
        storeModuleUrl,
        workerIndex,
        count: 5
      }))
    );
    const ids = results.flat();
    const databaseState = inspectDatabase(databaseFilePath, (database) => ({
      queued: database.prepare("SELECT COUNT(*) AS count FROM audit_jobs WHERE status = 'queued'").get().count,
      total: database.prepare("SELECT COUNT(*) AS count FROM audit_jobs").get().count
    }));

    assert.equal(ids.length, 20);
    assert.equal(new Set(ids).size, 20);
    assert.equal(databaseState.total, 20);
    assert.equal(databaseState.queued, 20);
    assertDatabaseInvariants(databaseFilePath);
  });

  it("allows exactly one independent Node worker to claim a queued job", async () => {
    const databaseFilePath = temporaryDatabase();
    const store = createAuditJobStore(databaseFilePath);
    const queued = store.enqueue({ normalizedUrl: "https://atomic-claim.example.com" });
    const storeModuleUrl = new URL("../src/storage/audit-job-store.mjs", import.meta.url).href;
    const workerSource = `
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        try {
          const { createAuditJobStore } = await import(workerData.storeModuleUrl);
          const gate = new Int32Array(workerData.gateBuffer);
          Atomics.add(gate, 0, 1);
          parentPort.postMessage({ type: "ready" });
          Atomics.wait(gate, 1, 0);
          const job = createAuditJobStore(workerData.databaseFilePath).claimNext({
            workerId: workerData.workerId,
            leaseMs: 30000
          });
          parentPort.postMessage({ type: "result", value: job });
        } catch (error) {
          parentPort.postMessage({ type: "error", message: error.message, code: error.code });
        }
      })();
    `;
    const results = await runSynchronizedWorkers(
      workerSource,
      Array.from({ length: 8 }, (_, index) => ({
        databaseFilePath,
        storeModuleUrl,
        workerId: `claim-worker-${index}`
      }))
    );
    const claims = results.filter(Boolean);
    const runningJob = store.findById(queued.id);

    assert.equal(claims.length, 1);
    assert.equal(claims[0].id, queued.id);
    assert.equal(runningJob.status, "running");
    assert.equal(runningJob.attemptCount, 1);
    assert.equal(runningJob.workerId, claims[0].workerId);
    assert.equal(runningJob.leaseToken, claims[0].leaseToken);
    assertDatabaseInvariants(databaseFilePath);
  });

  it("waits through a short SQLite writer lock and commits audit completion atomically", async () => {
    const databaseFilePath = temporaryDatabase();
    const store = createAuditJobStore(databaseFilePath, {
      idGenerator: (() => {
        const ids = ["job-lock", "audit-lock"];
        return () => ids.shift();
      })(),
      leaseTokenGenerator: () => "lease-lock"
    });
    const queued = store.enqueue({ normalizedUrl: "https://writer-lock.example.com" });
    const claimed = store.claimNext({ workerId: "worker-lock", leaseMs: 30_000 });
    const lock = holdShortWriteLock(databaseFilePath, 150);
    await lock.locked;

    const completion = store.complete({
      jobId: claimed.id,
      workerId: "worker-lock",
      leaseToken: claimed.leaseToken,
      audit: fakeAuditForUrl(queued.normalizedUrl)
    });
    await lock.released();

    assert.equal(completion.completed, true);
    assert.equal(store.findById(queued.id).status, "completed");
    assert.equal((await createAuditStore(databaseFilePath).list({ limit: 100 })).length, 1);
    assertDatabaseInvariants(databaseFilePath);
  });

  it("applies migrations once when two fresh processes start concurrently", async () => {
    const databaseFilePath = emptyTemporaryDatabase();
    const migrationsModuleUrl = new URL("../src/storage/migrations.mjs", import.meta.url).href;
    const workerSource = `
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        try {
          const { runMigrations } = await import(workerData.migrationsModuleUrl);
          const gate = new Int32Array(workerData.gateBuffer);
          Atomics.add(gate, 0, 1);
          parentPort.postMessage({ type: "ready" });
          Atomics.wait(gate, 1, 0);
          const migrations = runMigrations(workerData.databaseFilePath);
          parentPort.postMessage({ type: "result", value: migrations });
        } catch (error) {
          parentPort.postMessage({ type: "error", message: error.message, code: error.code });
        }
      })();
    `;
    const results = await runSynchronizedWorkers(workerSource, [
      { databaseFilePath, migrationsModuleUrl },
      { databaseFilePath, migrationsModuleUrl }
    ]);
    const schema = inspectDatabase(databaseFilePath, (database) => ({
      migrations: database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
      auditsTable: database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'audits'").get().count,
      jobsTable: database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'audit_jobs'").get().count
    }));

    assert.deepEqual(results.map((rows) => rows.map(({ version }) => version)), [[1, 2], [1, 2]]);
    assert.deepEqual(schema.migrations.map(({ version }) => version), [1, 2]);
    assert.equal(schema.auditsTable, 1);
    assert.equal(schema.jobsTable, 1);
  });

  it("waits for a concurrent writer before initializing WAL on a fresh database", async () => {
    const databaseFilePath = emptyTemporaryDatabase();
    const lock = holdShortWriteLock(databaseFilePath, 150);
    await lock.locked;

    const migrations = runMigrations(databaseFilePath);
    await lock.released();

    assert.deepEqual(migrations.map(({ version }) => version), [1, 2]);
    const schemaVersions = inspectDatabase(databaseFilePath, (database) =>
      database.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version)
    );
    assert.deepEqual(schemaVersions, [1, 2]);
  });

  it("recovers persisted queued and expired work after a simulated process restart", async () => {
    const databaseFilePath = temporaryDatabase();
    let now = "2026-08-14T10:00:00.000Z";
    const originalIds = ["job-restart-1", "job-restart-2", "job-restart-3"];
    const storeBeforeRestart = createAuditJobStore(databaseFilePath, {
      clock: () => now,
      idGenerator: () => originalIds.shift(),
      leaseTokenGenerator: () => "lease-before-restart"
    });
    const queuedJobs = [
      storeBeforeRestart.enqueue({ normalizedUrl: "https://restart-1.example.com" }),
      storeBeforeRestart.enqueue({ normalizedUrl: "https://restart-2.example.com" }),
      storeBeforeRestart.enqueue({ normalizedUrl: "https://restart-3.example.com" })
    ];
    const abandonedClaim = storeBeforeRestart.claimNext({ workerId: "worker-before-restart", leaseMs: 1_000 });
    now = "2026-08-14T10:00:02.000Z";
    let auditNumber = 0;
    let leaseNumber = 0;
    const storeAfterRestart = createAuditJobStore(databaseFilePath, {
      clock: () => now,
      idGenerator: () => `audit-after-restart-${auditNumber += 1}`,
      leaseTokenGenerator: () => `lease-after-restart-${leaseNumber += 1}`
    });
    const restartedWorker = workerFor(storeAfterRestart, "worker-after-restart");
    const results = [];

    for (let index = 0; index < 3; index += 1) {
      results.push(await restartedWorker.runOnce());
    }

    const staleCompletion = storeBeforeRestart.complete({
      jobId: abandonedClaim.id,
      workerId: "worker-before-restart",
      leaseToken: abandonedClaim.leaseToken,
      audit: fakeAuditForUrl(abandonedClaim.normalizedUrl)
    });
    const completedJobs = queuedJobs.map(({ id }) => storeAfterRestart.findById(id));

    assert.equal(results.every(({ status }) => status === "completed"), true);
    assert.deepEqual(completedJobs.map(({ status }) => status), ["completed", "completed", "completed"]);
    assert.deepEqual(completedJobs.map(({ attemptCount }) => attemptCount), [2, 1, 1]);
    assert.deepEqual(staleCompletion, { completed: false, job: null, audit: null });
    assert.equal((await createAuditStore(databaseFilePath).list({ limit: 100 })).length, 3);
    assertDatabaseInvariants(databaseFilePath);
  });

  it("accepts a ten-request API burst quickly, then drains jobs without mixing reports", async () => {
    const databaseFilePath = temporaryDatabase();
    const config = loadConfig({
      NODE_ENV: "test",
      PORT: 0,
      RATE_LIMIT_MAX: 500,
      DATABASE_FILE_PATH: databaseFilePath
    });
    const store = createAuditStore(databaseFilePath);
    const jobStore = createAuditJobStore(databaseFilePath);
    let webAuditCalls = 0;
    const server = createApp(config, {
      store,
      jobStore,
      initialUrlSafetyValidator: async () => true,
      auditGenerator: async () => {
        webAuditCalls += 1;
        throw new Error("The web process must not execute audits.");
      },
      telemetry: { record() {} }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;
      const targets = Array.from({ length: 10 }, (_, index) => `https://burst-${index}.example.com`);
      const responses = await Promise.all(targets.map((websiteUrl) =>
        fetch(`${baseUrl}/api/audits`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ websiteUrl })
        })
      ));
      const payloads = await Promise.all(responses.map((response) => response.json()));
      const jobIds = payloads.map(({ job }) => job.id);

      assert.equal(responses.every(({ status }) => status === 202), true);
      assert.equal(new Set(jobIds).size, 10);
      assert.equal(webAuditCalls, 0);
      assert.equal((await store.list({ limit: 100 })).length, 0);

      const worker = workerFor(createAuditJobStore(databaseFilePath), "worker-burst");
      const workerResults = [];
      for (let index = 0; index < targets.length; index += 1) {
        workerResults.push(await worker.runOnce());
      }

      const statusResponses = await Promise.all(jobIds.map((jobId) => fetch(`${baseUrl}/api/audit-jobs/${jobId}`)));
      const statuses = await Promise.all(statusResponses.map((response) => response.json()));
      const reportResponses = await Promise.all(statuses.map(({ job }) => fetch(`${baseUrl}${job.auditUrl}`)));
      const reports = await Promise.all(reportResponses.map((response) => response.json()));

      assert.equal(workerResults.every(({ status }) => status === "completed"), true);
      assert.equal(statusResponses.every(({ status }) => status === 200), true);
      assert.equal(statuses.every(({ job }) => job.status === "completed"), true);
      assert.equal(new Set(statuses.map(({ job }) => job.auditId)).size, 10);
      assert.equal(reportResponses.every(({ status }) => status === 200), true);
      assert.deepEqual(
        reports.map(({ audit }) => audit.normalizedUrl).sort(),
        [...targets].sort()
      );
      assertDatabaseInvariants(databaseFilePath);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
