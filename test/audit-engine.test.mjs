import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpError } from "../src/http/http-error.mjs";
import { calculateOverallScore, generateAudit, scoreStatus } from "../src/audit/audit-engine.mjs";
import { normalizeWebsiteUrl } from "../src/audit/url-validation.mjs";

describe("audit domain", () => {
  it("normalizes valid website URLs", () => {
    assert.deepEqual(normalizeWebsiteUrl("luna-cafe.com"), {
      normalizedUrl: "https://luna-cafe.com",
      domain: "luna-cafe.com"
    });
  });

  it("rejects invalid or private-style URLs", () => {
    assert.throws(() => normalizeWebsiteUrl("not a url"), HttpError);
    assert.throws(() => normalizeWebsiteUrl("http://localhost:3000"), HttpError);
    assert.throws(() => normalizeWebsiteUrl("ftp://example.com"), HttpError);
  });

  it("generates a complete deterministic fallback audit", async () => {
    const options = {
      htmlScanner: async () => {
        throw new Error("network disabled in test");
      }
    };
    const first = await generateAudit("https://luna-cafe.com", options);
    const second = await generateAudit("https://luna-cafe.com", options);

    assert.equal(first.domain, "luna-cafe.com");
    assert.equal(first.categories.length, 8);
    assert.equal(first.priorityFixes.length, 4);
    assert.equal(first.scanner.mode, "fallback");
    assert.ok(first.scanner.warnings[0].includes("Live HTML scanner failed"));
    assert.equal(first.overallScore, second.overallScore);
    assert.deepEqual(first.categories, second.categories);
  });

  it("uses HTML scanner signals when available", async () => {
    const report = await generateAudit("https://luna-cafe.com", {
      htmlScanner: async (target) => ({
        mode: "heuristic",
        adapters: ["test-html"],
        checkedAt: "2026-06-30T00:00:00.000Z",
        warnings: [],
        target,
        signals: {
          protocol: "https:",
          https: true,
          title: "Luna Cafe Berlin Brunch and Coffee",
          titleLength: 35,
          metaDescription: "A warm local cafe for brunch, specialty coffee, and private events in Berlin.",
          metaDescriptionLength: 78,
          h1Count: 1,
          hasViewport: true,
          imageCount: 4,
          imagesMissingAlt: 0,
          formCount: 1,
          inputsWithoutLabels: 0,
          buttonCount: 3,
          ctaKeywordCount: 2,
          responseStatus: 200,
          responseTimeMs: 420,
          htmlBytes: 18_000,
          deterministicOffsets: {}
        }
      })
    });

    assert.equal(report.scanner.mode, "heuristic");
    assert.equal(report.categories.length, 8);
    assert.ok(report.overallScore > 70);
    assert.ok(report.recommendations.length > 0);
  });

  it("runs HTML real-check adapters and returns structured checks", async () => {
    const html = `<!doctype html>
      <html lang="en">
        <head>
          <title>Luna Cafe Berlin Brunch and Coffee</title>
          <meta name="description" content="A warm local cafe for brunch, specialty coffee, and private events in Berlin.">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <link rel="canonical" href="https://luna-cafe.com/">
          <meta property="og:title" content="Luna Cafe">
          <meta property="og:description" content="Brunch and coffee in Berlin.">
          <style>body { color: #111; }</style>
        </head>
        <body>
          <h1>Luna Cafe</h1>
          <img src="/coffee.jpg" alt="Coffee on a cafe table">
          <form><label for="email">Email</label><input id="email" type="email"></form>
          <button>Book a table</button>
          <script src="/app.js"></script>
        </body>
      </html>`;

    const report = await generateAudit("https://luna-cafe.com", {
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      fetcher: async () =>
        new Response(html, {
          status: 200,
          headers: {
            "content-type": "text/html",
            "cache-control": "public, max-age=600",
            "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
            "x-content-type-options": "nosniff",
            "referrer-policy": "strict-origin-when-cross-origin"
          }
        })
    });

    assert.equal(report.scanner.mode, "html-real-checks");
    assert.deepEqual(report.scanner.adapters, ["http-html", "seo", "accessibility", "performance-hints", "security-headers"]);
    assert.equal(report.categories.find((category) => category.id === "seo").checks.some((check) => check.id === "canonical" && check.passed), true);
    assert.equal(report.categories.find((category) => category.id === "accessibility").checks.some((check) => check.id === "image-alt" && check.passed), true);
    assert.equal(report.categories.find((category) => category.id === "performance").checks.some((check) => check.id === "caching-headers" && check.passed), true);
    assert.equal(report.categories.find((category) => category.id === "trust").checks.some((check) => check.id === "csp" && check.passed), true);
    assert.equal(report.recommendations.every((recommendation) => ["high", "medium", "low"].includes(recommendation.priority)), true);
  });

  it("calculates score status bands", () => {
    assert.equal(scoreStatus(91), "Excellent");
    assert.equal(scoreStatus(80), "Strong");
    assert.equal(scoreStatus(63), "Needs work");
    assert.equal(scoreStatus(40), "Critical");
  });

  it("calculates overall score", () => {
    assert.equal(calculateOverallScore([{ score: 70 }, { score: 80 }, { score: 90 }]), 80);
  });
});
