const severityOrder = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
const categoryOrder = ["forms", "mobile", "accessibility", "performance", "seo", "trust", "content", "design"];
const allowedSeverities = new Set(severityOrder);

function normalizeSeverity(value) {
  const severity = String(value || "MEDIUM").toUpperCase();
  return allowedSeverities.has(severity) ? severity : "MEDIUM";
}

function categoryRank(category) {
  const id = String(category.id || "");
  const label = String(category.label || "");
  const index = categoryOrder.indexOf(id);
  if (index >= 0) return index;
  if (/button|form|conversion/i.test(label)) return 0;
  if (/mobile|responsive/i.test(label)) return 2;
  if (/access/i.test(label)) return 3;
  if (/performance/i.test(label)) return 4;
  if (/seo/i.test(label)) return 5;
  if (/trust|security/i.test(label)) return 5;
  return 6;
}

function evidenceFor(check) {
  const evidence = String(check.details || "").trim();
  return evidence.length > 0 ? evidence : null;
}

function metricFromEvidence(evidence) {
  return evidence.match(/\b\d+(?:[.,]\d+)?\s*(?:ms|s|kb|kib|bytes?|%|px)?\b/i)?.[0]?.trim() || null;
}

function affectedUrl(report, check) {
  if (check.page || check.url || check.affectedUrl) return check.page || check.url || check.affectedUrl;
  return report.signals?.lab?.finalUrl || report.signals?.lighthouse?.finalUrl || report.normalizedUrl || null;
}

function recommendationFor(category, check, failedIndex) {
  const label = `${check.id || ""} ${check.label || ""}`;
  const matchers = [
    [/input-label|form|label/i, /label|field/], [/image-alt|alt/i, /alt text|image/],
    [/button-name|button/i, /button|action/], [/title-length/i, /tune|title/],
    [/title/i, /title|offer/], [/h1|heading/i, /H1|heading/], [/viewport/i, /viewport/],
    [/canonical/i, /canonical|duplicate|index/], [/robots|indexable/i, /robots|index/],
    [/open-graph|social/i, /social|sharing|open graph/], [/meta-description|description/i, /description|snippet/],
    [/html-lang|language/i, /language|lang/], [/heading-structure/i, /heading|structure/], [/cta|call.?to.?action/i, /call|action|conversion/],
    [/response-time|server-response/i, /response|server/], [/html-size/i, /HTML|markup/],
    [/script-count|javascript/i, /script/], [/caching/i, /Cache|cache/],
    [/lcp|cls|tbt|lighthouse/i, /LCP|layout|thread|Lighthouse|image/]
  ];
  const matched = matchers.find(([pattern]) => pattern.test(label));
  if (matched) {
    const candidate = category.recommendations?.find((item) => matched[1].test(item));
    if (candidate) return candidate;
  }
  return category.recommendations?.[0] || "Review this area during the full audit.";
}

export function selectMiniAuditFindings(report, { limit = 3 } = {}) {
  if (!report || !Array.isArray(report.categories)) return [];
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError("Finding limit must be an integer between 1 and 1000.");
  }

  const findings = [];
  for (const category of report.categories) {
    let failedIndex = 0;
    for (const check of category.checks || []) {
      if (check?.passed !== false) continue;
      const evidence = evidenceFor(check);
      if (!evidence) continue;
      findings.push({
        category: category.label || category.id || "Audit finding",
        categoryId: category.id || null,
        severity: normalizeSeverity(check.priority),
        title: String(check.label || "Confirmed issue"),
        explanation: `The automated audit found this issue on the page. Evidence: ${evidence}.`,
        affectedUrl: affectedUrl(report, check),
        evidence,
        metric: metricFromEvidence(evidence),
        recommendation: recommendationFor(category, check, failedIndex),
        source: "automated HTML audit"
      });
      failedIndex += 1;
    }
  }

  return findings
    .sort((a, b) => {
      const category = categoryRank({ id: a.categoryId, label: a.category }) - categoryRank({ id: b.categoryId, label: b.category });
      const severity = severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity);
      return category || severity || a.title.localeCompare(b.title);
    })
    .slice(0, limit);
}

export function countAdditionalFindings(report, selectedFindings) {
  const all = selectMiniAuditFindings(report, { limit: 1000 });
  return Math.max(0, all.length - selectedFindings.length);
}

export function createMiniAudit(report, options = {}) {
  const findings = selectMiniAuditFindings(report, options);
  const normalizedUrl = report?.normalizedUrl || options.inputUrl || null;
  let website = report?.domain || "provided website";
  try { if (!report?.domain && normalizedUrl) website = new URL(normalizedUrl).hostname; } catch {}
  return {
    website,
    normalizedUrl,
    findings,
    additionalFindings: countAdditionalFindings(report, findings),
    scannerStatus: report?.scanner?.status || "unknown",
    warnings: Array.isArray(report?.warnings) ? report.warnings : report ? [] : ["The automated audit could not be completed safely. No confirmed finding was generated."],
    recommendation: "Full Website Audit"
  };
}
