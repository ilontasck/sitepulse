const severityOrder = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
const categoryOrder = ["forms", "trust", "mobile", "accessibility", "performance", "seo", "content", "design"];
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
  if (/button|form|conversion|trust/i.test(label)) return 0;
  if (/mobile|responsive/i.test(label)) return 2;
  if (/access/i.test(label)) return 3;
  if (/performance/i.test(label)) return 4;
  if (/seo/i.test(label)) return 5;
  return 6;
}

function evidenceFor(check) {
  const evidence = String(check.details || "").trim();
  return evidence.length > 0 ? evidence : null;
}

function metricFromEvidence(evidence) {
  return evidence.match(/\b\d+(?:[.,]\d+)?\s*(?:ms|s|kb|kib|bytes?|%|px)?\b/i)?.[0]?.trim() || null;
}

function affectedUrl(report) {
  return report.signals?.lighthouse?.finalUrl || report.normalizedUrl || null;
}

function recommendationFor(category, failedIndex) {
  return category.recommendations?.[failedIndex]
    || category.recommendations?.[0]
    || "Review this area during the full audit.";
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
        affectedUrl: affectedUrl(report),
        evidence,
        metric: metricFromEvidence(evidence),
        recommendation: recommendationFor(category, failedIndex),
        source: "automated HTML audit"
      });
      failedIndex += 1;
    }
  }

  return findings
    .sort((a, b) => {
      const severity = severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity);
      return severity || categoryRank({ id: a.categoryId, label: a.category }) - categoryRank({ id: b.categoryId, label: b.category }) || a.title.localeCompare(b.title);
    })
    .slice(0, limit);
}

export function countAdditionalFindings(report, selectedFindings) {
  const all = selectMiniAuditFindings(report, { limit: 1000 });
  return Math.max(0, all.length - selectedFindings.length);
}

export function createMiniAudit(report, options = {}) {
  const findings = selectMiniAuditFindings(report, options);
  return {
    website: report?.domain || new URL(report.normalizedUrl).hostname,
    normalizedUrl: report?.normalizedUrl || null,
    findings,
    additionalFindings: countAdditionalFindings(report, findings),
    scannerStatus: report?.scanner?.status || "unknown",
    warnings: Array.isArray(report?.warnings) ? report.warnings : [],
    recommendation: "Full Website Audit"
  };
}
