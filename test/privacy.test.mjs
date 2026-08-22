import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { createAuditJobWorker } from "../src/audit/audit-job-worker.mjs";
import { generateSessionToken } from "../src/auth/session-token.mjs";
import { loadConfig } from "../src/config/env.mjs";
import { createApp } from "../src/http/app.mjs";
import { createAuditJobStore } from "../src/storage/audit-job-store.mjs";
import { createAuditStore } from "../src/storage/audit-store.mjs";
import { runMigrations } from "../src/storage/migrations.mjs";

let server;
let baseUrl;
let auditJobStore;
let worker;
let sessionCookie;
const userId = "11111111-1111-4111-8111-111111111111";
const publicOrigin = "http://sitepulse.test";

describe("privacy controls", () => {
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "sitepulse-privacy-"));
    const config = loadConfig({
      NODE_ENV: "test",
      AUTH_REGISTRATION_MODE: "closed",
      PORT: 0,
      PUBLIC_ORIGIN: publicOrigin,
      DATABASE_FILE_PATH: join(dir, "sitepulse.sqlite")
    });
    runMigrations(config.databaseFilePath);
    const database = new DatabaseSync(config.databaseFilePath);
    const now = "2026-08-14T10:00:00.000Z";
    database.prepare(`
      INSERT INTO users (
        id, email_original, email_normalized, password_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, "privacy@example.com", "privacy@example.com", "x".repeat(64), now, now);
    database.close();
    const rawToken = generateSessionToken();
    sessionCookie = `sitepulse_session=${rawToken}`;
    auditJobStore = createAuditJobStore(config.databaseFilePath);
    const auditStore = createAuditStore(config.databaseFilePath);
    const auditGenerator = async () => ({
      normalizedUrl: "https://luna-cafe.com",
      domain: "luna-cafe.com",
      overallScore: 82,
      categories: [],
      recommendations: [],
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
    });
    server = createApp(config, {
      store: auditStore,
      jobStore: auditJobStore,
      authService: {
        authenticate: async (token) => token === rawToken
          ? { id: userId, email: "privacy@example.com", createdAt: now }
          : null
      },
      initialUrlSafetyValidator: async () => true
    });
    worker = createAuditJobWorker({
      jobStore: auditJobStore,
      workerId: "privacy-test-worker",
      securityValidator: async () => true,
      auditGenerator
    });

    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("disables audit history endpoint when no admin key is configured", async () => {
    const response = await fetch(`${baseUrl}/api/audits`);
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.error.code, "AUDIT_HISTORY_DISABLED");
  });

  it("allows only the authenticated owner to fetch a completed report", async () => {
    const createdResponse = await fetch(`${baseUrl}/api/audits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: publicOrigin,
        Cookie: sessionCookie
      },
      body: JSON.stringify({ websiteUrl: "luna-cafe.com" })
    });
    const createdBody = await createdResponse.json();
    const workerResult = await worker.runOnce();
    const jobResponse = await fetch(`${baseUrl}${createdBody.job.statusUrl}`, { headers: { Cookie: sessionCookie } });
    const jobBody = await jobResponse.json();
    const fetchedResponse = await fetch(`${baseUrl}/api/audits/${jobBody.job.auditId}`, { headers: { Cookie: sessionCookie } });
    const fetchedBody = await fetchedResponse.json();

    assert.equal(createdResponse.status, 202);
    assert.equal(workerResult.status, "completed");
    assert.equal(jobBody.job.status, "completed");
    assert.equal(fetchedResponse.status, 200);
    assert.equal(fetchedBody.audit.id, jobBody.job.auditId);
  });
});
