import { isHttpError } from "../http/http-error.mjs";
import { runAccessibilityAdapter } from "./scanners/accessibility-adapter.mjs";
import { runFallbackScanner } from "./scanners/fallback-scanner.mjs";
import { runHttpHtmlScanner } from "./scanners/http-html-scanner.mjs";
import { runPerformanceAdapter } from "./scanners/performance-adapter.mjs";
import { runSecurityAdapter } from "./scanners/security-adapter.mjs";
import { runSeoAdapter } from "./scanners/seo-adapter.mjs";

const hardFailureCodes = new Set([
  "UNSAFE_URL",
  "UNSAFE_REDIRECT",
  "UNSUPPORTED_URL_PROTOCOL",
  "HOSTNAME_NOT_RESOLVED",
  "TOO_MANY_REDIRECTS",
  "HTML_TOO_LARGE",
  "SCAN_TIMEOUT"
]);

function mergeAdapterResult(scanResult, adapterResult) {
  scanResult.adapters.push(adapterResult.adapter);
  scanResult.warnings.push(...(adapterResult.warnings || []));
  Object.assign(scanResult.signals, adapterResult.signals || {});

  for (const [categoryId, checks] of Object.entries(adapterResult.checks || {})) {
    scanResult.checks[categoryId] = [...(scanResult.checks[categoryId] || []), ...checks];
  }
}

export async function scanWebsite(target, options = {}) {
  const htmlScanner = options.htmlScanner || runHttpHtmlScanner;
  const fallbackScanner = options.fallbackScanner || runFallbackScanner;
  const adapters = options.adapters || [runSeoAdapter, runAccessibilityAdapter, runPerformanceAdapter, runSecurityAdapter];

  try {
    const context = await htmlScanner(target, options);

    if (context.mode && context.adapters && context.signals) {
      return context;
    }

    const scanResult = {
      mode: "html-real-checks",
      adapters: ["http-html"],
      checkedAt: new Date().toISOString(),
      warnings: [...(context.warnings || [])],
      target: context.target,
      signals: { ...(context.signals || {}) },
      checks: { ...(context.checks || {}) }
    };

    for (const adapter of adapters) {
      mergeAdapterResult(scanResult, adapter(context));
    }

    return scanResult;
  } catch (error) {
    if (isHttpError(error) && hardFailureCodes.has(error.code)) {
      throw error;
    }

    return fallbackScanner(target, `Live HTML scanner failed: ${error.message}`);
  }
}
