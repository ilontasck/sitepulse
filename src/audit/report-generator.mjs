import { buildPriorityFixes, buildRecommendationDetails, buildRecommendations, buildTopRecommendations } from "./recommendations.mjs";
import { calculateOverallScore, clamp, scoreCategories } from "./scoring.mjs";

export function buildAuditReport(scanResult) {
  const scoredCategories = scoreCategories(scanResult);
  const categories = scoredCategories.map((category) => {
    const recommendations = buildRecommendations(category, scanResult);

    return {
      ...category,
      checks: scanResult.checks?.[category.id] || [],
      recommendations,
      recommendationDetails: buildRecommendationDetails(category, recommendations)
    };
  });
  const sorted = [...categories].sort((a, b) => a.score - b.score);

  return {
    normalizedUrl: scanResult.target.normalizedUrl,
    domain: scanResult.target.domain,
    overallScore: calculateOverallScore(categories),
    categories,
    recommendations: buildTopRecommendations(categories),
    priorityFixes: buildPriorityFixes(categories),
    improvements: sorted.slice(0, 4).map((category) => ({
      metric: category.label,
      before: category.score,
      after: clamp(category.score + 18)
    })),
    signals: {
      brandReadiness: Math.round((categories[0].score + categories[7].score + categories[5].score) / 3),
      conversionReadiness: Math.round((categories[5].score + categories[6].score + categories[1].score) / 3),
      technicalHealth: Math.round((categories[2].score + categories[3].score + categories[4].score) / 3)
    },
    scanner: {
      mode: scanResult.mode,
      adapters: scanResult.adapters,
      checkedAt: scanResult.checkedAt,
      warnings: scanResult.warnings
    },
    warnings: scanResult.warnings
  };
}
