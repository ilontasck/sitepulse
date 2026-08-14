import { assertSafeUrl } from "../audit/url-safety.mjs";
import { normalizeWebsiteUrl } from "../audit/url-validation.mjs";
import { HttpError } from "./http-error.mjs";
import { resolveAuthenticatedUser } from "./auth-request.mjs";
import { readJsonBody } from "./body.mjs";
import { requireTrustedOrigin } from "./origin-policy.mjs";
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

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function auditJobNotFound() {
  return new HttpError(404, "Audit job was not found.", "AUDIT_JOB_NOT_FOUND");
}

function authenticationRequired() {
  return new HttpError(401, "Sign in to continue.", "AUTHENTICATION_REQUIRED");
}

async function requireAuthenticatedUser(request, response, { authService, cookiePolicy }) {
  response.setHeader("Cache-Control", "private, no-store");
  const user = await resolveAuthenticatedUser(request, { authService, cookiePolicy });
  if (!user) {
    throw authenticationRequired();
  }
  return user;
}

function toPublicJob(job) {
  const publicJob = {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt
  };

  if (job.status === "running") {
    publicJob.startedAt = job.startedAt;
  } else if (job.status === "completed") {
    publicJob.completedAt = job.completedAt;
    publicJob.auditId = job.auditId;
    publicJob.auditUrl = `/api/audits/${job.auditId}`;
  } else if (job.status === "failed") {
    publicJob.failedAt = job.failedAt;
    publicJob.error = {
      code: job.errorCode || "AUDIT_FAILED",
      message: job.errorMessage || "The website could not be audited. Please try again."
    };
  }

  return publicJob;
}

export async function handleAuditApi({
  request,
  response,
  config,
  store,
  jobStore,
  url,
  telemetry,
  authService,
  cookiePolicy,
  rateLimiters,
  initialUrlSafetyValidator = assertSafeUrl
}) {
  if (url.pathname === "/api/audits" && request.method === "POST") {
    const user = await requireAuthenticatedUser(request, response, { authService, cookiePolicy });
    requireTrustedOrigin(request, config.publicOrigin);
    rateLimiters.general(request, response, user);
    rateLimiters.create(request, response, user);
    const body = await readJsonBody(request, config.requestBodyLimitBytes, { strictContentType: true });

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "Request body must be a JSON object.", "INVALID_REQUEST_BODY");
    }

    const websiteUrl = body.websiteUrl ?? body.url;
    const target = normalizeWebsiteUrl(websiteUrl);
    await initialUrlSafetyValidator(target.normalizedUrl);
    const job = jobStore.enqueue({ normalizedUrl: target.normalizedUrl, userId: user.id });
    const statusUrl = `/api/audit-jobs/${job.id}`;
    telemetry?.record("audit_job_enqueued", { jobId: job.id, outcome: "queued" });

    return sendJson(
      response,
      202,
      {
        job: {
          id: job.id,
          status: job.status,
          createdAt: job.createdAt,
          statusUrl
        }
      },
      { Location: statusUrl, "Retry-After": "1" }
    );
  }

  const jobPathMatch = url.pathname.match(/^\/api\/audit-jobs\/([^/]+)$/);

  if (jobPathMatch) {
    if (request.method !== "GET") {
      throw new HttpError(405, "Method is not allowed for this endpoint.", "METHOD_NOT_ALLOWED");
    }

    const user = await requireAuthenticatedUser(request, response, { authService, cookiePolicy });
    rateLimiters.general(request, response, user);

    if (!uuidPattern.test(jobPathMatch[1])) {
      throw auditJobNotFound();
    }

    const job = jobStore.findByIdForUser(jobPathMatch[1], user.id);

    if (!job) {
      throw auditJobNotFound();
    }

    return sendJson(response, 200, { job: toPublicJob(job) });
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
    const user = await requireAuthenticatedUser(request, response, { authService, cookiePolicy });
    rateLimiters.general(request, response, user);
    const audit = await store.findByIdForUser(auditIdMatch[1], user.id);

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

  if (url.pathname.startsWith("/api/audit-jobs")) {
    throw auditJobNotFound();
  }

  return false;
}
