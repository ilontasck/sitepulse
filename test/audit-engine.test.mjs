import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpError } from "../src/http/http-error.mjs";
import { calculateOverallScore, generateAudit, scoreStatus } from "../src/audit/audit-engine.mjs";
import { normalizeWebsiteUrl } from "../src/audit/url-validation.mjs";
import { scoreCategories } from "../src/audit/scoring.mjs";
import { createRenderedAuditLimiter } from "../src/audit/rendered-audit-limiter.mjs";

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
    assert.equal(first.scanner.status, "html-fallback-used");
    assert.ok(first.scanner.warnings[0].includes("limited fallback checks"));
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

  it("does not invoke the rendered adapter when the feature flag is disabled", async () => {
    let renderedCalls = 0;
    const report = await generateAudit("https://luna-cafe.com", {
      renderedAuditEnabled: false,
      htmlScanner: async (target) => ({
        mode: "heuristic",
        adapters: ["test-html"],
        checkedAt: "2026-08-11T00:00:00.000Z",
        warnings: [],
        target,
        signals: { deterministicOffsets: {} }
      }),
      renderedAdapter: async () => {
        renderedCalls += 1;
      }
    });

    assert.equal(renderedCalls, 0);
    assert.equal(report.scanner.mode, "heuristic");
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

  it("merges an enabled rendered audit without changing the public report shape", async () => {
    const report = await generateAudit("https://luna-cafe.com", {
      renderedAuditEnabled: true,
      htmlScanner: async (target) => ({
        target,
        html: "<html><title>Luna Cafe</title><h1>Luna</h1></html>",
        responseHeaders: {},
        signals: { https: true, deterministicOffsets: {} },
        checks: {},
        warnings: []
      }),
      adapters: [],
      renderedAdapter: async () => ({
        adapter: "lighthouse-playwright",
        signals: {
          lighthouse: {
            metrics: { lcpMs: 1200, cls: 0.02, tbtMs: 80, inpMs: null, inpLabProxy: "TBT" },
            scores: { performance: 96, accessibility: 94, bestPractices: 92, seo: 98 }
          },
          rendered: { renderedDomBytes: 2048 }
        },
        checks: { performance: [{ id: "lighthouse-lcp", label: "LCP", passed: true, priority: "high" }] },
        warnings: []
      })
    });

    assert.ok(report.scanner.adapters.includes("lighthouse-playwright"));
    assert.equal(report.scanner.status, "full-rendered-completed");
    assert.equal(report.signals.lab.metrics.lcpMs, 1200);
    assert.equal(report.signals.rendered.renderedDomBytes, 2048);
    assert.ok(report.categories.find((category) => category.id === "performance").checks.some((check) => check.id === "lighthouse-lcp"));
    assert.ok(report.overallScore >= 0 && report.overallScore <= 100);
  });

  it("retains HTML results when the rendered audit fails", async () => {
    const report = await generateAudit("https://luna-cafe.com", {
      renderedAuditEnabled: true,
      htmlScanner: async (target) => ({
        target,
        html: "<html><title>Luna Cafe</title><h1>Luna</h1></html>",
        responseHeaders: {},
        signals: { https: true, deterministicOffsets: {} },
        checks: {},
        warnings: []
      }),
      adapters: [],
      renderedAdapter: async () => {
        throw new Error("Chromium crashed");
      }
    });

    assert.equal(report.scanner.mode, "html-real-checks");
    assert.equal(report.signals.lab, null);
    assert.match(report.warnings[0], /HTML audit completed successfully/);
    assert.doesNotMatch(report.warnings[0], /Chromium crashed/);
  });

  it("keeps rendered failure messages user-safe across common failure modes", async () => {
    const failures = [
      ["Rendered audit exceeded 100ms timeout.", /timed out/, "rendered-audit-timed-out"],
      ["net::ERR_NAME_NOT_RESOLVED", /could not finish loading/, "partial-audit-completed"],
      ["Target closed because Chromium crashed", /stopped unexpectedly/, "rendered-audit-temporarily-unavailable"]
    ];

    for (const [technicalMessage, expected, expectedStatus] of failures) {
      const report = await generateAudit("https://luna-cafe.com", {
        renderedAuditEnabled: true,
        htmlScanner: async (target) => ({
          target,
          html: "<html><title>Luna Cafe</title><h1>Luna</h1></html>",
          responseHeaders: {},
          signals: { https: true, deterministicOffsets: {} },
          checks: {},
          warnings: []
        }),
        adapters: [],
        renderedAdapter: async () => {
          throw new Error(technicalMessage);
        }
      });

      assert.match(report.warnings[0], expected);
      assert.doesNotMatch(report.warnings[0], /ERR_|Target closed|exceeded/);
      assert.equal(report.scanner.status, expectedStatus);
    }
  });

  it("keeps simultaneous excess requests on HTML without starting another rendered audit", async () => {
    const limiter = createRenderedAuditLimiter(1);
    let releaseFirst;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let renderedCalls = 0;
    const options = {
      renderedAuditEnabled: true,
      renderedAuditLimiter: limiter,
      htmlScanner: async (target) => ({
        target,
        html: "<html><title>Luna Cafe</title><h1>Luna</h1></html>",
        responseHeaders: {},
        signals: { https: true, deterministicOffsets: {} },
        checks: {},
        warnings: []
      }),
      adapters: [],
      renderedAdapter: async () => {
        renderedCalls += 1;
        markStarted();
        await gate;
        return {
          adapter: "lighthouse-playwright",
          signals: { lighthouse: { metrics: {}, scores: {} }, rendered: { status: "completed" } },
          checks: {},
          warnings: []
        };
      }
    };

    const first = generateAudit("https://first.example", options);
    await started;
    const second = await generateAudit("https://second.example", options);

    assert.equal(renderedCalls, 1);
    assert.equal(second.scanner.status, "rendered-audit-temporarily-unavailable");
    assert.match(second.warnings[0], /temporarily busy/);
    releaseFirst();
    assert.equal((await first).scanner.status, "full-rendered-completed");
    assert.equal(limiter.snapshot().active, 0);
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

  it("contains a catastrophic Lighthouse performance result within its matching category", () => {
    const signals = {
      deterministicOffsets: {},
      https: true,
      titleLength: 40,
      metaDescriptionLength: 120,
      h1Count: 1,
      hasViewport: true,
      imageCount: 2,
      imagesMissingAlt: 0,
      inputsWithoutLabels: 0,
      formCount: 0,
      buttonCount: 2,
      ctaKeywordCount: 1,
      responseTimeMs: 500,
      htmlBytes: 20_000
    };
    const htmlCategories = scoreCategories({ signals });
    const renderedCategories = scoreCategories({ signals: { ...signals, lighthouse: { scores: { performance: 0 } } } });
    const htmlOverall = calculateOverallScore(htmlCategories);
    const renderedOverall = calculateOverallScore(renderedCategories);

    assert.ok(htmlOverall - renderedOverall <= 9);
    assert.deepEqual(
      renderedCategories.filter((category) => category.id !== "performance"),
      htmlCategories.filter((category) => category.id !== "performance")
    );
  });
});
