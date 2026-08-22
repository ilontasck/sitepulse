import { isHttpError } from "../http/http-error.mjs";
import { runAccessibilityAdapter } from "./scanners/accessibility-adapter.mjs";
import { runFallbackScanner } from "./scanners/fallback-scanner.mjs";
import { runHttpHtmlScanner } from "./scanners/http-html-scanner.mjs";
import { runPerformanceAdapter } from "./scanners/performance-adapter.mjs";
import { runLighthousePlaywrightAdapter } from "./scanners/lighthouse-playwright-adapter.mjs";
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

function renderedFailure(error) {
  const text = String(error?.message || "");

  if (error?.code === "RENDERED_CONCURRENCY_LIMIT") {
    return { status: "temporarily-unavailable", reason: "concurrency-limit", event: "rendered_concurrency_rejected", warning: "Real-page performance is temporarily busy. The HTML audit completed successfully; try the rendered check again shortly." };
  }
  if (/timeout|exceeded/i.test(text)) {
    return { status: "timed-out", reason: "timeout", event: "rendered_timeout", warning: "The real-page performance check timed out. The HTML audit completed successfully." };
  }
  if (/unsafe|private|internal|addressunreachable/i.test(text)) {
    return { status: "partial", reason: "network-safety", event: "rendered_failure", warning: "The browser check blocked an unsafe network destination. The HTML audit completed successfully." };
  }
  if (/navigation|net::|err_/i.test(text)) {
    return { status: "partial", reason: "navigation", event: "rendered_failure", warning: "The page could not finish loading in the browser. The HTML audit completed successfully." };
  }
  if (/chrome|chromium|browser|crash|target closed/i.test(text)) {
    return { status: "temporarily-unavailable", reason: "chromium-crash", event: "rendered_crash", warning: "Real-page performance stopped unexpectedly. The HTML audit completed successfully." };
  }
  return { status: "temporarily-unavailable", reason: "rendered-error", event: "rendered_failure", warning: "Real-page performance is temporarily unavailable. The HTML audit completed successfully." };
}

function htmlFallbackWarning() {
  return "The website could not be fully reached. SitePulse used limited fallback checks instead of live page data.";
}

export async function scanWebsite(target, options = {}) {
  const htmlScanner = options.htmlScanner || runHttpHtmlScanner;
  const fallbackScanner = options.fallbackScanner || runFallbackScanner;
  const adapters = options.adapters || [runSeoAdapter, runAccessibilityAdapter, runPerformanceAdapter, runSecurityAdapter];
  const renderedAdapter = options.renderedAdapter || runLighthousePlaywrightAdapter;

  if (options.signal?.aborted) throw options.signal.reason || new Error("Audit cancelled.");

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
      checks: { ...(context.checks || {}) },
      renderedStatus: options.renderedAuditEnabled ? "pending" : "disabled"
    };

    for (const adapter of adapters) {
      mergeAdapterResult(scanResult, adapter(context));
    }

    if (options.renderedAuditEnabled) {
      const renderedStartedAt = Date.now();

      try {
        const executeRenderedAudit = () =>
          renderedAdapter(context.target, {
            timeoutMs: options.renderedAuditTimeoutMs,
            resolver: options.resolver,
            signal: options.signal
          });
        const adapterResult = options.renderedAuditLimiter
          ? await options.renderedAuditLimiter.run(executeRenderedAudit)
          : await executeRenderedAudit();

        mergeAdapterResult(scanResult, adapterResult);
        scanResult.renderedStatus = adapterResult.signals?.rendered?.status || "completed";
        options.telemetry?.record("rendered_completed", {
          auditMode: "rendered",
          lighthouseDurationMs: Date.now() - renderedStartedAt,
          outcome: scanResult.renderedStatus
        });
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason || error;
        const failure = renderedFailure(error);
        scanResult.renderedStatus = failure.status;
        scanResult.warnings.push(failure.warning);
        options.telemetry?.record(failure.event, {
          auditMode: "rendered",
          lighthouseDurationMs: Date.now() - renderedStartedAt,
          outcome: "failure",
          reason: failure.reason
        });
        options.telemetry?.record("rendered_fallback", { auditMode: "html", fallbackReason: failure.reason, outcome: "success" });
      }
    }

    return scanResult;
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason || error;
    if (isHttpError(error) && hardFailureCodes.has(error.code)) {
      throw error;
    }

    options.telemetry?.record("html_fallback", { auditMode: "html", fallbackReason: error?.code || "html-scan-error", outcome: "success" });
    return fallbackScanner(target, htmlFallbackWarning());
  }
}
