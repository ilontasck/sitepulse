function numericAudit(lhr, id) {
  const value = lhr.audits?.[id]?.numericValue;
  return Number.isFinite(value) ? value : null;
}

function categoryScore(lhr, id) {
  const score = lhr.categories?.[id]?.score;
  return Number.isFinite(score) ? Math.round(score * 100) : null;
}

function metricCheck(id, label, value, threshold, unit, priority = "high") {
  if (value === null) return null;

  return {
    id,
    label,
    passed: value <= threshold,
    priority,
    details: `${Math.round(value * (unit === "" ? 1000 : 1)) / (unit === "" ? 1000 : 1)}${unit}`
  };
}

function scoreCheck(id, label, value, priority = "medium") {
  if (value === null) return null;

  return {
    id,
    label,
    passed: value >= 90,
    priority,
    details: `${value}/100`
  };
}

const confirmedFindingDefinitions = [
  ["lcp-discovery-insight", "Prioritize the main visual", "The LCP resource was discovered late. Avoid lazy-loading the main visual and preload it only when it is the confirmed LCP asset."],
  ["image-delivery-insight", "Optimize oversized images", "Serve appropriately sized modern images and compress the image files identified by Lighthouse."],
  ["render-blocking-insight", "Remove render-blocking work", "Defer non-critical scripts and styles identified by Lighthouse; keep only critical above-the-fold CSS on the initial path."],
  ["unused-javascript", "Reduce unused JavaScript", "Remove or split JavaScript that Lighthouse confirmed was downloaded but unused during page load."],
  ["server-response-time", "Improve initial server response", "Cache the page where appropriate and investigate backend or hosting latency before optimizing front-end assets."],
  ["cls-culprits-insight", "Reserve space for shifting content", "Add stable dimensions or reserved space for the elements Lighthouse identified as layout-shift contributors."],
  ["third-parties-insight", "Reduce third-party main-thread work", "Delay or remove non-essential third-party scripts identified by Lighthouse until after the main content is usable."]
];

function confirmedFindings(lhr) {
  return confirmedFindingDefinitions.flatMap(([auditId, title, action]) => {
    const audit = lhr.audits?.[auditId];

    if (!audit || audit.score === null || audit.score >= 1 || audit.scoreDisplayMode === "notApplicable") {
      return [];
    }

    return [{ auditId, title, action, displayValue: audit.displayValue || null }];
  });
}

export function mapLighthouseResult(lhr, diagnostics = {}) {
  const metrics = {
    lcpMs: numericAudit(lhr, "largest-contentful-paint"),
    cls: numericAudit(lhr, "cumulative-layout-shift"),
    fcpMs: numericAudit(lhr, "first-contentful-paint"),
    speedIndexMs: numericAudit(lhr, "speed-index"),
    tbtMs: numericAudit(lhr, "total-blocking-time"),
    inpMs: null,
    inpLabProxy: "TBT"
  };
  const scores = {
    performance: categoryScore(lhr, "performance"),
    accessibility: categoryScore(lhr, "accessibility"),
    bestPractices: categoryScore(lhr, "best-practices"),
    seo: categoryScore(lhr, "seo")
  };
  const findings = confirmedFindings(lhr);
  const unavailableMetrics = Object.entries(metrics)
    .filter(([key, value]) => key !== "inpMs" && value === null)
    .map(([key]) => key);
  const warnings = ["INP is not measured in this lab audit; TBT is reported as a diagnostic proxy, not a substitute for field INP."];

  if (unavailableMetrics.length) {
    warnings.push(`Some lab metrics were unavailable: ${unavailableMetrics.join(", ")}. They were not scored as failures.`);
  }

  if (diagnostics.blockedUnsafeRequestCount > 0) {
    warnings.push(`${diagnostics.blockedUnsafeRequestCount} browser request(s) were blocked by SitePulse network safety checks; rendered results may be partial.`);
  }

  if (lhr.runtimeError) {
    warnings.push("The page did not finish loading normally in Chromium. SitePulse kept the Lighthouse data that was available.");
  }
  const renderedStatus = unavailableMetrics.length || diagnostics.blockedUnsafeRequestCount > 0 || lhr.runtimeError ? "partial" : "completed";

  return {
    adapter: "lighthouse-playwright",
    signals: {
      lighthouse: {
        metrics,
        scores,
        requestedUrl: lhr.requestedUrl || null,
        finalUrl: lhr.finalDisplayedUrl || lhr.finalUrl || null,
        lighthouseVersion: lhr.lighthouseVersion || null,
        fetchTime: lhr.fetchTime || null,
        findings
      },
      rendered: { ...diagnostics, status: renderedStatus }
    },
    checks: {
      performance: [
        metricCheck("lighthouse-lcp", "Largest Contentful Paint is 2.5s or faster.", metrics.lcpMs, 2_500, "ms"),
        metricCheck("lighthouse-cls", "Cumulative Layout Shift is 0.1 or lower.", metrics.cls, 0.1, ""),
        metricCheck("lighthouse-fcp", "First Contentful Paint is 1.8s or faster.", metrics.fcpMs, 1_800, "ms", "medium"),
        metricCheck("lighthouse-speed-index", "Speed Index is 3.4s or faster.", metrics.speedIndexMs, 3_400, "ms", "medium"),
        metricCheck("lighthouse-tbt", "Total Blocking Time, the lab proxy for INP, is 200ms or lower.", metrics.tbtMs, 200, "ms"),
        scoreCheck("lighthouse-performance-score", "Lighthouse performance score is 90 or higher.", scores.performance)
      ].filter(Boolean),
      accessibility: [scoreCheck("lighthouse-accessibility-score", "Lighthouse accessibility score is 90 or higher.", scores.accessibility, "high")].filter(Boolean),
      trust: [scoreCheck("lighthouse-best-practices-score", "Lighthouse best-practices score is 90 or higher.", scores.bestPractices)].filter(Boolean),
      seo: [scoreCheck("lighthouse-seo-score", "Lighthouse SEO score is 90 or higher.", scores.seo)].filter(Boolean)
    },
    warnings
  };
}
