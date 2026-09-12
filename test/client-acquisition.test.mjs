import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendLeadRecord, createLeadRecord, leadColumns } from "../src/client-acquisition/lead-tracker.mjs";
import { createMiniAudit, renderMiniAuditMarkdown, renderOutreachSnippet } from "../src/client-acquisition/index.mjs";
import { parseMiniAuditArgs } from "../scripts/mini-audit.mjs";
import { generateAudit } from "../src/audit/audit-engine.mjs";

function report(overrides = {}) {
  return {
    normalizedUrl: "https://example.com/",
    domain: "example.com",
    scanner: { status: "html-audit-completed" },
    signals: {}, warnings: [],
    categories: [
      { id: "seo", label: "SEO basics", recommendations: ["Add a title."], checks: [{ label: "A title is present.", passed: false, priority: "high", details: "0 characters" }] },
      { id: "forms", label: "Buttons and forms", recommendations: ["Label the form."], checks: [{ label: "Inputs have labels.", passed: false, priority: "high", details: "2 inputs without labels" }] },
      { id: "accessibility", label: "Accessibility", recommendations: ["Add alt text."], checks: [{ label: "Images have alt text.", passed: false, priority: "medium", details: "3 missing alt attributes" }] },
      { id: "content", label: "Content clarity", recommendations: ["Clarify the offer."], checks: [{ label: "CTA exists.", passed: false, priority: "low", details: "0 CTA keywords" }] },
      ...Array.from({ length: 4 }, (_, index) => ({ id: `extra-${index}`, label: `Extra ${index}`, recommendations: ["Review it."], checks: [] }))
    ],
    ...overrides
  };
}

describe("client acquisition toolkit", () => {
  it("validates one URL and known options before doing work", () => {
    assert.deepEqual(parseMiniAuditArgs(["https://example.com", "--rendered", "--lead", "--company", "Acme"]), {
      url: "https://example.com", lead: true, outreach: true, rendered: true, company: "Acme"
    });
    assert.throws(() => parseMiniAuditArgs([]), /Usage/);
    assert.throws(() => parseMiniAuditArgs(["https://example.com", "--unknown"]), /Unknown option/);
  });

  it("reuses the existing URL validation and rejects private URLs", async () => {
    await assert.rejects(() => generateAudit("http://127.0.0.1:3000"), /public website domain|localhost|private|internal/i);
    await assert.rejects(() => generateAudit("not a URL"), /valid website (address|URL)/i);
  });

  it("ranks evidence-backed findings by sales priority and omits unsupported failures", async () => {
    const mini = createMiniAudit(report({ categories: [{ id: "seo", label: "SEO", recommendations: ["Add title."], checks: [
      { label: "Unsupported", passed: false, priority: "critical", details: "" },
      { label: "Title missing", passed: false, priority: "high", details: "0 characters" }
    ] }, ...report().categories.slice(1)] }));
    assert.deepEqual(mini.findings.map((finding) => finding.title), ["Inputs have labels.", "Title missing", "Images have alt text."]);
    assert.equal(mini.findings[0].severity, "HIGH");
    assert.equal(mini.additionalFindings, 1);
  });

  it("renders client-friendly Markdown and a non-sending outreach draft", () => {
    const mini = createMiniAudit(report());
    const markdown = renderMiniAuditMarkdown(mini);
    const snippet = renderOutreachSnippet(mini);
    assert.match(markdown, /# Mini Website Audit/);
    assert.match(markdown, /Additional findings/);
    assert.match(markdown, /preliminary automated technical check/);
    assert.match(snippet, /automatisiert geprüft/);
    assert.doesNotMatch(snippet, /send|fetch\(/i);
  });

  it("does not promote an empty or evidence-free result into a confirmed problem", () => {
    const mini = createMiniAudit({ normalizedUrl: "https://empty.example", domain: "empty.example", categories: [{ id: "seo", label: "SEO", checks: [{ passed: false, label: "Missing", priority: "high", details: "" }] }] });
    assert.deepEqual(mini.findings, []);
    assert.match(renderMiniAuditMarkdown(mini), /No finding with sufficient evidence/);
  });

  it("writes a CSV lead record with the required columns and escaped values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mini-audit-leads-"));
    const file = join(directory, "leads.csv");
    await appendLeadRecord(file, createLeadRecord({ miniAudit: createMiniAudit(report()), company: 'A "Good" Co' }));
    const content = await readFile(file, "utf8");
    assert.equal(content.split("\n", 1)[0], leadColumns.join(","));
    assert.match(content, /A ""Good"" Co/);
  });
});
