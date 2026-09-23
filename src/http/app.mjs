import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { createAuthService } from "../auth/auth-service.mjs";
import { createPasswordService } from "../auth/password.mjs";
import { createEmailService } from "../email/delivery.mjs";
import { startEmailOutboxScheduler } from "../email/outbox-scheduler.mjs";
import { startSessionCleanupScheduler } from "../auth/session-cleanup-scheduler.mjs";
import { startDataRetentionCleanupScheduler } from "../privacy/data-retention-cleanup-scheduler.mjs";
import { createSqliteReadinessCheck } from "../health/sqlite-readiness.mjs";
import { createAuditJobStore } from "../storage/audit-job-store.mjs";
import { createAuditStore } from "../storage/audit-store.mjs";
import { createAuthStore } from "../storage/auth-store.mjs";
import { createRetentionCleanupStore } from "../storage/retention-cleanup-store.mjs";
import { createOperationsStore } from "../storage/operations-store.mjs";
import { createEmailOutboxStore } from "../storage/email-outbox-store.mjs";
import { runMigrations } from "../storage/migrations.mjs";
import { createAuditTelemetry } from "../telemetry/audit-telemetry.mjs";
import { safeErrorCode } from "../audit/audit-failure-classifier.mjs";
import { createRequestId, logRoute, withLogContext } from "../telemetry/log-context.mjs";
import { createApiMetrics } from "../telemetry/queue-metrics.mjs";
import { handleAuditApi } from "./audit-routes.mjs";
import { handleOperationsApi } from "./operations-routes.mjs";
import { handleAuthApi } from "./auth-routes.mjs";
import { HttpError } from "./http-error.mjs";
import { isHttpError } from "./http-error.mjs";
import { createRateLimiter } from "./rate-limit.mjs";
import { createSessionCookiePolicy } from "./session-cookie.mjs";
import { applySecurityHeaders } from "./security.mjs";
import { sendJson } from "./respond.mjs";
import { isLegalRoute, serveStaticFile } from "./static-files.mjs";

export function createApp(config, dependencies = {}) {
  const publicRoot = config.projectRoot;
  if (!config.migrationsManagedExternally) {
    (dependencies.runMigrations || runMigrations)(config.databaseFilePath);
  }
  const store = dependencies.store || createAuditStore(config.databaseFilePath);
  const jobStore = dependencies.jobStore || createAuditJobStore(config.databaseFilePath,{auditEmailNotificationsEnabled:config.auditEmailNotificationsEnabled,emailOutboxMaxAttempts:config.emailOutboxMaxAttempts});
  const authStore = dependencies.authStore || createAuthStore(config.databaseFilePath);
  const retentionCleanupStore = dependencies.retentionCleanupStore || createRetentionCleanupStore(config.databaseFilePath);
  const operationsStore = dependencies.operationsStore || createOperationsStore(config.databaseFilePath);
  const emailOutboxStore=dependencies.emailOutboxStore||createEmailOutboxStore(config.databaseFilePath);
  const telemetry = dependencies.telemetry || createAuditTelemetry({ enabled: config.telemetryEnabled && config.env !== "test" });
  const passwordService = dependencies.passwordService || createPasswordService({ maxConcurrency: config.authScryptMaxConcurrency });
  const emailService=dependencies.emailService||createEmailService({adapter:dependencies.emailDeliveryAdapter,publicOrigin:config.publicOrigin,telemetry});
  const authService = dependencies.authService || createAuthService({
    authStore,
    passwordService,
    deliverPasswordReset: dependencies.deliverPasswordReset||emailService.deliverPasswordReset,
    deliverEmailVerification: dependencies.deliverEmailVerification||emailService.deliverEmailVerification,
    emailVerificationRequired:config.emailVerificationRequired,
    emailVerificationTtlMs:config.emailVerificationTtlMs
  });
  const cookiePolicy = dependencies.cookiePolicy || createSessionCookiePolicy({ publicOrigin: config.publicOrigin });
  const readinessCheck = dependencies.readinessCheck || createSqliteReadinessCheck(config.databaseFilePath);
  const enforceRateLimit =
    dependencies.enforceRateLimit ||
    createRateLimiter({
      windowMs: config.rateLimitWindowMs,
      max: config.rateLimitMax
    });
  const authEmailRateLimitKey = randomBytes(32);
  const authRateLimiters = dependencies.authRateLimiters || {
    general: createRateLimiter({
      windowMs: config.authGeneralRateLimitWindowMs,
      max: config.authGeneralRateLimitMax
    }),
    register: createRateLimiter({
      windowMs: config.authRegisterRateLimitWindowMs,
      max: config.authRegisterRateLimitMax
    }),
    login: createRateLimiter({
      windowMs: config.authLoginRateLimitWindowMs,
      max: config.authLoginRateLimitMax
    }),
    loginByEmail: createRateLimiter({
      windowMs: config.authLoginRateLimitWindowMs,
      max: config.authLoginEmailRateLimitMax,
      keySelector: (_request, context) => {
        const normalizedEmail = typeof context?.normalizedEmail === "string" ? context.normalizedEmail : "invalid";
        return `email:${createHmac("sha256", authEmailRateLimitKey).update(normalizedEmail).digest("hex")}`;
      }
    }),
    passwordResetRequest: createRateLimiter({
      windowMs: config.authLoginRateLimitWindowMs,
      max: config.authLoginRateLimitMax
    }),
    passwordResetByEmail: createRateLimiter({
      windowMs: config.authLoginRateLimitWindowMs,
      max: config.authLoginEmailRateLimitMax,
      keySelector: (_request, context) => {
        const normalizedEmail = typeof context?.normalizedEmail === "string" ? context.normalizedEmail : "invalid";
        return `reset-email:${createHmac("sha256", authEmailRateLimitKey).update(normalizedEmail).digest("hex")}`;
      }
    }),
    passwordResetConfirm: createRateLimiter({
      windowMs: config.authLoginRateLimitWindowMs,
      max: config.authLoginRateLimitMax
    }),
    emailVerificationRequest:createRateLimiter({windowMs:config.authLoginRateLimitWindowMs,max:config.authLoginEmailRateLimitMax,keySelector:(_request,user)=>`verify-user:${user.id}`}),
    emailVerificationConfirm:createRateLimiter({windowMs:config.authLoginRateLimitWindowMs,max:config.authLoginRateLimitMax})
  };
  const auditRateLimiters = dependencies.auditRateLimiters || {
    general: createRateLimiter({
      windowMs: config.authGeneralRateLimitWindowMs,
      max: config.authGeneralRateLimitMax,
      keySelector: (_request, user) => `user:${user.id}`
    }),
    create: createRateLimiter({
      windowMs: config.auditUserRateLimitWindowMs,
      max: config.auditUserRateLimitMax,
      keySelector: (_request, user) => `user:${user.id}`
    })
  };
  const apiMetrics = createApiMetrics();
  let stopping = false;

  const server = createServer((request, response) => {
    request.requestId = createRequestId();
    response.setHeader("X-Request-ID", request.requestId);
    return withLogContext({ requestId: request.requestId }, async () => {
      applySecurityHeaders(response);
      const started = performance.now();
      let url;
      let errorCode;
      let logged = false;
      const finish = () => {
        if (logged) return;
        logged = true;
        const fields = { requestId: request.requestId, route: logRoute(url?.pathname || "/api/unknown"),
          method: request.method, statusCode: response.writableFinished ? response.statusCode : 499,
          durationMs: Math.round(performance.now() - started), errorCode };
        if (url?.pathname.startsWith("/api/")) apiMetrics.record(fields);
        telemetry.record("http.request_completed", fields);
      };
      response.once("finish", finish);
      response.once("close", finish);
      try {
        url = new URL(request.url || "/", "http://localhost");
        if (url.pathname.startsWith("/api/")) {
          if (url.pathname.startsWith("/api/auth")) {
            response.setHeader("Cache-Control", "no-store");
          }

          if (request.method === "GET" && url.pathname === "/api/health") {
            response.setHeader("Cache-Control", "no-store");
            return sendJson(response, 200, {
              ok: true,
              service: "sitepulse",
              environment: config.env
            });
          }

          if (request.method === "GET" && url.pathname === "/api/ready") {
            response.setHeader("Cache-Control", "no-store");
            const readiness = await readinessCheck();
            const ready = !stopping && readiness?.ready === true;
            return sendJson(response, ready ? 200 : 503, {
              ok: ready,
              service: "noqori-api",
              status: stopping ? "stopping" : ready ? "ready" : "not-ready"
            });
          }

          enforceRateLimit(request, response);

          const operationsHandled = handleOperationsApi({ request, response, config, url, operationsStore, apiMetrics });
          if (operationsHandled !== false) return operationsHandled;

          const authHandled = await handleAuthApi({
            request,
            response,
            config,
            url,
            authService,
            cookiePolicy,
            rateLimiters: authRateLimiters
          });

          if (authHandled !== false) {
            return authHandled;
          }

          const handled = await handleAuditApi({
            request,
            response,
            config,
            store,
            jobStore,
            url,
            telemetry,
            authService,
            cookiePolicy,
            rateLimiters: auditRateLimiters,
            initialUrlSafetyValidator: dependencies.initialUrlSafetyValidator
          });

          if (handled === false) {
            throw new HttpError(404, "API endpoint was not found.", "API_NOT_FOUND");
          }

          return handled;
        }

        const file = await serveStaticFile(request.url, publicRoot, { legalConfig: config.legal });
        response.writeHead(200, { "Content-Type": file.contentType });
        return response.end(file.body);
      } catch (error) {
        errorCode = safeErrorCode(error);
        telemetry.record("http.request_failed", { requestId: request.requestId, route: logRoute(url?.pathname || "/api/unknown"),
          method: request.method, statusCode: isHttpError(error) ? error.statusCode : 500,
          errorCode, level: isHttpError(error) && error.statusCode < 500 ? "warn" : "error" });
        if (isHttpError(error)) {
          return sendJson(response, error.statusCode, {
            error: {
              code: error.code,
              message: error.message
            }
          });
        }

        if (!url || url.pathname.startsWith("/api/")) {
          return sendJson(response, 500, {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Something went wrong."
            }
          });
        }

        if (isLegalRoute(url?.pathname)) {
          return sendJson(response, 500, {
            error: {
              code: "LEGAL_PAGE_UNAVAILABLE",
              message: "Legal page is unavailable."
            }
          });
        }

        try {
          const fallback = await serveStaticFile("/", join(publicRoot));
          response.writeHead(200, { "Content-Type": fallback.contentType });
          return response.end(fallback.body);
        } catch {
          return sendJson(response, 500, {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Something went wrong."
            }
          });
        }
      }
    });
  });
  const sessionCleanup = (dependencies.startSessionCleanupScheduler || startSessionCleanupScheduler)({
    ...dependencies.sessionCleanupOptions,
    authStore,
    telemetry
  });
  const retentionCleanup = (dependencies.startDataRetentionCleanupScheduler || startDataRetentionCleanupScheduler)({
    ...dependencies.dataRetentionCleanupOptions,
    cleanupStore: retentionCleanupStore,
    telemetry,
    intervalMs: config.dataRetentionCleanupIntervalMs,
    batchSize: config.dataRetentionCleanupBatchSize
  });
  const emailOutbox=(dependencies.startEmailOutboxScheduler||startEmailOutboxScheduler)({...(dependencies.emailOutboxOptions||{}),outboxStore:emailOutboxStore,emailService,telemetry,intervalMs:config.emailOutboxPollIntervalMs,batchSize:config.emailOutboxBatchSize});
  server.once("close", () => {
    sessionCleanup.stop();
    retentionCleanup.stop();
    emailOutbox.stop();
  });
  server.markStopping = () => {
    stopping = true;
  };

  return server;
}
