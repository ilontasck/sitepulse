/**
 * NOQORI Module 06 — Legal pages unit tests
 *
 * Tests:
 * - Privacy, Impressum, Terms pages load with correct status and content type
 * - Security headers are present on legal pages
 * - Legal pages contain NOQORI identity markers
 * - Legal pages contain required placeholder strings (development-mode assertion)
 * - No legal page contains a fabricated email or fake phone number
 * - Landing page footer contains working legal navigation links
 * - Static file router correctly rejects unknown paths
 * - Placeholder detection script logic (importable utility)
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../src/config/env.mjs";
import { createApp } from "../src/http/app.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Shared test server
// ---------------------------------------------------------------------------
let server;
let baseUrl;

describe("legal pages", () => {
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "sitepulse-legal-"));
    const config = loadConfig({
      PORT: 0,
      NODE_ENV: "test",
      DATABASE_FILE_PATH: join(dir, "sitepulse.sqlite")
    });
    server = createApp(config);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  // ── Route delivery ────────────────────────────────────────────────────────

  it("serves /privacy with 200 and text/html", async () => {
    const response = await fetch(`${baseUrl}/privacy`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
  });

  it("serves /impressum with 200 and text/html", async () => {
    const response = await fetch(`${baseUrl}/impressum`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
  });

  it("serves /terms with 200 and text/html", async () => {
    const response = await fetch(`${baseUrl}/terms`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
  });

  // ── Security headers on legal pages ──────────────────────────────────────

  it("applies security headers to /privacy", async () => {
    const response = await fetch(`${baseUrl}/privacy`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  });

  it("applies security headers to /impressum", async () => {
    const response = await fetch(`${baseUrl}/impressum`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
  });

  it("applies security headers to /terms", async () => {
    const response = await fetch(`${baseUrl}/terms`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
  });

  // ── NOQORI identity present ───────────────────────────────────────────────

  it("/privacy contains NOQORI identity and page title", async () => {
    const body = await (await fetch(`${baseUrl}/privacy`)).text();
    assert.match(body, /NOQORI/);
    assert.match(body, /Privacy Policy/);
  });

  it("/impressum contains NOQORI identity and Impressum heading", async () => {
    const body = await (await fetch(`${baseUrl}/impressum`)).text();
    assert.match(body, /NOQORI/);
    assert.match(body, /Impressum/);
  });

  it("/terms contains NOQORI identity and Terms heading", async () => {
    const body = await (await fetch(`${baseUrl}/terms`)).text();
    assert.match(body, /NOQORI/);
    assert.match(body, /Terms of Service/);
  });

  // ── Development readiness: placeholder strings must be present ────────────
  // These assertions confirm legal pages are NOT yet falsely presented as complete.

  it("/privacy contains required development placeholders", async () => {
    const body = await (await fetch(`${baseUrl}/privacy`)).text();
    assert.match(
      body,
      /REQUIRED BEFORE PUBLIC LAUNCH/,
      "Privacy page must contain placeholder markers while owner data is unresolved"
    );
  });

  it("/impressum contains required development placeholders", async () => {
    const body = await (await fetch(`${baseUrl}/impressum`)).text();
    assert.match(
      body,
      /REQUIRED BEFORE PUBLIC LAUNCH/,
      "Impressum must contain placeholder markers while owner data is unresolved"
    );
  });

  it("/terms contains required development placeholders", async () => {
    const body = await (await fetch(`${baseUrl}/terms`)).text();
    assert.match(
      body,
      /REQUIRED BEFORE PUBLIC LAUNCH/,
      "Terms must contain placeholder markers while owner data is unresolved"
    );
  });

  // ── Fabricated data must NOT appear ──────────────────────────────────────

  it("/privacy does not contain a fabricated email address", async () => {
    const body = await (await fetch(`${baseUrl}/privacy`)).text();
    // No invented @example.com or any real-looking owner email should be present
    // (placeholder spans are fine; actual email addresses are not)
    assert.doesNotMatch(
      body,
      /href="mailto:[^"]+@[^"]+"/,
      "Privacy page must not contain a fabricated mailto link"
    );
  });

  it("/impressum does not contain a fabricated email address", async () => {
    const body = await (await fetch(`${baseUrl}/impressum`)).text();
    assert.doesNotMatch(
      body,
      /href="mailto:[^"]+@[^"]+"/,
      "Impressum must not contain a fabricated mailto link"
    );
  });

  it("/terms does not contain a fabricated email address", async () => {
    const body = await (await fetch(`${baseUrl}/terms`)).text();
    assert.doesNotMatch(
      body,
      /href="mailto:[^"]+@[^"]+"/,
      "Terms must not contain a fabricated mailto link"
    );
  });

  // ── Legal cross-links between pages ──────────────────────────────────────

  it("/privacy links to /impressum and /terms", async () => {
    const body = await (await fetch(`${baseUrl}/privacy`)).text();
    assert.match(body, /href="\/impressum"/);
    assert.match(body, /href="\/terms"/);
  });

  it("/impressum links to /privacy and /terms", async () => {
    const body = await (await fetch(`${baseUrl}/impressum`)).text();
    assert.match(body, /href="\/privacy"/);
    assert.match(body, /href="\/terms"/);
  });

  it("/terms links to /privacy and /impressum", async () => {
    const body = await (await fetch(`${baseUrl}/terms`)).text();
    assert.match(body, /href="\/privacy"/);
    assert.match(body, /href="\/impressum"/);
  });

  // ── module-06.css is referenced ──────────────────────────────────────────

  it("/privacy references module-06.css", async () => {
    const body = await (await fetch(`${baseUrl}/privacy`)).text();
    assert.match(body, /module-06\.css/);
  });

  it("module-06.css is served correctly", async () => {
    const response = await fetch(`${baseUrl}/assets/noqori/module-06.css`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/css/);
    const body = await response.text();
    assert.match(body, /nqLegalPlaceholder/);
    assert.match(body, /nqLegalNotReady/);
    assert.match(body, /noqori-legal-view/);
  });

  // ── Landing page footer contains legal links ──────────────────────────────

  it("landing page footer contains Privacy link", async () => {
    const body = await (await fetch(`${baseUrl}/`)).text();
    assert.match(body, /href="\/privacy"/);
  });

  it("landing page footer contains Impressum link", async () => {
    const body = await (await fetch(`${baseUrl}/`)).text();
    assert.match(body, /href="\/impressum"/);
  });

  it("landing page footer contains Terms link", async () => {
    const body = await (await fetch(`${baseUrl}/`)).text();
    assert.match(body, /href="\/terms"/);
  });

  // ── Unknown static paths return 404 (not served as assets) ──────────────

  it("unknown non-API non-legal paths return 404", async () => {
    const response = await fetch(`${baseUrl}/some-unknown-page`);
    // static-files.mjs rejects paths that are not index.html, assets/, or legal routes.
    // app.mjs converts the HttpError to a JSON 404 response.
    assert.equal(response.status, 404);
  });

  // ── Legal pages are not exposed as raw /api/ routes ──────────────────────

  it("/api/privacy returns 404 not found", async () => {
    const response = await fetch(`${baseUrl}/api/privacy`);
    assert.equal(response.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Placeholder detection script — logic unit tests
// ---------------------------------------------------------------------------
describe("legal placeholder detection", () => {
  const PLACEHOLDER_PATTERN = /\[REQUIRED BEFORE PUBLIC LAUNCH:[^\]]+\]/g;

  it("detects placeholder strings in privacy.html on disk", async () => {
    const content = await readFile(join(root, "privacy.html"), "utf8");
    const matches = [...content.matchAll(PLACEHOLDER_PATTERN)];
    assert.ok(
      matches.length > 0,
      `privacy.html must contain at least one [REQUIRED BEFORE PUBLIC LAUNCH:…] placeholder. Found ${matches.length}.`
    );
  });

  it("detects placeholder strings in impressum.html on disk", async () => {
    const content = await readFile(join(root, "impressum.html"), "utf8");
    const matches = [...content.matchAll(PLACEHOLDER_PATTERN)];
    assert.ok(
      matches.length > 0,
      `impressum.html must contain at least one [REQUIRED BEFORE PUBLIC LAUNCH:…] placeholder. Found ${matches.length}.`
    );
  });

  it("detects placeholder strings in terms.html on disk", async () => {
    const content = await readFile(join(root, "terms.html"), "utf8");
    const matches = [...content.matchAll(PLACEHOLDER_PATTERN)];
    assert.ok(
      matches.length > 0,
      `terms.html must contain at least one [REQUIRED BEFORE PUBLIC LAUNCH:…] placeholder. Found ${matches.length}.`
    );
  });

  it("pattern correctly identifies a placeholder string", () => {
    const sample = "Contact: [REQUIRED BEFORE PUBLIC LAUNCH: Controller legal name]";
    const matches = [...sample.matchAll(PLACEHOLDER_PATTERN)];
    assert.equal(matches.length, 1);
    assert.match(matches[0][0], /Controller legal name/);
  });

  it("pattern does not flag a resolved value", () => {
    const sample = "Contact: legal@example.com";
    const matches = [...sample.matchAll(PLACEHOLDER_PATTERN)];
    assert.equal(matches.length, 0);
  });
});
