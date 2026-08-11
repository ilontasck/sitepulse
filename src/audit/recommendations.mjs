const fallbackRecommendations = {
  design: ["Create a clearer above-the-fold value proposition.", "Use a tighter type scale and consistent spacing.", "Replace generic visuals with purposeful service imagery."],
  mobile: ["Add a responsive viewport meta tag.", "Increase tap target sizes.", "Check sticky headers on small viewport heights."],
  performance: ["Compress large assets.", "Defer third-party scripts.", "Keep the initial HTML and critical assets lean."],
  seo: ["Write a unique service/location title.", "Add a clear meta description.", "Use one descriptive H1 on the page."],
  accessibility: ["Add meaningful alt text to images.", "Label every form field.", "Improve contrast on secondary text."],
  trust: ["Use HTTPS for the audited website.", "Add recent testimonials near the CTA.", "Make contact options visible."],
  forms: ["Use action-specific button labels.", "Keep lead forms short.", "Add focus, loading, and success states."],
  content: ["Rewrite hero copy around customer outcomes.", "Add scannable service cards.", "Put hours, location, and FAQs where expected."]
};

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function priorityForRecommendation(text, category) {
  if (category.score < 58) return "high";
  if (/HTTPS|meta description|title|H1|label|alt text|slow|large|Content-Security-Policy|clickjacking|noindex/i.test(text)) {
    return "high";
  }
  if (category.score < 74) return "medium";
  return "low";
}

export function buildRecommendations(category, scanResult) {
  const signals = scanResult.signals;
  const recommendations = [];

  if (category.id === "seo") {
    if (!signals.titleLength) recommendations.push("Add a descriptive page title.");
    if (signals.titleLength > 0 && (signals.titleLength < 25 || signals.titleLength > 65)) recommendations.push("Tune the page title to roughly 25-65 characters.");
    if (!signals.metaDescriptionLength) recommendations.push("Add a meta description that explains the offer and location.");
    if (signals.h1Count !== null && signals.h1Count !== 1) recommendations.push("Use exactly one clear H1 for the primary page topic.");
    if (signals.hasCanonical === false) recommendations.push("Add a canonical URL to clarify the preferred indexed page.");
    if (signals.hasRobotsNoindex) recommendations.push("Remove noindex from robots meta if this page should appear in search.");
    if (signals.hasOpenGraph === false) recommendations.push("Add Open Graph title, description, or image for richer social previews.");
  }

  if (category.id === "mobile" && signals.hasViewport === false) {
    recommendations.push("Add a responsive viewport meta tag for mobile browsers.");
  }

  if (category.id === "accessibility") {
    if (signals.imagesMissingAlt > 0) recommendations.push(`Add alt text to ${signals.imagesMissingAlt} image${signals.imagesMissingAlt === 1 ? "" : "s"}.`);
    if (signals.inputsWithoutLabels > 0) recommendations.push("Connect form inputs to visible labels or aria-labels.");
    if (signals.hasLang === false) recommendations.push("Add a lang attribute to the HTML element for assistive technology.");
    if (signals.buttonsWithoutNames > 0) recommendations.push("Give icon-only or empty buttons readable labels.");
  }

  if (category.id === "performance") {
    const lab = signals.lighthouse;

    if (lab?.metrics.lcpMs > 4_000) {
      recommendations.push(`Main content appears slowly: LCP was ${(lab.metrics.lcpMs / 1_000).toFixed(1)}s. Inspect the LCP element and prioritize its request before tuning less important assets.`);
    } else if (lab?.metrics.lcpMs > 2_500) {
      recommendations.push(`Improve main-content loading: LCP was ${(lab.metrics.lcpMs / 1_000).toFixed(1)}s; aim for 2.5s or faster.`);
    }
    if (lab?.metrics.cls > 0.25) recommendations.push(`The page shifts significantly while loading (CLS ${lab.metrics.cls.toFixed(2)}). Reserve stable space for images, banners, and injected content.`);
    if (lab?.metrics.tbtMs > 600) recommendations.push(`The main thread was blocked for ${Math.round(lab.metrics.tbtMs)}ms. Break up long JavaScript tasks and delay non-essential scripts.`);
    for (const finding of lab?.findings || []) recommendations.push(finding.action);
    if (signals.responseTimeMs > 1800) recommendations.push("Investigate slow server response time and cache static pages.");
    if (signals.htmlBytes > 120_000) recommendations.push("Reduce initial HTML weight and defer non-critical markup.");
    if (signals.scriptCount > 20) recommendations.push(`Reduce script count; ${signals.scriptCount} script tags were found in the HTML.`);
    if (signals.hasCachingHeaders === false) recommendations.push("Add Cache-Control, ETag, or Last-Modified headers for cacheable responses.");
  }

  if (category.id === "trust") {
    if (!signals.https) recommendations.push("Serve the site over HTTPS before sending paid traffic to it.");
    if (signals.hasContentSecurityPolicy === false) recommendations.push("Add a Content-Security-Policy header to reduce script injection risk.");
    if (signals.hasFrameProtection === false) recommendations.push("Add X-Frame-Options or CSP frame-ancestors to reduce clickjacking risk.");
    if (signals.hasReferrerPolicy === false) recommendations.push("Add a Referrer-Policy header to limit unnecessary URL leakage.");
  }

  if (category.id === "forms" && signals.formCount > 0 && signals.inputsWithoutLabels > 0) {
    recommendations.push("Make form fields easier to understand with labels and helper text.");
  }

  if (category.id === "content") {
    if (!signals.titleLength) recommendations.push("Clarify the business offer in the browser title and hero copy.");
    if (signals.ctaKeywordCount === 0) recommendations.push("Add an obvious next-step CTA such as book, call, quote, or contact.");
  }

  return unique([...recommendations, ...fallbackRecommendations[category.id]]).slice(0, 3);
}

export function buildRecommendationDetails(category, recommendations) {
  return recommendations.map((text) => ({
    text,
    priority: priorityForRecommendation(text, category)
  }));
}

export function buildPriorityFixes(categories) {
  return [...categories]
    .sort((a, b) => a.score - b.score)
    .slice(0, 4)
    .map((category, index) => ({
      title: category.recommendations[0],
      category: category.label,
      effort: index < 2 ? "Low" : "Medium",
      impact: category.score < 72 ? "High" : "Medium",
      priority: category.recommendationDetails?.[0]?.priority || (category.score < 72 ? "high" : "medium"),
      description: category.explanation
    }));
}

export function buildTopRecommendations(categories) {
  return categories
    .flatMap((category) =>
      category.recommendations.map((text, index) => ({
        category: category.label,
        text,
        score: category.score,
        priority: category.recommendationDetails?.[index]?.priority || priorityForRecommendation(text, category)
      }))
    )
    .sort((a, b) => a.score - b.score)
    .slice(0, 8)
    .map(({ category, text, priority }) => ({ category, text, priority }));
}
