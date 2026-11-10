import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { chromium } from "playwright";
import { createClientPdfModel, renderClientAuditHtml, exportClientAuditPdf } from "../src/client-acquisition/client-pdf.mjs";
import { prepareClientReport } from "../src/client-acquisition/client-report-data.mjs";
import { parseMiniAuditArgs, runMiniAudit } from "../scripts/mini-audit.mjs";
import { localClientReport } from "./fixtures/client-pdf-report.mjs";

test("offline CLI is explicit and disables outreach", () => {
  const args = parseMiniAuditArgs(["--from-json", "report.json"]);
  assert.equal(args.pdf, true);
  assert.equal(args.outreach, false);
  assert.throws(() => parseMiniAuditArgs(["https://example.com", "--from-json", "r.json"]));
  assert.throws(() => parseMiniAuditArgs(["--from-json", "r.json", "--rendered"]));
});

test("real adapter observations, heuristics, scores and unmeasured metrics stay distinct", async () => {
  const report = await localClientReport();
  const model = createClientPdfModel(report);
  assert.equal(model.score, report.overallScore);
  assert.ok(model.findings.some((f) => f.confirmed && f.evidence === "1 missing alt attributes"));
  assert.ok(model.findings.some((f) => !f.confirmed && /Formular/.test(f.title)));
  assert.match(renderClientAuditHtml(report), /Keine Lighthouse-Metriken gemessen/);
  assert.doesNotMatch(renderClientAuditHtml(report), /<th>LCP/);
  report.signals.lab = { metrics: { lcpMs: 2501, cls: 0, tbtMs: null, fcpMs: -1 } };
  const html = renderClientAuditHtml(report);
  assert.match(html, /2\.501 ms/);
  assert.match(html, /<th>CLS<\/th><td>0 /);
  assert.doesNotMatch(html, /<th>TBT|<th>FCP/);
});

test("empty, failed, fallback and unknown reports cannot imply successful measurement", async () => {
  for (const report of [null, { categories: [] }, { categories: [], overallScore: 100, scanner: { status: "html-audit-completed" } }]) {
    assert.equal(createClientPdfModel(report).score, null);
    assert.match(renderClientAuditHtml(report), /Nicht verfügbar/);
  }
  const report = await localClientReport();
  report.scanner.status = "html-fallback-used";
  report.scanner.mode = "fallback";
  assert.equal(createClientPdfModel(report).score, null);
  assert.equal(createClientPdfModel(report).findings.filter((f) => f.confirmed).length, 0);
  report.scanner.status = "unknown";
  assert.equal(createClientPdfModel(report).score, null);
  assert.throws(() => renderClientAuditHtml({}), /categories/);
});

test("unknown checks remain unconfirmed and all failures survive export", async () => {
  const report = await localClientReport();
  report.categories = [{ checks: Array.from({ length: 40 }, (_, i) => ({ id: i === 0 ? "__proto__" : `custom-${i}`, label: `Prüfung ${i}`, passed: false, details: `Beleg ${i}`, priority: "constructor" })) }];
  const model = createClientPdfModel(report);
  assert.equal(model.findings.length, 40);
  assert.equal(model.findings.filter((f) => f.confirmed).length, 0);
  assert.doesNotMatch(renderClientAuditHtml(report), /Beleg 39/);
});

test("Chromium renders German glyphs and hostile strings as text without requests", async () => {
  const report = await localClientReport();
  const hostile = '<img src="https://attacker.invalid/pixel" onerror="alert(1)"><script>window.injected=true</script>& " Grüße ÄÖÜ äöü ß';
  report.warnings = [hostile];
  report.categories[0].checks.push({ id: "unknown", label: hostile, details: hostile, url: hostile, passed: false });
  const html = renderClientAuditHtml(report, { company: hostile });
  assert.doesNotMatch(html, /<script>|<img /);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.setContent(html);
    assert.match(await page.locator("body").innerText(), /Grüße ÄÖÜ äöü ß/);
    assert.equal(await page.locator("script, img").count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.deepEqual(requests, []);
    const session = await page.context().newCDPSession(page);
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".intro" });
    const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
    assert.ok(fonts.some((font) => font.glyphCount > 0), "German customer text uses an actual font");
  } finally { await browser.close(); }
});

test("actual PDFs export offline through CLI and handle empty results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sitepulse-pdf-"));
  try {
    const input = join(directory, "report.json");
    await writeFile(input, JSON.stringify(await localClientReport()));
    const result = await runMiniAudit(parseMiniAuditArgs(["--from-json", input, "--company", "Bäckerei Müller & Söhne"]), { projectRoot: directory, auditGenerator: () => { throw new Error("Must never scan"); } });
    assert.deepEqual(JSON.parse(await readFile(result.jsonPath, "utf8")), prepareClientReport(JSON.parse(await readFile(input, "utf8"))));
    assert.equal(result.outreachPath, null);
    assert.equal(result.leadPath, null);
    assert.equal((await readFile(result.pdfPath)).subarray(0, 5).toString(), "%PDF-");
    const empty = await exportClientAuditPdf(null, { outputPath: join(directory, "empty.pdf") });
    assert.ok(empty.length > 10000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("client projection omits credentials, cookies and internal diagnostics in every artifact", async () => {
  const report = await localClientReport();
  report.normalizedUrl = "https://username:SECRET_PASSWORD@fixture.example/SECRET_PATH?token=SECRET_TOKEN#SECRET_FRAGMENT";
  report.domain = "SECRET_DOMAIN";
  report.scanner.checkedAt = "SECRET_DATE";
  report.scanner.warnings = ["Cookie: SECRET_COOKIE"];
  report.warnings = ["Authorization: Bearer SECRET_BEARER at /Users/SECRET_USER/db"];
  report.internal = { apiKey: "SECRET_APIKEY", headers: { cookie: "SECRET_HEADER" } };
  report.categories[0].checks.push({ id: "response-time", label: "SECRET_LABEL", details: "Cookie: SECRET_DETAIL", passed: false, url: "http://127.0.0.1/SECRET_INTERNAL" });
  const sanitized = prepareClientReport(report);
  assert.equal(sanitized.normalizedUrl, "https://fixture.example");
  assert.doesNotMatch(JSON.stringify(sanitized), /SECRET_/);
  assert.deepEqual(prepareClientReport(sanitized), sanitized, "projection is stable on re-export");
  const html = renderClientAuditHtml(report);
  assert.doesNotMatch(html, /SECRET_/);
  const directory = await mkdtemp(join(tmpdir(), "sitepulse-private-pdf-"));
  try {
    const input = join(directory, "input.json");
    await writeFile(input, JSON.stringify(report));
    const result = await runMiniAudit(parseMiniAuditArgs(["--from-json", input]), { projectRoot: directory });
    for (const path of [result.reportPath, result.jsonPath]) assert.doesNotMatch(await readFile(path, "utf8"), /SECRET_/);
    assert.doesNotMatch(JSON.stringify(result.miniAudit), /SECRET_/);
    assert.match(await readFile(input, "utf8"), /SECRET_TOKEN/, "original remains untouched");
    const failed = await runMiniAudit({ pdf: true, url: "https://fixture.example/SECRET_PATH?token=SECRET_TOKEN" }, { projectRoot: directory, auditGenerator: async () => { throw new Error("SECRET_INTERNAL"); } });
    assert.doesNotMatch(await readFile(failed.reportPath, "utf8"), /SECRET_/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing or contradicting lab measurements and empty numeric evidence never confirm failures", () => {
  const report = { scanner: { status: "html-audit-completed" }, categories: [{ checks: [
    { id: "lighthouse-lcp", passed: false, details: "No metric available" },
    { id: "response-time", passed: false },
    { id: "image-alt", passed: false }
  ] }], signals: { lab: { metrics: {} } } };
  assert.equal(createClientPdfModel(report).findings.filter((f) => f.confirmed).length, 0);
  report.categories[0].checks[1].details = "1ms";
  report.categories[0].checks[2].details = "0 missing alt attributes";
  assert.equal(createClientPdfModel(report).findings.filter((f) => f.confirmed).length, 0);
  report.signals.lab.metrics.lcpMs = 1000;
  assert.equal(createClientPdfModel(report).findings.filter((f) => f.confirmed).length, 0);
  report.signals.lab.metrics.lcpMs = 3000;
  assert.equal(createClientPdfModel(report).findings.filter((f) => f.confirmed).length, 1);
  assert.match(renderClientAuditHtml(report), /3000ms/);
});

test("malformed nested input is rejected with safe errors before writing", async () => {
  for (const report of [undefined, { categories: [null] }, { categories: [{ checks: {} }] }, { categories: [{ checks: [null] }] }, { categories: [{ checks: [{ id: {} }] }] }]) {
    assert.throws(() => createClientPdfModel(report), /Ungültiger Scanner-Bericht/);
  }
  const directory = await mkdtemp(join(tmpdir(), "sitepulse-invalid-pdf-"));
  try {
    const input = join(directory, "invalid.json");
    await writeFile(input, '{"SECRET_TOKEN":');
    await assert.rejects(() => runMiniAudit(parseMiniAuditArgs(["--from-json", input]), { projectRoot: directory }), { message: "Scanner JSON could not be read or is invalid." });
    await assert.rejects(() => readFile(join(directory, "reports", "leads", "provided-website-mini-audit.md")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
