const terminalFailures = new Map([
  ["URL_REQUIRED", "Website URL is required."],
  ["URL_TOO_LONG", "Website URL is too long."],
  ["INVALID_URL", "Use a valid public website address."],
  ["INVALID_PUBLIC_DOMAIN", "Use a public website domain."],
  ["UNSUPPORTED_URL_PROTOCOL", "Only HTTP and HTTPS website URLs are supported."],
  ["UNSAFE_URL", "Private or internal website addresses cannot be audited."],
  ["UNSAFE_REDIRECT", "The website redirected to an unsafe destination."],
  ["SSRF_BLOCKED", "The website destination was blocked by the audit security policy."],
  ["NETWORK_POLICY_REJECTED", "The website destination was blocked by the audit security policy."],
  ["TOO_MANY_REDIRECTS", "The website redirects too many times to audit safely."],
  ["HTML_TOO_LARGE", "The website document is too large to audit safely."],
  ["NON_HTML_RESPONSE", "The website did not return an HTML document."],
  ["INVALID_REQUEST_BODY", "The audit request is invalid."],
  ["INVALID_JSON", "The audit request is invalid."],
  ["EMPTY_BODY", "The audit request is invalid."],
  ["UNSUPPORTED_MEDIA_TYPE", "The audit request is invalid."],
  ["REQUEST_TOO_LARGE", "The audit request is invalid."]
]);

const retryableFailures = new Map([
  ["SCAN_TIMEOUT", "The website audit timed out. SitePulse will try once more."],
  ["AUDIT_TIMEOUT", "The website audit timed out. SitePulse will try once more."],
  ["EAI_AGAIN", "The website network lookup is temporarily unavailable."],
  ["ETIMEDOUT", "The website connection timed out."],
  ["ECONNRESET", "The website connection was interrupted."],
  ["ECONNREFUSED", "The website connection was temporarily refused."],
  ["ENETUNREACH", "The website network is temporarily unreachable."],
  ["EHOSTUNREACH", "The website host is temporarily unreachable."],
  ["HOSTNAME_NOT_RESOLVED", "The website hostname could not be resolved safely."],
  ["CHROMIUM_CRASH", "The browser audit stopped unexpectedly."],
  ["BROWSER_CRASH", "The browser audit stopped unexpectedly."],
  ["RENDERED_CONCURRENCY_LIMIT", "Browser audit capacity is temporarily unavailable."],
  ["SQLITE_BUSY", "Audit storage is temporarily busy."]
]);

const genericFailure = {
  disposition: "fail",
  code: "AUDIT_FAILED",
  message: "The website could not be audited. Please try again."
};

const retryableTypes = new Map([
  ["AuditTimeoutError", "AUDIT_TIMEOUT"],
  ["ChromiumCrashError", "CHROMIUM_CRASH"],
  ["BrowserCrashError", "BROWSER_CRASH"]
]);

export function classifyAuditFailure(error, { phase } = {}) {
  if (phase !== "preflight" && phase !== "worker") {
    throw new TypeError("Audit failure phase must be preflight or worker.");
  }

  const typedCode = retryableTypes.get(error?.name) || "";
  const code = typeof error?.code === "string" ? error.code : typedCode;

  if (terminalFailures.has(code)) {
    return { disposition: "fail", code, message: terminalFailures.get(code) };
  }

  if (code === "HOSTNAME_NOT_RESOLVED" && phase === "preflight") {
    return { disposition: "fail", code, message: retryableFailures.get(code) };
  }

  if (phase === "worker" && retryableFailures.has(code)) {
    return { disposition: "retry", code, message: retryableFailures.get(code) };
  }

  if (phase === "worker" && error?.retryable === true && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
    return {
      disposition: "retry",
      code,
      message: "The audit encountered a temporary infrastructure problem. SitePulse will try once more."
    };
  }

  return { ...genericFailure };
}
