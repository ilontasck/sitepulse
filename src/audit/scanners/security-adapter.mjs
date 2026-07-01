function check(id, label, passed, priority = "medium", details = "") {
  return { id, label, passed, priority, details };
}

export function runSecurityAdapter(context) {
  const headers = context.responseHeaders;
  const contentSecurityPolicy = headers["content-security-policy"] || "";
  const xFrameOptions = headers["x-frame-options"] || "";
  const xContentTypeOptions = headers["x-content-type-options"] || "";
  const referrerPolicy = headers["referrer-policy"] || "";
  const permissionsPolicy = headers["permissions-policy"] || "";
  const hasFrameProtection = Boolean(xFrameOptions || /frame-ancestors/i.test(contentSecurityPolicy));

  return {
    adapter: "security-headers",
    signals: {
      contentSecurityPolicy,
      hasContentSecurityPolicy: Boolean(contentSecurityPolicy),
      xFrameOptions,
      hasFrameProtection,
      xContentTypeOptions,
      hasNoSniff: /\bnosniff\b/i.test(xContentTypeOptions),
      referrerPolicy,
      hasReferrerPolicy: Boolean(referrerPolicy),
      permissionsPolicy,
      hasPermissionsPolicy: Boolean(permissionsPolicy)
    },
    checks: {
      trust: [
        check("https", "Website is served over HTTPS.", context.signals.https, "high"),
        check("csp", "Response includes Content-Security-Policy.", Boolean(contentSecurityPolicy), "medium"),
        check("frame-protection", "Response protects against clickjacking.", hasFrameProtection, "medium"),
        check("nosniff", "Response sets X-Content-Type-Options: nosniff.", /\bnosniff\b/i.test(xContentTypeOptions), "low"),
        check("referrer-policy", "Response includes Referrer-Policy.", Boolean(referrerPolicy), "low"),
        check("permissions-policy", "Response includes Permissions-Policy.", Boolean(permissionsPolicy), "low")
      ]
    },
    warnings: []
  };
}
