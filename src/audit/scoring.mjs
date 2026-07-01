import { categoryTemplates } from "./category-templates.mjs";

export function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

export function scoreStatus(score) {
  if (score >= 88) return "Excellent";
  if (score >= 74) return "Strong";
  if (score >= 58) return "Needs work";
  return "Critical";
}

export function calculateOverallScore(categories) {
  if (!categories.length) {
    return 0;
  }

  return Math.round(categories.reduce((sum, category) => sum + category.score, 0) / categories.length);
}

function scoreBoolean(value, pointsWhenTrue, pointsWhenFalse = 0) {
  if (value === null || value === undefined) {
    return 0;
  }

  return value ? pointsWhenTrue : pointsWhenFalse;
}

function scoreTitleLength(length) {
  if (!length) return -14;
  if (length >= 25 && length <= 65) return 10;
  if (length >= 15 && length <= 80) return 4;
  return -6;
}

function scoreDescriptionLength(length) {
  if (!length) return -12;
  if (length >= 70 && length <= 165) return 10;
  if (length >= 40 && length <= 220) return 4;
  return -5;
}

function scoreResponseTime(responseTimeMs) {
  if (!responseTimeMs) return 0;
  if (responseTimeMs < 900) return 12;
  if (responseTimeMs < 1800) return 6;
  if (responseTimeMs < 3500) return -4;
  return -12;
}

export function scoreCategories(scanResult) {
  const signals = scanResult.signals;
  const offsets = signals.deterministicOffsets || {};

  const categoryScores = {
    design: 72 + (offsets.design || 0) + scoreBoolean(signals.titleLength > 0, 4, -4) + scoreBoolean((signals.imageCount || 0) > 0, 4, -2),
    mobile: 76 + (offsets.mobile || 0) + scoreBoolean(signals.hasViewport, 12, -12),
    performance: 68 + (offsets.performance || 0) + scoreResponseTime(signals.responseTimeMs) + (signals.htmlBytes && signals.htmlBytes < 120_000 ? 4 : 0),
    seo:
      70 +
      (offsets.seo || 0) +
      scoreTitleLength(signals.titleLength) +
      scoreDescriptionLength(signals.metaDescriptionLength) +
      (signals.h1Count === 1 ? 8 : signals.h1Count === 0 ? -8 : -4) +
      (signals.hasCanonical ? 3 : 0) +
      (signals.hasOpenGraph ? 3 : 0) +
      (signals.hasRobotsNoindex ? -10 : 0),
    accessibility:
      74 +
      (offsets.accessibility || 0) +
      (signals.imagesMissingAlt === 0 ? 8 : signals.imagesMissingAlt === null ? 0 : -Math.min(12, signals.imagesMissingAlt * 2)) +
      (signals.inputsWithoutLabels === 0 ? 6 : signals.inputsWithoutLabels === null ? 0 : -Math.min(12, signals.inputsWithoutLabels * 3)),
    trust:
      66 +
      (offsets.trust || 0) +
      scoreBoolean(signals.https, 10, -12) +
      (signals.ctaKeywordCount > 0 ? 5 : -4) +
      scoreBoolean(signals.hasContentSecurityPolicy, 3, 0) +
      scoreBoolean(signals.hasFrameProtection, 3, 0) +
      scoreBoolean(signals.hasNoSniff, 2, 0),
    forms:
      73 +
      (offsets.forms || 0) +
      (signals.formCount === 0 ? 2 : signals.inputsWithoutLabels === 0 ? 10 : -8) +
      (signals.buttonCount > 0 ? 4 : -3),
    content:
      71 +
      (offsets.content || 0) +
      scoreTitleLength(signals.titleLength) +
      (signals.h1Count === 1 ? 6 : 0) +
      (signals.metaDescriptionLength > 0 ? 5 : -5)
  };

  return categoryTemplates.map((template) => {
    const score = clamp(Math.round(categoryScores[template.id] ?? template.base));

    return {
      id: template.id,
      label: template.label,
      score,
      status: scoreStatus(score),
      explanation: template.explanation,
      impact: score < 64 ? "High" : score < 78 ? "Medium" : "Low"
    };
  });
}
