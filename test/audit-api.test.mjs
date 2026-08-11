import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../src/config/env.mjs";
import { createApp } from "../src/http/app.mjs";
import { generateAudit } from "../src/audit/audit-engine.mjs";

let server;
let baseUrl;

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

describe("audit API", () => {
  before(async () => {
    const dir = await mkdtemp(join(tmpdir(), "sitepulse-api-"));
    const config = loadConfig({
      NODE_ENV: "test",
      PORT: 0,
      ADMIN_API_KEY: "test-admin-key",
      DATABASE_FILE_PATH: join(dir, "sitepulse.sqlite")
    });
    server = createApp(config, {
      auditGenerator: async (websiteUrl) => {
        if (websiteUrl === "localhost:3000") {
          const { normalizeWebsiteUrl } = await import("../src/audit/url-validation.mjs");
          normalizeWebsiteUrl(websiteUrl);
        }

        return fakeAudit("luna-cafe.com");
      }
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

  it("creates audit reports", async () => {
    const response = await fetch(`${baseUrl}/api/audits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ websiteUrl: "luna-cafe.com" })
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.audit.domain, "luna-cafe.com");
    assert.equal(body.audit.categories.length, 1);
    assert.equal(body.audit.scanner.mode, "heuristic");
    assert.match(body.audit.id, /^[0-9a-f-]{36}$/);
  });

  it("accepts url as a backwards-compatible audit request field", async () => {
    const response = await fetch(`${baseUrl}/api/audits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "luna-cafe.com" })
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.audit.domain, "luna-cafe.com");
    assert.match(body.audit.id, /^[0-9a-f-]{36}$/);
  });

  it("rejects JSON primitives as invalid request bodies", async () => {
    const response = await fetch(`${baseUrl}/api/audits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null"
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "INVALID_REQUEST_BODY");
  });

  it("returns a safe error when scanner fails unexpectedly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sitepulse-api-error-"));
    const config = loadConfig({
      NODE_ENV: "test",
      PORT: 0,
      DATABASE_FILE_PATH: join(dir, "sitepulse.sqlite")
    });
    const failingServer = createApp(config, {
      auditGenerator: async () => {
        throw new Error("scanner exploded");
      }
    });

    await new Promise((resolve) => failingServer.listen(0, "127.0.0.1", resolve));
    const address = failingServer.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/audits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ websiteUrl: "luna-cafe.com" })
    });
    const body = await response.json();
    await new Promise((resolve) => failingServer.close(resolve));

    assert.equal(response.status, 500);
    assert.equal(body.error.code, "INTERNAL_SERVER_ERROR");
    assert.doesNotMatch(body.error.message, /scanner exploded/);
  });

  it("does not expose audit history without admin key", async () => {
    const response = await fetch(`${baseUrl}/api/audits?limit=5`);
    const body = await response.json();

    assert.equal(response.status, 403);
    assert.equal(body.error.code, "ADMIN_ACCESS_REQUIRED");
  });

  it("lists audit summaries with admin key", async () => {
    const response = await fetch(`${baseUrl}/api/audits?limit=5`, {
      headers: { "X-Admin-Key": "test-admin-key" }
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.ok(body.audits.length >= 1);
    assert.equal(body.audits[0].domain, "luna-cafe.com");
    assert.equal(body.audits[0].scannerMode, "heuristic");
    assert.equal(body.audits[0].categories, undefined);
    assert.equal(body.audits[0].priorityFixes, undefined);
  });

  it("returns validation errors for bad input", async () => {
    const response = await fetch(`${baseUrl}/api/audits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ websiteUrl: "localhost:3000" })
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "INVALID_PUBLIC_DOMAIN");
  });

  it("returns safe errors for private IP audit targets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sitepulse-api-unsafe-"));
    const config = loadConfig({
      NODE_ENV: "test",
      PORT: 0,
      DATABASE_FILE_PATH: join(dir, "sitepulse.sqlite")
    });
    const realServer = createApp(config);

    await new Promise((resolve) => realServer.listen(0, "127.0.0.1", resolve));
    const address = realServer.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/audits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ websiteUrl: "http://192.168.1.5" })
    });
    const body = await response.json();
    await new Promise((resolve) => realServer.close(resolve));

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "UNSAFE_URL");
    assert.doesNotMatch(body.error.message, /stack|fetch|scanner exploded/i);
  });

  it("keeps simultaneous API requests bounded to one rendered audit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sitepulse-api-concurrency-"));
    const config = loadConfig({
      NODE_ENV: "test",
      PORT: 0,
      DATABASE_FILE_PATH: join(dir, "sitepulse.sqlite"),
      RENDERED_AUDIT_ENABLED: true,
      RENDERED_AUDIT_MAX_CONCURRENCY: 1
    });
    let releaseFirst;
    let markStarted;
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const concurrencyServer = createApp(config, {
      auditGenerator: (websiteUrl, options) =>
        generateAudit(websiteUrl, {
          ...options,
          htmlScanner: async (target) => ({
            target,
            html: "<html><title>Beta</title><h1>Beta</h1></html>",
            responseHeaders: {},
            signals: { https: true, deterministicOffsets: {} },
            checks: {},
            warnings: []
          }),
          adapters: [],
          renderedAdapter: async () => {
            markStarted();
            await gate;
            return {
              adapter: "lighthouse-playwright",
              signals: { lighthouse: { metrics: {}, scores: {} }, rendered: { status: "completed" } },
              checks: {},
              warnings: []
            };
          }
        })
    });

    await new Promise((resolve) => concurrencyServer.listen(0, "127.0.0.1", resolve));
    const address = concurrencyServer.address();
    const endpoint = `http://127.0.0.1:${address.port}/api/audits`;
    const request = (websiteUrl) => fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ websiteUrl })
    });
    const firstResponsePromise = request("first.example");
    await started;
    const secondResponse = await request("second.example");
    const secondBody = await secondResponse.json();

    assert.equal(secondResponse.status, 201);
    assert.equal(secondBody.audit.scanner.status, "rendered-audit-temporarily-unavailable");
    releaseFirst();
    const firstResponse = await firstResponsePromise;
    const firstBody = await firstResponse.json();
    await new Promise((resolve) => concurrencyServer.close(resolve));

    assert.equal(firstBody.audit.scanner.status, "full-rendered-completed");
  });

  it("rejects non-json audit requests", async () => {
    const response = await fetch(`${baseUrl}/api/audits`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "luna-cafe.com"
    });
    const body = await response.json();

    assert.equal(response.status, 415);
    assert.equal(body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  });

  it("returns 404 for unknown API routes", async () => {
    const response = await fetch(`${baseUrl}/api/missing`);
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.error.code, "API_NOT_FOUND");
  });
});
