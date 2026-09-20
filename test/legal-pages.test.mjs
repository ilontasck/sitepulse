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
import { checkLegalReadiness, inspectLegalTemplate } from "../scripts/check-legal-placeholders.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const publicLegalValues = {
  LEGAL_PUBLICATION_READY: "true",
  LEGAL_OPERATOR_NAME: "Example Operator",
  LEGAL_OPERATOR_ADDRESS_LINE1: "Example Street 1",
  LEGAL_OPERATOR_POSTAL_CODE: "12345",
  LEGAL_OPERATOR_CITY: "Example City",
  LEGAL_OPERATOR_COUNTRY: "Germany",
  LEGAL_CONTACT_EMAIL: "legal@example.test",
  LEGAL_PUBLICATION_DATE: "2026-09-20",
  LEGAL_HOSTING_PROVIDER: "Example Hosting",
  LEGAL_HOSTING_COUNTRY: "Germany",
  LEGAL_SERVER_LOCATION: "Example Region",
  LEGAL_PROCESS_LOG_RETENTION: "30 days, except incident or legal retention",
  LEGAL_AUDIT_REPORT_RETENTION: "30 days for current authenticated/free reports"
};

async function withLegalServer(overrides, callback) {
  const dir = mkdtempSync(join(tmpdir(), "sitepulse-legal-runtime-"));
  const config = loadConfig({
    PORT: 0,
    NODE_ENV: "test",
    AUTH_REGISTRATION_MODE: "closed",
    DATABASE_FILE_PATH: join(dir, "sitepulse.sqlite"),
    ...overrides
  });
  const localServer = createApp(config);
  await new Promise((resolve) => localServer.listen(0, "127.0.0.1", resolve));
  try {
    await callback(`http://127.0.0.1:${localServer.address().port}`);
  } finally {
    await new Promise((resolve) => localServer.close(resolve));
  }
}

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
      AUTH_REGISTRATION_MODE: "closed",
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

  // ── Development readiness gate ────────────────────────────────────────────

  it("/privacy is visibly a draft without exposing template variables", async () => {
    const body = await (await fetch(`${baseUrl}/privacy`)).text();
    assert.match(
      body,
      /Draft — not approved for public launch/,
      "Privacy page must identify an unconfigured development draft"
    );
    assert.doesNotMatch(body, /{{|REQUIRED BEFORE PUBLIC LAUNCH/);
  });

  it("/impressum is visibly a draft without exposing template variables", async () => {
    const body = await (await fetch(`${baseUrl}/impressum`)).text();
    assert.match(
      body,
      /Draft — not approved for public launch/,
      "Impressum must identify an unconfigured development draft"
    );
    assert.doesNotMatch(body, /{{|REQUIRED BEFORE PUBLIC LAUNCH/);
  });

  it("/terms is visibly a draft without exposing template variables", async () => {
    const body = await (await fetch(`${baseUrl}/terms`)).text();
    assert.match(
      body,
      /Draft — not approved for public launch/,
      "Terms must identify an unconfigured development draft"
    );
    assert.doesNotMatch(body, /{{|REQUIRED BEFORE PUBLIC LAUNCH/);
  });

  it("renders escaped public runtime values through real legal routes", async () => {
    await withLegalServer({
      ...publicLegalValues,
      LEGAL_OPERATOR_NAME: "Operator <script>alert(1)</script>",
      LEGAL_OPERATOR_ADDRESS_LINE1: "A & B Street 1"
    }, async (runtimeBaseUrl) => {
      for (const route of ["privacy", "impressum", "terms"]) {
        const body = await (await fetch(`${runtimeBaseUrl}/${route}`)).text();
        assert.match(body, /Operator &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.doesNotMatch(body, /<script>alert\(1\)<\/script>/);
        assert.doesNotMatch(body, /nqLegalNotReady/);
        assert.doesNotMatch(body, /data-tone="review"|PUBLIC-LAUNCH BLOCKER|Requires legal review/);
      }
      const impressum = await (await fetch(`${runtimeBaseUrl}/impressum`)).text();
      assert.match(impressum, /A &amp; B Street 1/);
      assert.doesNotMatch(impressum, /id="register"|id="umsatzsteuer"|<dt>Telefon<\/dt>/);
    });
  });

  it("shows optional phone, register, and VAT sections only when configured", async () => {
    await withLegalServer({
      ...publicLegalValues,
      LEGAL_CONTACT_PHONE: "+49 000 000000",
      LEGAL_REGISTER_NAME: "Example Register",
      LEGAL_REGISTER_NUMBER: "EX 123",
      LEGAL_VAT_ID: "DE000000000"
    }, async (runtimeBaseUrl) => {
      const body = await (await fetch(`${runtimeBaseUrl}/impressum`)).text();
      assert.match(body, /id="register"/);
      assert.match(body, /Example Register/);
      assert.match(body, /EX 123/);
      assert.match(body, /id="umsatzsteuer"/);
      assert.match(body, /DE000000000/);
      assert.match(body, /\+49 000 000000/);
    });
  });

  it("publishes the NRW supervisory authority and no obsolete TTDSG reference", async () => {
    const body = await (await fetch(`${baseUrl}/privacy`)).text();
    assert.match(body, /Landesbeauftragte für Datenschutz und Informationsfreiheit Nordrhein-Westfalen/);
    assert.match(body, /poststelle@ldi\.nrw\.de/);
    assert.doesNotMatch(body, /TTDSG/);
  });

  it("matches the implemented thirty-day report and account deletion policy", async () => {
    await withLegalServer(publicLegalValues, async (runtimeBaseUrl) => {
      const body = await (await fetch(`${runtimeBaseUrl}/privacy`)).text();
      assert.match(body, /retained for no more than 30 days from creation/);
      assert.match(body, /inaccessible immediately and is physically removed/);
      assert.match(body, /physically\s+purged no later than 30 days after the request/);
      assert.match(body, /infrastructure remains part of STE-14/);
      assert.doesNotMatch(body, /No automatic deletion currently implemented|retention period or defensible retention criteria|Pro tier/i);
    });
  });

  it("contains no hardcoded operator contact data in legal templates", async () => {
    const source = (await Promise.all(
      ["privacy.html", "impressum.html", "terms.html"].map((fileName) =>
        readFile(join(root, fileName), "utf8")
      )
    )).join("\n");
    const emails = source.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu) || [];
    assert.deepEqual(emails, ["poststelle@ldi.nrw.de"]);
    assert.doesNotMatch(source, /\+49[\s\d()/-]{6,}/u);
    assert.doesNotMatch(source.replace("40213", ""), /\b\d{5}\b/u);
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
describe("legal template and publication checks", () => {
  it("contains no old launch markers or unknown template variables", async () => {
    for (const fileName of ["privacy.html", "impressum.html", "terms.html"]) {
      const inspection = inspectLegalTemplate(await readFile(join(root, fileName), "utf8"));
      assert.deepEqual(inspection, { oldMarkers: [], unknownDirectives: [] });
    }
  });

  it("keeps development usable while the public gate remains closed", async () => {
    const report = await checkLegalReadiness({ LEGAL_PUBLICATION_READY: "false" });
    assert.equal(report.templatesValid, true);
    assert.equal(report.ready, false);
    assert.equal(report.missingRequiredFields.includes("LEGAL_OPERATOR_NAME"), true);
  });

  it("validates a complete public runtime configuration", async () => {
    const report = await checkLegalReadiness(publicLegalValues);
    assert.equal(report.templatesValid, true);
    assert.equal(report.ready, true);
    assert.deepEqual(report.missingRequiredFields, []);
  });

  it("detects old, unknown, lowercase, and malformed placeholder syntax", () => {
    assert.deepEqual(inspectLegalTemplate("[REQUIRED BEFORE PUBLIC LAUNCH: name] {{LEGAL_UNKNOWN}}"), {
      oldMarkers: ["[REQUIRED BEFORE PUBLIC LAUNCH: name]"],
      unknownDirectives: ["{{LEGAL_UNKNOWN}}"]
    });
    assert.deepEqual(inspectLegalTemplate("{{legal_operator_name}} {{LEGAL-OPERATOR}} {{LEGAL_OPERATOR_NAME"), {
      oldMarkers: [],
      unknownDirectives: ["malformed template directive"]
    });
  });
});

describe("static CSP compatibility", () => {
  for (const fileName of ["index.html", "privacy.html", "impressum.html", "terms.html"]) {
    it(`${fileName} contains no inline executable code or styles`, async () => {
      const content = await readFile(join(root, fileName), "utf8");

      assert.doesNotMatch(content, /<style\b/i);
      assert.doesNotMatch(content, /<script(?![^>]*\bsrc=)[^>]*>/i);
      assert.doesNotMatch(content, /\son[a-z]+\s*=/i);
      assert.doesNotMatch(content, /\sstyle\s*=/i);
    });
  }
});
