import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createAuditJobWorker } from "../src/audit/audit-job-worker.mjs";
import { loadConfig } from "../src/config/env.mjs";
import { createApp } from "../src/http/app.mjs";
import { createAuditJobStore } from "../src/storage/audit-job-store.mjs";
import { createAuditStore } from "../src/storage/audit-store.mjs";
import { runMigrations } from "../src/storage/migrations.mjs";
import { withDatabase } from "../src/storage/sqlite-database.mjs";

const openServers = new Set();

function fakeAudit(domain = "luna-cafe.com") {
  return {
    normalizedUrl: `https://${domain}`,
    domain,
    overallScore: 82,
    categories: [
      {
        id: "seo",
        label: "SEO basics",
        score: 82,
        status: "Strong",
        explanation: "Search-friendly titles, headings, and local discovery signals.",
        recommendations: ["Add a meta description."],
        impact: "Low"
      }
    ],
    recommendations: [{ category: "SEO basics", text: "Add a meta description." }],
    priorityFixes: [],
    improvements: [],
    signals: {},
    scanner: {
      mode: "heuristic",
      adapters: ["test"],
      checkedAt: "2026-06-30T00:00:00.000Z",
      warnings: []
    },
    warnings: []
  };
}

async function startApi({ configOverrides = {}, dependencies = {}, seedAudit = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sitepulse-api-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: 0,
    RATE_LIMIT_MAX: 500,
    DATABASE_FILE_PATH: join(directory, "sitepulse.sqlite"),
    ...configOverrides
  });
  runMigrations(config.databaseFilePath);
  const store = dependencies.store || createAuditStore(config.databaseFilePath);
  const jobStore = dependencies.jobStore || createAuditJobStore(config.databaseFilePath);
  const seededAudit = seedAudit ? await store.create(fakeAudit()) : null;
  const server = createApp(config, { store, jobStore, ...dependencies });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.add(server);
  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    config,
    jobStore,
    seededAudit,
    server,
    store
  };
}

async function stopApi(api) {
  if (!api || !openServers.has(api.server)) return;
  await new Promise((resolve) => api.server.close(resolve));
  openServers.delete(api.server);
}

function countRows(databaseFilePath, tableName) {
  if (!new Set(["audits", "audit_jobs"]).has(tableName)) {
    throw new TypeError("Unsupported test table.");
  }

  return withDatabase(databaseFilePath, (database) =>
    database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count
  );
}

async function postAudit(baseUrl, payload, headers = { "Content-Type": "application/json" }) {
  return fetch(`${baseUrl}/api/audits`, {
    method: "POST",
    headers,
    body: typeof payload === "string" ? payload : JSON.stringify(payload)
  });
}

after(async () => {
  await Promise.all([...openServers].map((server) => new Promise((resolve) => server.close(resolve))));
  openServers.clear();
});

describe("asynchronous audit API", () => {
  let api;
  let auditGeneratorCalls;
  let telemetryEntries;

  before(async () => {
    auditGeneratorCalls = 0;
    telemetryEntries = [];
    api = await startApi({
      configOverrides: { ADMIN_API_KEY: "test-admin-key" },
      dependencies: {
        initialUrlSafetyValidator: async () => true,
        auditGenerator: async () => {
          auditGeneratorCalls += 1;
          return fakeAudit();
        },
        telemetry: {
          record(event, fields) {
            telemetryEntries.push({ event, fields });
          }
        }
      },
      seedAudit: true
    });
  });

  after(async () => stopApi(api));

  it("enqueues websiteUrl and returns the 202 job contract without running an audit", async () => {
    const auditCountBefore = countRows(api.config.databaseFilePath, "audits");
    const response = await postAudit(api.baseUrl, { websiteUrl: "luna-cafe.com" });
    const body = await response.json();
    const persistedJob = api.jobStore.findById(body.job.id);

    assert.equal(response.status, 202);
    assert.equal(response.headers.get("location"), `/api/audit-jobs/${body.job.id}`);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.deepEqual(body, {
      job: {
        id: body.job.id,
        status: "queued",
        createdAt: persistedJob.createdAt,
        statusUrl: `/api/audit-jobs/${body.job.id}`
      }
    });
    assert.match(body.job.id, /^[0-9a-f-]{36}$/);
    assert.equal(persistedJob.normalizedUrl, "https://luna-cafe.com");
    assert.equal(auditGeneratorCalls, 0);
    assert.equal(countRows(api.config.databaseFilePath, "audits"), auditCountBefore);
    assert.deepEqual(telemetryEntries.at(-1), {
      event: "audit_job_enqueued",
      fields: { jobId: body.job.id, outcome: "queued" }
    });
    assert.equal(JSON.stringify(telemetryEntries.at(-1)).includes("luna-cafe.com"), false);
  });

  it("accepts the legacy url request field", async () => {
    const response = await postAudit(api.baseUrl, { url: "legacy.example.com" });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.job.status, "queued");
    assert.equal(api.jobStore.findById(body.job.id).normalizedUrl, "https://legacy.example.com");
  });

  it("rejects invalid JSON and non-object bodies without creating jobs", async () => {
    const before = countRows(api.config.databaseFilePath, "audit_jobs");
    const invalidJsonResponse = await postAudit(api.baseUrl, "{");
    const invalidJsonBody = await invalidJsonResponse.json();
    const primitiveResponse = await postAudit(api.baseUrl, "null");
    const primitiveBody = await primitiveResponse.json();

    assert.equal(invalidJsonResponse.status, 400);
    assert.equal(invalidJsonBody.error.code, "INVALID_JSON");
    assert.equal(primitiveResponse.status, 400);
    assert.equal(primitiveBody.error.code, "INVALID_REQUEST_BODY");
    assert.equal(countRows(api.config.databaseFilePath, "audit_jobs"), before);
  });

  it("rejects invalid public domains without creating jobs", async () => {
    const before = countRows(api.config.databaseFilePath, "audit_jobs");
    const response = await postAudit(api.baseUrl, { websiteUrl: "localhost:3000" });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "INVALID_PUBLIC_DOMAIN");
    assert.equal(countRows(api.config.databaseFilePath, "audit_jobs"), before);
  });

  it("rejects private targets before enqueue", async () => {
    const privateApi = await startApi();
    const before = countRows(privateApi.config.databaseFilePath, "audit_jobs");
    const response = await postAudit(privateApi.baseUrl, { websiteUrl: "http://192.168.1.5" });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "UNSAFE_URL");
    assert.equal(countRows(privateApi.config.databaseFilePath, "audit_jobs"), before);
    await stopApi(privateApi);
  });

  it("preserves unsupported media type handling", async () => {
    const response = await postAudit(api.baseUrl, "luna-cafe.com", { "Content-Type": "text/plain" });
    const body = await response.json();

    assert.equal(response.status, 415);
    assert.equal(body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  });

  it("returns only the public queued job shape", async () => {
    const response = await postAudit(api.baseUrl, { websiteUrl: "queued.example.com" });
    const created = await response.json();
    const statusResponse = await fetch(`${api.baseUrl}${created.job.statusUrl}`);
    const body = await statusResponse.json();

    assert.equal(statusResponse.status, 200);
    assert.deepEqual(body.job, {
      id: created.job.id,
      status: "queued",
      createdAt: created.job.createdAt
    });
  });

  it("returns only the public running job shape", async () => {
    const statusApi = await startApi({ dependencies: { initialUrlSafetyValidator: async () => true } });
    const queued = statusApi.jobStore.enqueue({ normalizedUrl: "https://running.example.com" });
    const running = statusApi.jobStore.claimNext({ workerId: "api-test-worker", leaseMs: 30_000 });
    const response = await fetch(`${statusApi.baseUrl}/api/audit-jobs/${queued.id}`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.job, {
      id: queued.id,
      status: "running",
      createdAt: queued.createdAt,
      startedAt: running.startedAt
    });
    await stopApi(statusApi);
  });

  it("returns completed job links without internal ownership fields", async () => {
    const statusApi = await startApi({ dependencies: { initialUrlSafetyValidator: async () => true } });
    const queued = statusApi.jobStore.enqueue({ normalizedUrl: "https://completed.example.com" });
    const running = statusApi.jobStore.claimNext({ workerId: "complete-worker", leaseMs: 30_000 });
    const completion = statusApi.jobStore.complete({
      jobId: queued.id,
      workerId: "complete-worker",
      leaseToken: running.leaseToken,
      audit: fakeAudit("completed.example.com")
    });
    const response = await fetch(`${statusApi.baseUrl}/api/audit-jobs/${queued.id}`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.job, {
      id: queued.id,
      status: "completed",
      createdAt: queued.createdAt,
      completedAt: completion.job.completedAt,
      auditId: completion.job.auditId,
      auditUrl: `/api/audits/${completion.job.auditId}`
    });
    await stopApi(statusApi);
  });

  it("returns a safe failed shape without retry, worker, lease, or raw error data", async () => {
    const statusApi = await startApi({ dependencies: { initialUrlSafetyValidator: async () => true } });
    const queued = statusApi.jobStore.enqueue({ normalizedUrl: "https://failed.example.com" });
    const running = statusApi.jobStore.claimNext({ workerId: "failure-worker", leaseMs: 30_000 });
    const failure = statusApi.jobStore.handleFailure({
      jobId: queued.id,
      workerId: "failure-worker",
      leaseToken: running.leaseToken,
      failure: {
        disposition: "fail",
        code: "AUDIT_FAILED",
        message: "The website could not be audited. Please try again."
      }
    });
    const response = await fetch(`${statusApi.baseUrl}/api/audit-jobs/${queued.id}`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.job, {
      id: queued.id,
      status: "failed",
      createdAt: queued.createdAt,
      failedAt: failure.job.failedAt,
      error: {
        code: "AUDIT_FAILED",
        message: "The website could not be audited. Please try again."
      }
    });
    for (const internalField of ["workerId", "leaseToken", "leaseExpiresAt", "attemptCount", "maxAttempts", "errorCode", "errorMessage"]) {
      assert.equal(internalField in body.job, false);
    }
    await stopApi(statusApi);
  });

  it("returns the same safe 404 for malformed and unknown job IDs", async () => {
    const malformedResponse = await fetch(`${api.baseUrl}/api/audit-jobs/not-a-uuid`);
    const malformedBody = await malformedResponse.json();
    const unknownResponse = await fetch(`${api.baseUrl}/api/audit-jobs/00000000-0000-4000-8000-000000000000`);
    const unknownBody = await unknownResponse.json();

    assert.equal(malformedResponse.status, 404);
    assert.equal(unknownResponse.status, 404);
    assert.deepEqual(malformedBody, unknownBody);
    assert.deepEqual(unknownBody, {
      error: {
        code: "AUDIT_JOB_NOT_FOUND",
        message: "Audit job was not found."
      }
    });
  });

  it("returns 405 for unsupported methods on a job resource", async () => {
    const queued = api.jobStore.enqueue({ normalizedUrl: "https://method.example.com" });
    const response = await fetch(`${api.baseUrl}/api/audit-jobs/${queued.id}`, { method: "PUT" });
    const body = await response.json();

    assert.equal(response.status, 405);
    assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
  });

  it("keeps existing audit detail and admin history endpoints unchanged", async () => {
    const detailResponse = await fetch(`${api.baseUrl}/api/audits/${api.seededAudit.id}`);
    const detailBody = await detailResponse.json();
    const forbiddenResponse = await fetch(`${api.baseUrl}/api/audits?limit=5`);
    const historyResponse = await fetch(`${api.baseUrl}/api/audits?limit=5`, {
      headers: { "X-Admin-Key": "test-admin-key" }
    });
    const historyBody = await historyResponse.json();

    assert.equal(detailResponse.status, 200);
    assert.equal(detailBody.audit.id, api.seededAudit.id);
    assert.equal(forbiddenResponse.status, 403);
    assert.equal(historyResponse.status, 200);
    assert.ok(historyBody.audits.some((audit) => audit.id === api.seededAudit.id));
    assert.equal(historyBody.audits[0].categories, undefined);
  });
});

describe("async audit integration", () => {
  it("flows from POST through one worker run to status and readable audit", async () => {
    const api = await startApi({ dependencies: { initialUrlSafetyValidator: async () => true } });
    const response = await postAudit(api.baseUrl, { websiteUrl: "integration.example.com" });
    const created = await response.json();
    const worker = createAuditJobWorker({
      jobStore: api.jobStore,
      workerId: "controlled-integration-worker",
      securityValidator: async () => true,
      auditGenerator: async () => fakeAudit("integration.example.com"),
      leaseMs: 30_000,
      heartbeatMs: 10_000
    });

    const result = await worker.runOnce();
    const statusResponse = await fetch(`${api.baseUrl}${created.job.statusUrl}`);
    const statusBody = await statusResponse.json();
    const auditResponse = await fetch(`${api.baseUrl}${statusBody.job.auditUrl}`);
    const auditBody = await auditResponse.json();

    assert.equal(response.status, 202);
    assert.equal(result.status, "completed");
    assert.equal(statusResponse.status, 200);
    assert.equal(statusBody.job.status, "completed");
    assert.equal(auditResponse.status, 200);
    assert.equal(auditBody.audit.id, statusBody.job.auditId);
    assert.equal(auditBody.audit.domain, "integration.example.com");
    await stopApi(api);
  });

  it("allows practical one-second polling within the existing 60/minute limiter", async () => {
    const api = await startApi({
      configOverrides: { RATE_LIMIT_MAX: 60 },
      dependencies: { initialUrlSafetyValidator: async () => true }
    });
    const response = await postAudit(api.baseUrl, { websiteUrl: "polling.example.com" });
    const created = await response.json();

    assert.equal(response.status, 202);
    for (let poll = 0; poll < 45; poll += 1) {
      const pollResponse = await fetch(`${api.baseUrl}${created.job.statusUrl}`);
      assert.equal(pollResponse.status, 200);
    }

    await stopApi(api);
  });
});
