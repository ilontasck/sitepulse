import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config/env.mjs";
import { createApp } from "../src/http/app.mjs";
import { createAuditJobStore } from "../src/storage/audit-job-store.mjs";
import { createRetentionCleanupStore } from "../src/storage/retention-cleanup-store.mjs";
import { createAuditJobWorker } from "../src/audit/audit-job-worker.mjs";
import { generateAudit } from "../src/audit/audit-engine.mjs";
import { assertSafeUrl } from "../src/audit/url-safety.mjs";

// Real browser, auth, HTTP routes, SQLite, queue, worker and report generator.
// Only the external website/DNS are fixtures; no API responses are intercepted.
test("real beta lifecycle: queue, worker, report, print, ownership and account erasure", async ({ page, browser }) => {
  const directory = mkdtempSync(join(tmpdir(), "sitepulse-beta-browser-"));
  const databaseFilePath = join(directory, "test.sqlite");
  const resolver = async () => [{ address: "93.184.216.34", family: 4 }];
  const config = loadConfig({ NODE_ENV: "test", PORT: 0, AUTH_REGISTRATION_MODE: "public", DATABASE_FILE_PATH: databaseFilePath, RATE_LIMIT_MAX: 500 });
  const server = createApp(config, { initialUrlSafetyValidator: url => assertSafeUrl(url, { resolver }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  config.publicOrigin = `http://127.0.0.1:${server.address().port}`;
  const origin = config.publicOrigin;
  let releaseScan;
  const scanGate = new Promise(resolve => { releaseScan = resolve; });
  const jobStore = createAuditJobStore(databaseFilePath);
  const worker = createAuditJobWorker({ jobStore, workerId: "beta-browser-test", securityValidator: url => assertSafeUrl(url, { resolver }), auditGenerator: async url => {
    await scanGate;
    return generateAudit(url, { resolver, fetcher: async () => new Response('<!doctype html><html lang="en"><head><title>Beta fixture</title><meta name="description" content="Controlled public website"></head><body><h1>Beta</h1></body></html>', { headers: { "content-type": "text/html" } }) });
  }});
  let work;
  const request = (path, method = "GET", data) => page.request.fetch(`${origin}${path}`, { method, data, headers: { Origin: origin } });
  try {
    await page.goto(origin);
    await page.getByLabel("Registration email").fill("beta-owner@example.test");
    await page.getByLabel("Create password").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(page.getByRole("button", { name: /Run audit/ })).toBeVisible();
    for (const websiteUrl of ["http://localhost", "http://10.0.0.1", "http://[::1]"]) {
      expect((await request("/api/audits", "POST", { websiteUrl })).status()).toBe(400);
    }
    await page.getByLabel("Website URL").fill("https://example.com");
    const created = page.waitForResponse(response => response.url() === `${origin}/api/audits` && response.request().method() === "POST");
    await page.getByRole("button", { name: /Run audit/ }).click();
    const { job } = await (await created).json();
    await expect(page.locator("#analysisExperience")).toHaveAttribute("data-analysis-state", "queued");
    work = worker.runOnce();
    await expect(page.locator("#analysisExperience")).toHaveAttribute("data-analysis-state", "running");
    releaseScan();
    await work;
    await expect(page.locator("#report")).toBeVisible();
    const completed = (await (await request(job.statusUrl)).json()).job;
    expect(completed.status).toBe("completed");
    expect((await request(completed.auditUrl)).status()).toBe(200);
    await page.emulateMedia({ media: "print" });
    await expect(page.locator("#report")).toBeVisible();
    await expect(page.getByRole("button", { name: /Print report/ })).toBeHidden();
    await page.emulateMedia({ media: "screen" });
    const other = await browser.newContext();
    try {
      expect((await other.request.post(`${origin}/api/auth/register`, { headers: { Origin: origin }, data: { email: "beta-other@example.test", password: "another secure passphrase" } })).status()).toBe(201);
      expect((await other.request.get(`${origin}${completed.auditUrl}`)).status()).toBe(404);
      expect((await other.request.get(`${origin}${job.statusUrl}`)).status()).toBe(404);
      expect((await other.request.delete(`${origin}${completed.auditUrl}`, { headers: { Origin: origin } })).status()).toBe(404);
    } finally { await other.close(); }
    expect((await request("/api/auth/account", "DELETE", { password: "incorrect passphrase" })).status()).toBe(401);
    expect((await page.request.delete(`${origin}/api/auth/account`, { headers: { Origin: "https://untrusted.example" }, data: { password: "correct horse battery staple" } })).status()).toBe(403);
    expect((await request("/api/auth/account", "DELETE", { password: "correct horse battery staple" })).status()).toBe(204);
    expect((await request("/api/auth/me")).status()).toBe(401);
    expect((await request(completed.auditUrl)).status()).toBe(401);
    await page.reload();
    await expect(page.locator("#report")).toBeHidden();
    expect((await request("/api/auth/login", "POST", { email: "beta-owner@example.test", password: "correct horse battery staple" })).status()).toBe(401);
    const future = new Date(Date.now() + 31 * 86400000);
    createRetentionCleanupStore(databaseFilePath, { clock: () => future }).cleanup();
    const db = new DatabaseSync(databaseFilePath);
    try {
      expect(db.prepare("SELECT count(*) AS n FROM users WHERE email_normalized = ?").get("beta-owner@example.test").n).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM audits").get().n).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM audit_jobs").get().n).toBe(0);
    } finally { db.close(); }
  } finally {
    releaseScan();
    await work;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
