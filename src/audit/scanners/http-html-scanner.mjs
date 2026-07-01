import { fetchSafeHtml } from "../url-safety.mjs";

export const ctaWords = ["book", "call", "contact", "quote", "buy", "reserve", "schedule", "start", "order"];

export function countMatches(html, pattern) {
  return [...html.matchAll(pattern)].length;
}

export function firstMatch(html, pattern) {
  return html.match(pattern)?.[1]?.trim() || "";
}

export function stripTags(value) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export async function runHttpHtmlScanner(target, options = {}) {
  const result = await fetchSafeHtml(target.normalizedUrl, options);
  const lowerHtml = result.html.toLowerCase();
  const responseHeaders = Object.fromEntries(result.response.headers.entries());

  return {
    target: {
      ...target,
      normalizedUrl: result.finalUrl,
      domain: new URL(result.finalUrl).hostname.replace(/^www\./, "")
    },
    html: result.html,
    response: result.response,
    responseHeaders,
    redirects: result.redirects,
    signals: {
      protocol: new URL(result.finalUrl).protocol,
      https: result.finalUrl.startsWith("https://"),
      hasViewport: /<meta[^>]+name=["']viewport["']/i.test(result.html),
      formCount: countMatches(result.html, /<form\b/gi),
      buttonCount: countMatches(result.html, /<button\b|role=["']button["']/gi),
      ctaKeywordCount: ctaWords.reduce((sum, word) => sum + countMatches(lowerHtml, new RegExp(`\\b${word}\\b`, "g")), 0),
      responseStatus: result.response.status,
      responseTimeMs: result.responseTimeMs,
      htmlBytes: result.htmlBytes,
      redirectCount: result.redirects.length,
      deterministicOffsets: {}
    },
    checks: {
      technical: [
        {
          id: "safe-fetch",
          label: "URL passed SSRF preflight and redirect safety checks.",
          passed: true,
          priority: "high"
        }
      ]
    },
    warnings: result.response.ok ? [] : [`Site responded with HTTP ${result.response.status}.`]
  };
}
