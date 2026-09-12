import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAuditTelemetry } from "../src/telemetry/audit-telemetry.mjs";
import { createRequestId, isCorrelationId, withLogContext } from "../src/telemetry/log-context.mjs";
import { createApiMetrics, queueMetrics } from "../src/telemetry/queue-metrics.mjs";
import { evaluateAlerts, summarizeJournal, summarizeJournalResult } from "../src/telemetry/alert-conditions.mjs";
import { createApp } from "../src/http/app.mjs";
import { loadConfig } from "../src/config/env.mjs";
import { createAuditJobStore } from "../src/storage/audit-job-store.mjs";
import { createAuditJobWorker } from "../src/audit/audit-job-worker.mjs";
import { createAuditRunnerClient } from "../src/audit/audit-runner-client.mjs";
import { createAuditRunnerServer } from "../src/audit/audit-runner-server.mjs";
import { validateAuditRequest } from "../src/audit/audit-runner-protocol.mjs";

const secret = "PRIVATE_PASSWORD_TOKEN_123";
test("server IDs are unique; structured fields reject sensitive headers, body, paths and errors", async () => {
  assert.ok(isCorrelationId(createRequestId()));
  assert.notEqual(createRequestId(), createRequestId());
  const lines = [];
  const telemetry = createAuditTelemetry({ write: (line) => lines.push(line) });
  const requestId = randomUUID();
  await withLogContext({ requestId }, async () => {
    await Promise.resolve();
    telemetry.record("audit.failed", { jobId: randomUUID(), durationMs: 14, errorCode: secret,
      headers: { authorization: secret, cookie: secret, "x-admin-key": secret }, body: { password: secret },
      password: secret, resetToken: secret, url: `https://example.com/?token=${secret}`, route: `/api/${secret}`,
      reason: secret, fallbackReason: secret, stack: secret, message: secret, html: secret });
  });
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.requestId, requestId);
  assert.equal(entry.errorCode, "UNKNOWN_ERROR");
  assert.equal(entry.durationMs, 14);
  assert.equal(entry.level, "error");
  assert.ok(entry.timestamp);
  assert.doesNotMatch(lines.join(""), new RegExp(secret));
  assert.doesNotThrow(() => createAuditTelemetry({ write() { throw Error(secret); } }).record("worker.error"));
  const ids = [randomUUID(), randomUUID()];
  await Promise.all(ids.map((id) => withLogContext({ requestId: id }, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(telemetry.record("http.request_completed").requestId, id);
  })));
});

test("HTTP to SQLite to production RPC preserves correlation for failure and completion; operations stays private", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "noqori-observe-"));
  const config = loadConfig({ NODE_ENV: "test", PORT: 0, DATABASE_FILE_PATH: join(directory, "test.sqlite"),
    PUBLIC_ORIGIN: "http://sitepulse.test", AUTH_REGISTRATION_MODE: "public", ADMIN_API_KEY: secret, RATE_LIMIT_MAX: 500 });
  const lines = [];
  const telemetry = createAuditTelemetry({ write: (line) => lines.push(JSON.parse(line)) });
  const server = createApp(config, { telemetry, initialUrlSafetyValidator: async () => {} });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let runner;
  t.after(async () => {
    await runner?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const register = await fetch(`${base}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json", Origin: config.publicOrigin },
    body: JSON.stringify({ email: "observe@example.com", password: "correct horse battery staple" }) });
  assert.equal(register.status, 201);
  const cookie = register.headers.get("set-cookie").split(";", 1)[0];
  await register.json();
  const requests = await Promise.all([undefined, randomUUID(), `${secret} injection`].map(async (clientId) => {
    const response = await fetch(`${base}/api/health?reset_token=${secret}`, { headers: { ...(clientId ? { "X-Request-ID": clientId } : {}), Authorization: secret } });
    assert.ok(isCorrelationId(response.headers.get("x-request-id")));
    assert.notEqual(response.headers.get("x-request-id"), clientId);
    await response.json();
    return response.headers.get("x-request-id");
  }));
  assert.equal(new Set(requests).size, 3);
  for (const key of [null, "wrong"]) {
    const response = await fetch(`${base}/api/operations`, { headers: key ? { "X-Admin-Key": key } : {} });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).queue, undefined);
  }
  config.adminApiKey = "";
  const disabled = await fetch(`${base}/api/operations`, { headers: { "X-Admin-Key": secret } });
  assert.equal(disabled.status, 404);
  await disabled.json();
  config.adminApiKey = secret;
  let fail = true;
  runner = createAuditRunnerServer({ socketPath: join(directory, "runner.sock"), telemetry,
    auditGenerator: async (_url, options) => {
      options.telemetry.record("rendered_fallback", { fallbackReason: "timeout" });
      if (fail) throw Object.assign(new Error(secret), { code: "UNSAFE_URL" });
      return { normalizedUrl: "https://example.com", domain: "example.com", overallScore: 82, categories: [], scanner: { mode: "html-real-checks", adapters: [] } };
    }
  });
  await runner.start();
  const client = createAuditRunnerClient({ socketPath: join(directory, "runner.sock") });
  const jobStore = createAuditJobStore(config.databaseFilePath);
  const worker = createAuditJobWorker({ jobStore, workerId: randomUUID(), telemetry, securityValidator: async () => {}, auditGenerator: client.generateAudit });
  for (const expected of ["failed", "completed"]) {
    const queued = await fetch(`${base}/api/audits`, { method: "POST", headers: { Cookie: cookie, Origin: config.publicOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ websiteUrl: `https://example.com/?key=${secret}` }) });
    assert.equal(queued.status, 202);
    const requestId = queued.headers.get("x-request-id");
    const { job } = await queued.json();
    assert.equal(jobStore.findById(job.id).requestId, requestId);
    assert.equal((await worker.runOnce()).status, expected);
    const stored = jobStore.findById(job.id);
    if (fail) assert.equal(stored.errorCode, "UNSAFE_URL");
    for (const event of ["audit.queued", "audit.started", "worker.job_claimed", "runner.started", "rendered_fallback", `audit.${expected}`, `worker.job_${expected}`, `runner.${expected}`]) {
      const entry = lines.find((entry) => entry.jobId === job.id && entry.event === event);
      assert.ok(entry, event);
      assert.equal(entry.requestId, requestId, event);
    }
    if (!fail) assert.equal(lines.find((entry) => entry.jobId === job.id && entry.event === "audit.completed").auditId, stored.auditId);
    fail = false;
  }
  const response = await fetch(`${base}/api/operations`, { headers: { "X-Admin-Key": secret } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const operations = await response.json();
  assert.deepEqual(operations.queue, { queued: 0, running: 0, completed: 1, failed: 1, oldestQueuedAgeMs: 0 });
  assert.equal(operations.recent.failureRate, 0.5);
  assert.ok(operations.recent.completionLatencyAvgMs >= 0);
  assert.ok(operations.api.requests >= 1);
  assert.doesNotMatch(JSON.stringify({ operations, lines }), /PRIVATE_PASSWORD_TOKEN_123|observe@example|correct horse|https:\/\/example|password_hash|session=/);
  const user = (await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).json()).user;
  const now = Date.now();
  const oldStore = createAuditJobStore(config.databaseFilePath, { clock: () => new Date(now - 60_000) });
  oldStore.enqueue({ normalizedUrl: "https://example.com", userId: user.id });
  oldStore.enqueue({ normalizedUrl: "https://example.com", userId: user.id });
  oldStore.claimNext({ workerId: randomUUID(), leaseMs: 120_000 });
  const metrics = queueMetrics(config.databaseFilePath, { now });
  assert.equal(metrics.queue.queued, 1);
  assert.equal(metrics.queue.running, 1);
  assert.equal(metrics.queue.oldestQueuedAgeMs, 60_000);
});

test("API metrics expire and alerts cover degradation, DB failures and restarts", () => {
  let now = 0;
  const metrics = createApiMetrics({ now: () => now });
  metrics.record({ statusCode: 500, durationMs: 3000, errorCode: "DB_FAILURE" });
  assert.equal(metrics.snapshot().dbErrors, 1);
  now = 1_000_000;
  assert.equal(metrics.snapshot().requests, 0);
  const journal = summarizeJournal('unstructured\n' + Array(4).fill('{"event":"worker.started","errorCode":"DB_FAILURE"}').join('\n'));
  const alerts = evaluateAlerts({ apiReady: false, workerReady: false, journal,
    operations: { queue: { queued: 21, oldestQueuedAgeMs: 120001 }, recent: { completed: 2, failed: 3, failureRate: 0.6 }, api: { requests: 20, errors: 5, latencyAvgMs: 3000 } } });
  for (const code of ["API_UNAVAILABLE", "WORKER_UNAVAILABLE", "QUEUE_BACKLOG", "QUEUE_TOO_OLD", "AUDIT_FAILURE_RATE", "API_LATENCY", "API_ERROR_RATE", "REPEATED_DB_ERRORS", "REPEATED_WORKER_RESTARTS"]) assert.ok(alerts.includes(code), code);
  assert.deepEqual(evaluateAlerts({ apiReady: true, workerReady: true, journal: { dbErrors: 0, workerStarts: 1 }, operations: { queue: { queued: 0, oldestQueuedAgeMs: 0 }, recent: { completed: 0, failed: 0, failureRate: 0 }, api: { requests: 0 } } }), []);
  assert.ok(evaluateAlerts({}).includes("JOURNAL_UNAVAILABLE"));
});

test("RPC rejects untrusted correlation fields", () => {
  const frame = { type: "audit", protocolVersion: 2, requestId: randomUUID(), normalizedUrl: "https://example.com", options: { renderedAuditEnabled: false } };
  assert.throws(() => validateAuditRequest({ ...frame, correlation: { requestId: secret } }));
  assert.throws(() => validateAuditRequest({ ...frame, correlation: { requestId: randomUUID(), password: secret } }));
});

test("worker readiness logs transitions without polling spam and reports persistence failures with correlation", async () => {
  const lines = [];
  const telemetry = createAuditTelemetry({ write: (line) => lines.push(JSON.parse(line)) });
  const job = { id: randomUUID(), requestId: randomUUID(), normalizedUrl: "https://example.com", createdAt: new Date().toISOString(), attemptCount: 1, leaseToken: randomUUID() };
  let ready = false;
  let availableJob = job;
  const worker = createAuditJobWorker({
    workerId: randomUUID(), telemetry, securityValidator: async () => {},
    executorReadiness: async () => ({ ready }), auditGenerator: async () => ({}),
    jobStore: {
      recoverExpired: () => ({ requeued: 0, failed: 0 }),
      claimNext: () => { const next = availableJob; availableJob = null; return next; },
      renewLease: () => ({ renewed: true }),
      complete() { throw Object.assign(new Error(secret), { code: "ERR_SQLITE_ERROR" }); },
      handleFailure({ failure }) { assert.equal(failure.code, "DB_FAILURE"); return { transitioned: true, job: { status: "queued" } }; }
    }
  });
  for (let i = 0; i < 10; i++) assert.equal((await worker.runOnce()).status, "executor-unavailable");
  assert.equal(lines.filter((entry) => entry.event === "worker.error").length, 1);
  ready = true;
  assert.equal((await worker.runOnce()).status, "queued");
  const failure = lines.find((entry) => entry.event === "worker.job_failed");
  assert.equal(failure.jobId, job.id);
  assert.equal(failure.requestId, job.requestId);
  assert.equal(failure.phase, "persist");
  assert.equal(failure.errorCode, "DB_FAILURE");
  assert.doesNotMatch(JSON.stringify(lines), new RegExp(secret));
});


test("journal permission warnings cannot report zero-error healthy monitoring", () => {
  const journal = summarizeJournalResult({ stdout: "", stderr: "Hint: You are currently not seeing messages from other users and the system." });
  assert.equal(journal, null);
  assert.ok(evaluateAlerts({ journal }).includes("JOURNAL_UNAVAILABLE"));
  assert.equal(summarizeJournalResult({ stdout: '{"event":"worker.started"}', stderr: "access restricted" }), null);
  assert.equal(summarizeJournalResult({ stdout: '{"event":"worker.started"}', stderr: "" }).workerStarts, 1);
});

test("a v1 runner is rejected during readiness without claiming a job", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "noqori-v1-runner-"));
  const socketPath = join(directory, "runner.sock");
  const server = createNetServer((socket) => {
    socket.once("data", () => socket.end('{"protocolVersion":1,"type":"hello","capabilities":{"renderedAuditAllowed":false}}\n'));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const client = createAuditRunnerClient({ socketPath });
  await assert.rejects(client.checkReadiness(), { code: "AUDIT_RUNNER_PROTOCOL_MISMATCH" });
  let claims = 0;
  const worker = createAuditJobWorker({ workerId: randomUUID(), auditGenerator: client.generateAudit,
    executorReadiness: client.checkReadiness, jobStore: { recoverExpired: () => ({}), claimNext: () => { claims++; } } });
  assert.equal((await worker.runOnce()).status, "executor-unavailable");
  assert.equal(claims, 0);
});
