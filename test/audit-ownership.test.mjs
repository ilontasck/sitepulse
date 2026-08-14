import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAuditJobWorker } from "../src/audit/audit-job-worker.mjs";
import { createPasswordService } from "../src/auth/password.mjs";
import { loadConfig } from "../src/config/env.mjs";
import { createApp } from "../src/http/app.mjs";
import { createAuditJobStore } from "../src/storage/audit-job-store.mjs";
import { createAuditStore } from "../src/storage/audit-store.mjs";
import { runMigrations } from "../src/storage/migrations.mjs";
import { withDatabase } from "../src/storage/sqlite-database.mjs";

const publicOrigin = "http://sitepulse.test";
const runningApis = [];

function fastPasswordService() {
  return createPasswordService({
    deriveKey(passwordBytes, salt, { keyLength }) {
      return Promise.resolve(createHash("sha512").update(passwordBytes).update(salt).digest().subarray(0, keyLength));
    }
  });
}

function fakeAudit(domain = "owned.example.com") {
  return {
    normalizedUrl: `https://${domain}`,
    domain,
    overallScore: 82,
    categories: [],
    recommendations: [],
    priorityFixes: [],
    improvements: [],
    signals: {},
    scanner: { mode: "html-real-checks", adapters: ["test"], checkedAt: "2026-08-14T10:00:00.000Z", warnings: [] },
    warnings: []
  };
}

async function startApi({ configOverrides = {}, dependencies = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sitepulse-ownership-api-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: 0,
    PUBLIC_ORIGIN: publicOrigin,
    RATE_LIMIT_MAX: 500,
    AUTH_REGISTER_RATE_LIMIT_MAX: 100,
    AUTH_LOGIN_RATE_LIMIT_MAX: 100,
    AUTH_GENERAL_RATE_LIMIT_MAX: 500,
    AUDIT_USER_RATE_LIMIT_MAX: 100,
    DATABASE_FILE_PATH: join(directory, "sitepulse.sqlite"),
    ...configOverrides
  });
  runMigrations(config.databaseFilePath);
  const store = createAuditStore(config.databaseFilePath);
  const jobStore = createAuditJobStore(config.databaseFilePath);
  const server = createApp(config, {
    store,
    jobStore,
    passwordService: fastPasswordService(),
    initialUrlSafetyValidator: async () => true,
    ...dependencies
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const api = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    config,
    directory,
    jobStore,
    server,
    store
  };
  runningApis.push(api);
  return api;
}

async function stopApi(api) {
  if (!api) return;
  await new Promise((resolve) => api.server.close(resolve));
  rmSync(api.directory, { recursive: true, force: true });
  const index = runningApis.indexOf(api);
  if (index >= 0) runningApis.splice(index, 1);
}

async function register(api, email) {
  const response = await fetch(`${api.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: publicOrigin },
    body: JSON.stringify({ email, password: "correct horse battery staple" })
  });
  const body = await response.json();
  return {
    response,
    user: body.user,
    cookie: response.headers.get("set-cookie")?.split(";", 1)[0]
  };
}

function auditRequest(api, {
  cookie,
  origin = publicOrigin,
  body = { websiteUrl: "owned.example.com" },
  contentType = "application/json"
} = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (origin !== null) headers.Origin = origin;
  if (contentType !== null) headers["Content-Type"] = contentType;
  return fetch(`${api.baseUrl}/api/audits`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

function ownedGet(api, path, cookie) {
  return fetch(`${api.baseUrl}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
}

function rowCount(databaseFilePath, table) {
  if (!new Set(["audit_jobs", "audits"]).has(table)) throw new TypeError("Unsupported table.");
  return withDatabase(databaseFilePath, (database) =>
    database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
  );
}

afterEach(async () => {
  await Promise.all([...runningApis].map(stopApi));
});

describe("authenticated audit ownership", () => {
  it("authenticates before URL work and requires exact Origin before enqueue", async () => {
    let safetyCalls = 0;
    const api = await startApi({
      dependencies: {
        initialUrlSafetyValidator: async () => {
          safetyCalls += 1;
          return true;
        }
      }
    });
    const before = rowCount(api.config.databaseFilePath, "audit_jobs");
    const unauthenticated = await auditRequest(api);
    const owner = await register(api, "owner@example.com");
    const missingOrigin = await auditRequest(api, { cookie: owner.cookie, origin: null });
    const wrongOrigin = await auditRequest(api, { cookie: owner.cookie, origin: "https://evil.example" });
    const wrongType = await auditRequest(api, { cookie: owner.cookie, contentType: "text/plain" });

    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).error.code, "AUTHENTICATION_REQUIRED");
    assert.equal(safetyCalls, 0);
    for (const response of [missingOrigin, wrongOrigin]) {
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, "CSRF_REJECTED");
    }
    assert.equal(wrongType.status, 415);
    assert.equal(rowCount(api.config.databaseFilePath, "audit_jobs"), before);
    assert.equal(safetyCalls, 0);
  });

  it("persists only the authenticated owner and ignores client ownership fields", async () => {
    const api = await startApi();
    const owner = await register(api, "owner@example.com");
    const response = await auditRequest(api, {
      cookie: owner.cookie,
      body: {
        websiteUrl: "owned.example.com",
        userId: "22222222-2222-4222-8222-222222222222",
        user_id: "33333333-3333-4333-8333-333333333333",
        owner: "attacker",
        ownerId: "attacker"
      }
    });
    const body = await response.json();
    const job = api.jobStore.findById(body.job.id);

    assert.equal(response.status, 202);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(job.userId, owner.user.id);
    assert.equal("userId" in body.job, false);
  });

  it("propagates persisted ownership atomically and closes cross-user IDOR", async () => {
    const api = await startApi();
    const owner = await register(api, "owner@example.com");
    const other = await register(api, "other@example.com");
    const createResponse = await auditRequest(api, { cookie: owner.cookie });
    const created = await createResponse.json();
    const worker = createAuditJobWorker({
      jobStore: api.jobStore,
      workerId: "ownership-worker",
      securityValidator: async () => true,
      auditGenerator: async () => ({
        ...fakeAudit(),
        userId: other.user.id
      }),
      leaseMs: 30_000,
      heartbeatMs: 10_000
    });

    assert.equal((await worker.runOnce()).status, "completed");
    const ownerJobResponse = await ownedGet(api, created.job.statusUrl, owner.cookie);
    const ownerJobBody = await ownerJobResponse.json();
    const ownerAuditResponse = await ownedGet(api, ownerJobBody.job.auditUrl, owner.cookie);
    const ownerAuditBody = await ownerAuditResponse.json();
    const otherJobResponse = await ownedGet(api, created.job.statusUrl, other.cookie);
    const otherAuditResponse = await ownedGet(api, ownerJobBody.job.auditUrl, other.cookie);
    const unauthenticatedJob = await ownedGet(api, created.job.statusUrl);
    const unauthenticatedAudit = await ownedGet(api, ownerJobBody.job.auditUrl);
    const unknownJob = await ownedGet(api, "/api/audit-jobs/00000000-0000-4000-8000-000000000000", owner.cookie);
    const unknownAudit = await ownedGet(api, "/api/audits/00000000-0000-4000-8000-000000000000", other.cookie);

    assert.equal(ownerJobResponse.status, 200);
    assert.equal(ownerAuditResponse.status, 200);
    assert.equal(ownerJobResponse.headers.get("cache-control"), "private, no-store");
    assert.equal(ownerAuditResponse.headers.get("cache-control"), "private, no-store");
    assert.equal(ownerAuditBody.audit.userId, undefined);
    assert.equal(otherJobResponse.status, 404);
    assert.equal(otherAuditResponse.status, 404);
    assert.equal(unauthenticatedJob.status, 401);
    assert.equal(unauthenticatedAudit.status, 401);
    assert.deepEqual(await otherJobResponse.json(), await unknownJob.json());
    assert.deepEqual(await otherAuditResponse.json(), await unknownAudit.json());

    const relational = withDatabase(api.config.databaseFilePath, (database) => ({
      job: database.prepare("SELECT user_id FROM audit_jobs WHERE id = ?").get(created.job.id),
      audit: database.prepare("SELECT user_id, report_json FROM audits WHERE id = ?").get(ownerJobBody.job.auditId)
    }));
    assert.equal(relational.job.user_id, owner.user.id);
    assert.equal(relational.audit.user_id, owner.user.id);
    assert.equal(JSON.parse(relational.audit.report_json).userId, undefined);
  });

  it("keeps legacy NULL ownership recoverable by workers but private from users", async () => {
    const api = await startApi();
    const owner = await register(api, "owner@example.com");
    const now = "2026-08-14T10:00:00.000Z";
    const legacyJobId = "44444444-4444-4444-8444-444444444444";
    withDatabase(api.config.databaseFilePath, (database) => {
      database.prepare(`
        INSERT INTO audit_jobs (
          id, status, normalized_url, attempt_count, max_attempts,
          available_at, created_at, updated_at, user_id
        ) VALUES (?, 'queued', ?, 0, 2, ?, ?, ?, NULL)
      `).run(legacyJobId, "https://legacy.example.com", now, now, now);
    });
    const worker = createAuditJobWorker({
      jobStore: api.jobStore,
      workerId: "legacy-worker",
      securityValidator: async () => true,
      auditGenerator: async () => fakeAudit("legacy.example.com"),
      leaseMs: 30_000,
      heartbeatMs: 10_000
    });

    assert.equal((await worker.runOnce()).status, "completed");
    const legacy = api.jobStore.findById(legacyJobId);
    const relationalOwner = withDatabase(api.config.databaseFilePath, (database) =>
      database.prepare("SELECT user_id FROM audits WHERE id = ?").get(legacy.auditId).user_id
    );
    assert.equal(legacy.userId, null);
    assert.equal(relationalOwner, null);
    assert.equal((await ownedGet(api, `/api/audit-jobs/${legacyJobId}`, owner.cookie)).status, 404);
    assert.equal((await ownedGet(api, `/api/audits/${legacy.auditId}`, owner.cookie)).status, 404);
  });

  it("rate limits audit creation per user and keeps operator history separate", async () => {
    const api = await startApi({
      configOverrides: { AUDIT_USER_RATE_LIMIT_MAX: 1, ADMIN_API_KEY: "operator-key" }
    });
    const owner = await register(api, "owner@example.com");
    const other = await register(api, "other@example.com");

    assert.equal((await auditRequest(api, { cookie: owner.cookie })).status, 202);
    const limited = await auditRequest(api, { cookie: owner.cookie, body: { websiteUrl: "second.example.com" } });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, "RATE_LIMITED");
    assert.equal((await auditRequest(api, { cookie: other.cookie })).status, 202);

    const sessionOnly = await fetch(`${api.baseUrl}/api/audits`, { headers: { Cookie: owner.cookie } });
    const operator = await fetch(`${api.baseUrl}/api/audits`, { headers: { "X-Admin-Key": "operator-key" } });
    assert.equal(sessionOnly.status, 403);
    assert.equal(operator.status, 200);
  });
});
