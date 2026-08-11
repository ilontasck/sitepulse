import { generateAudit } from "../audit/audit-engine.mjs";
import { HttpError } from "./http-error.mjs";
import { readJsonBody } from "./body.mjs";
import { sendJson } from "./respond.mjs";

function parseLimit(searchParams) {
  const rawLimit = searchParams.get("limit");

  if (!rawLimit) {
    return 20;
  }

  const limit = Number(rawLimit);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, "Limit must be an integer between 1 and 100.", "INVALID_LIMIT");
  }

  return limit;
}

function requireAdminAccess(request, config) {
  if (!config.adminApiKey) {
    throw new HttpError(404, "Audit history endpoint is not enabled.", "AUDIT_HISTORY_DISABLED");
  }

  const providedKey = request.headers["x-admin-key"];

  if (providedKey !== config.adminApiKey) {
    throw new HttpError(403, "Admin access is required.", "ADMIN_ACCESS_REQUIRED");
  }
}

function toAuditSummary(audit) {
  return {
    id: audit.id,
    createdAt: audit.createdAt,
    domain: audit.domain,
    normalizedUrl: audit.normalizedUrl,
    overallScore: audit.overallScore,
    scannerMode: audit.scannerMode
  };
}

export async function handleAuditApi({ request, response, config, store, url, auditGenerator = generateAudit, renderedAuditLimiter, telemetry }) {
  if (url.pathname === "/api/audits" && request.method === "POST") {
    const body = await readJsonBody(request, config.requestBodyLimitBytes);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "Request body must be a JSON object.", "INVALID_REQUEST_BODY");
    }

    const websiteUrl = body.websiteUrl ?? body.url;
    const startedAt = Date.now();
    let audit;
    let record;

    try {
      audit = await auditGenerator(websiteUrl, {
        renderedAuditEnabled: config.renderedAuditEnabled,
        renderedAuditTimeoutMs: config.renderedAuditTimeoutMs,
        renderedAuditLimiter,
        telemetry
      });
      record = await store.create(audit);
    } catch (error) {
      telemetry?.record("audit_failed", {
        auditMode: config.renderedAuditEnabled ? "rendered" : "html",
        durationMs: Date.now() - startedAt,
        outcome: "failure",
        reason: error?.code || "audit-error"
      });
      throw error;
    }

    telemetry?.record("audit_completed", {
      auditMode: audit.scanner?.adapters?.includes("lighthouse-playwright") ? "rendered" : "html",
      durationMs: Date.now() - startedAt,
      outcome: "success",
      fallbackReason: ["html-audit-completed", "full-rendered-completed"].includes(audit.scanner?.status) ? "none" : audit.scanner?.status || "none"
    });

    return sendJson(response, 201, {
      audit: record
    });
  }

  if (url.pathname === "/api/audits" && request.method === "GET") {
    requireAdminAccess(request, config);
    const audits = await store.list({ limit: parseLimit(url.searchParams) });

    return sendJson(response, 200, {
      audits: audits.map(toAuditSummary)
    });
  }

  const auditIdMatch = url.pathname.match(/^\/api\/audits\/([0-9a-f-]{36})$/i);

  if (auditIdMatch && request.method === "GET") {
    const audit = await store.findById(auditIdMatch[1]);

    if (!audit) {
      throw new HttpError(404, "Audit report was not found.", "AUDIT_NOT_FOUND");
    }

    return sendJson(response, 200, {
      audit
    });
  }

  if (url.pathname.startsWith("/api/audits")) {
    throw new HttpError(405, "Method is not allowed for this endpoint.", "METHOD_NOT_ALLOWED");
  }

  return false;
}
