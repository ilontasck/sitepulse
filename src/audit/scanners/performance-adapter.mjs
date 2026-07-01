import { countMatches } from "./http-html-scanner.mjs";

function check(id, label, passed, priority = "medium", details = "") {
  return { id, label, passed, priority, details };
}

function largestInlineBytes(html, tagName) {
  return [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi"))].reduce((largest, match) => {
    const bytes = Buffer.byteLength(match[1] || "");
    return Math.max(largest, bytes);
  }, 0);
}

export function runPerformanceAdapter(context) {
  const html = context.html;
  const headers = context.responseHeaders;
  const scriptCount = countMatches(html, /<script\b/gi);
  const stylesheetCount = countMatches(html, /<link[^>]+rel=["']stylesheet["']/gi);
  const inlineScriptMaxBytes = largestInlineBytes(html, "script");
  const inlineStyleMaxBytes = largestInlineBytes(html, "style");
  const cacheControl = headers["cache-control"] || "";
  const etag = headers.etag || "";
  const lastModified = headers["last-modified"] || "";
  const hasCachingHeaders = Boolean(cacheControl || etag || lastModified);

  return {
    adapter: "performance-hints",
    signals: {
      scriptCount,
      stylesheetCount,
      inlineScriptMaxBytes,
      inlineStyleMaxBytes,
      cacheControl,
      hasCachingHeaders
    },
    checks: {
      performance: [
        check("response-time", "Initial HTML response is reasonably fast.", context.signals.responseTimeMs < 1800, "high", `${context.signals.responseTimeMs}ms`),
        check("html-size", "Initial HTML size is lean.", context.signals.htmlBytes < 120_000, "medium", `${context.signals.htmlBytes} bytes`),
        check("script-count", "Page keeps script count modest.", scriptCount <= 20, "medium", `${scriptCount} script tags`),
        check("stylesheet-count", "Page keeps stylesheet count modest.", stylesheetCount <= 12, "low", `${stylesheetCount} stylesheets`),
        check("inline-script-size", "Inline scripts are not unusually large.", inlineScriptMaxBytes < 40_000, "medium", `${inlineScriptMaxBytes} bytes`),
        check("caching-headers", "Response exposes basic caching validators or cache policy.", hasCachingHeaders, "low")
      ]
    },
    warnings: []
  };
}
