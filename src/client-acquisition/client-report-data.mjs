// Client artifacts use an allowlist, not a blacklist of possible secret names.
const statuses = new Set(["html-audit-completed", "full-rendered-completed", "partial-audit-completed", "rendered-audit-timed-out", "rendered-audit-temporarily-unavailable", "html-fallback-used"]);
const categoryIds = new Set(["design", "mobile", "performance", "seo", "accessibility", "trust", "forms", "content"]);
const priorities = new Set(["critical", "high", "medium", "low", "info"]);
const evidencePatterns = {
  "title-length": /^\d+ characters$/,
  "h1-count": /^\d+ H1 tags$/,
  "image-alt": /^\d+ missing alt attributes$/,
  "input-labels": /^\d+ inputs without labels$/,
  "button-names": /^\d+ unnamed buttons$/,
  "response-time": /^\d+(?:\.\d+)?ms$/,
  "html-size": /^\d+ bytes$/,
  "script-count": /^\d+ script tags$/,
  "stylesheet-count": /^\d+ stylesheets$/,
  "inline-script-size": /^\d+ bytes$/
};
const booleanChecks = new Set(["title-present", "meta-description", "canonical", "robots-indexable", "open-graph", "html-lang", "heading-structure", "caching-headers", "https", "csp", "frame-protection", "nosniff", "referrer-policy", "permissions-policy"]);
export const labChecks = {
  "lighthouse-lcp": ["metrics", "lcpMs", 2500, "ms"],
  "lighthouse-cls": ["metrics", "cls", 0.1, ""],
  "lighthouse-fcp": ["metrics", "fcpMs", 1800, "ms"],
  "lighthouse-speed-index": ["metrics", "speedIndexMs", 3400, "ms"],
  "lighthouse-tbt": ["metrics", "tbtMs", 200, "ms"],
  "lighthouse-performance-score": ["scores", "performance", 90, "/100"],
  "lighthouse-accessibility-score": ["scores", "accessibility", 90, "/100"],
  "lighthouse-best-practices-score": ["scores", "bestPractices", 90, "/100"],
  "lighthouse-seo-score": ["scores", "seo", 90, "/100"]
};
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const invalidReport = () => new TypeError("Ungültiger Scanner-Bericht: categories und checks müssen gültige Listen sein.");

function validateReport(report) {
  if (!record(report) || !Array.isArray(report.categories) || report.categories.length > 100) throw invalidReport();
  for (const key of ["normalizedUrl", "domain"]) {
    if (report[key] != null && typeof report[key] !== "string") throw invalidReport();
  }
  if (report.scanner != null && !record(report.scanner)) throw invalidReport();
  let count = 0;
  for (const category of report.categories) {
    if (!record(category) || (category.checks !== undefined && !Array.isArray(category.checks))) throw invalidReport();
    for (const check of category.checks || []) {
      if (!record(check) || ![true, false, null, undefined].includes(check.passed)) throw invalidReport();
      for (const key of ["id", "label", "details", "priority", "page", "url", "affectedUrl"]) {
        if (check[key] != null && typeof check[key] !== "string") throw invalidReport();
      }
      if (++count > 1000) throw invalidReport();
    }
  }
}

// Paths, credentials, query strings and fragments may contain credentials or personal data.
// Show only the public origin; never resolve or fetch it during export.
function publicOrigin(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.port) return null;
    const host = url.hostname;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(host)) return null;
    if (/(?:^|\.)(?:localhost|local|internal|intranet|lan|home|test)$/i.test(host)) return null;
    return url.origin;
  } catch { return null; }
}

function labData(lab) {
  const result = { metrics: {}, scores: {} };
  for (const [group, key] of Object.values(labChecks)) {
    const value = lab?.[group]?.[key];
    if (Number.isFinite(value) && value >= 0 && (group !== "scores" || value <= 100)) result[group][key] = value;
  }
  return result;
}

export function hasFailedLabMeasurement(check, lab) {
  if (!Object.hasOwn(labChecks, check.id)) return false;
  const [group, key, threshold] = labChecks[check.id];
  const value = lab?.[group]?.[key];
  return Number.isFinite(value) && value >= 0 && (group === "scores" ? value < threshold : value > threshold);
}

export function prepareClientReport(report) {
  if (report === null) return null;
  validateReport(report);
  const lab = labData(report.signals?.lab);
  const normalizedUrl = publicOrigin(report.normalizedUrl);
  const status = statuses.has(report.scanner?.status) ? report.scanner.status : "unknown";
  const checkedAt = typeof report.scanner?.checkedAt === "string" && Number.isFinite(Date.parse(report.scanner.checkedAt))
    ? new Date(report.scanner.checkedAt).toISOString() : null;
  const hasWarnings = [report.warnings, report.scanner?.warnings].some((warnings) => Array.isArray(warnings) && warnings.length);
  return {
    normalizedUrl,
    domain: normalizedUrl ? new URL(normalizedUrl).hostname : "Nicht angegeben",
    overallScore: Number.isFinite(report.overallScore) && report.overallScore >= 0 && report.overallScore <= 100 ? report.overallScore : null,
    scanner: { status, mode: report.scanner?.mode === "fallback" ? "fallback" : "html-real-checks", checkedAt },
    warnings: hasWarnings ? ["Der Scanner meldet Einschränkungen. Interne Warntexte werden aus Datenschutzgründen nicht exportiert; den ursprünglichen Bericht vor Entscheidungen prüfen."] : [],
    signals: { lab },
    categories: report.categories.map((category) => ({
      id: categoryIds.has(category.id) ? category.id : "unknown",
      label: categoryIds.has(category.id) ? category.id : "Scanner-Hinweis",
      recommendations: [],
      checks: (category.checks || []).map((check) => {
        const known = booleanChecks.has(check.id) || Object.hasOwn(evidencePatterns, check.id) || Object.hasOwn(labChecks, check.id);
        const id = known ? check.id : "unknown";
        let details = "";
        if (Object.hasOwn(evidencePatterns, id) && typeof check.details === "string" && check.details.length < 100 && evidencePatterns[id].test(check.details)) details = check.details;
        if (Object.hasOwn(labChecks, id)) {
          const [group, key, , unit] = labChecks[id];
          if (Number.isFinite(lab[group][key])) details = `${lab[group][key]}${unit}`;
        }
        return { id, label: known ? id : "Nicht unterstützte Prüfung", passed: check.passed ?? null, priority: priorities.has(check.priority) ? check.priority : "medium", details, url: publicOrigin(check.page || check.url || check.affectedUrl) || normalizedUrl };
      })
    }))
  };
}
