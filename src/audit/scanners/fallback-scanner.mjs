function stableHash(input) {
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash >>> 0);
}

function seededScore(seed, index, base) {
  const wave = Math.sin(seed * (index + 1) * 0.000013) * 10000;
  return Math.round(base + ((wave - Math.floor(wave)) * 28 - 14));
}

export function runFallbackScanner(target, reason = "Live scanner unavailable.") {
  const seed = stableHash(target.domain);

  return {
    mode: "fallback",
    adapters: ["domain-heuristic"],
    checkedAt: new Date().toISOString(),
    warnings: [reason],
    target,
    signals: {
      protocol: new URL(target.normalizedUrl).protocol,
      https: target.normalizedUrl.startsWith("https://"),
      title: null,
      titleLength: 0,
      metaDescription: null,
      metaDescriptionLength: 0,
      h1Count: null,
      hasViewport: null,
      imageCount: null,
      imagesMissingAlt: null,
      formCount: null,
      inputsWithoutLabels: null,
      buttonCount: null,
      ctaKeywordCount: null,
      responseStatus: null,
      responseTimeMs: null,
      htmlBytes: null,
      deterministicOffsets: {
        design: seededScore(seed, 0, 0),
        mobile: seededScore(seed, 1, 0),
        performance: seededScore(seed, 2, 0),
        seo: seededScore(seed, 3, 0),
        accessibility: seededScore(seed, 4, 0),
        trust: seededScore(seed, 5, 0),
        forms: seededScore(seed, 6, 0),
        content: seededScore(seed, 7, 0)
      }
    }
  };
}
