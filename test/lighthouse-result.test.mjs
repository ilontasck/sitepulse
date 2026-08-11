import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapLighthouseResult } from "../src/audit/scanners/lighthouse-result.mjs";

describe("Lighthouse result mapping", () => {
  it("maps lab metrics, category scores, and the TBT proxy honestly", () => {
    const result = mapLighthouseResult({
      lighthouseVersion: "13.4.1",
      requestedUrl: "https://example.com/",
      finalDisplayedUrl: "https://example.com/app",
      fetchTime: "2026-08-10T12:00:00.000Z",
      audits: {
        "largest-contentful-paint": { numericValue: 2300 },
        "cumulative-layout-shift": { numericValue: 0.08 },
        "first-contentful-paint": { numericValue: 1400 },
        "speed-index": { numericValue: 3100 },
        "total-blocking-time": { numericValue: 180 },
        "unused-javascript": { score: 0.5, scoreDisplayMode: "metricSavings", displayValue: "Potential savings of 120 KiB" }
      },
      categories: {
        performance: { score: 0.91 },
        accessibility: { score: 0.88 },
        "best-practices": { score: 0.95 },
        seo: { score: 1 }
      }
    });

    assert.equal(result.signals.lighthouse.metrics.lcpMs, 2300);
    assert.equal(result.signals.lighthouse.metrics.inpMs, null);
    assert.equal(result.signals.lighthouse.metrics.inpLabProxy, "TBT");
    assert.deepEqual(result.signals.lighthouse.scores, {
      performance: 91,
      accessibility: 88,
      bestPractices: 95,
      seo: 100
    });
    assert.equal(result.checks.performance.find((check) => check.id === "lighthouse-cls").passed, true);
    assert.equal(result.checks.accessibility[0].passed, false);
    assert.equal(result.signals.lighthouse.findings[0].auditId, "unused-javascript");
    assert.match(result.signals.lighthouse.findings[0].action, /unused/);
    assert.match(result.warnings[0], /INP is not measured/);
  });

  it("does not score unavailable partial metrics as failures", () => {
    const result = mapLighthouseResult({ audits: {}, categories: {}, runtimeError: { code: "ERRORED_DOCUMENT_REQUEST" } });

    assert.equal(result.checks.performance.length, 0);
    assert.equal(result.checks.accessibility.length, 0);
    assert.match(result.warnings[1], /unavailable/);
    assert.match(result.warnings.at(-1), /did not finish loading normally/);
  });
});
