import { createServer } from "node:http";
import { join } from "node:path";
import { createAuthService } from "../auth/auth-service.mjs";
import { createPasswordService } from "../auth/password.mjs";
import { startSessionCleanupScheduler } from "../auth/session-cleanup-scheduler.mjs";
import { createSqliteReadinessCheck } from "../health/sqlite-readiness.mjs";
import { createAuditJobStore } from "../storage/audit-job-store.mjs";
import { createAuditStore } from "../storage/audit-store.mjs";
import { createAuthStore } from "../storage/auth-store.mjs";
import { runMigrations } from "../storage/migrations.mjs";
import { createAuditTelemetry } from "../telemetry/audit-telemetry.mjs";
import { handleAuditApi } from "./audit-routes.mjs";
import { handleAuthApi } from "./auth-routes.mjs";
import { HttpError } from "./http-error.mjs";
import { isHttpError } from "./http-error.mjs";
import { createRateLimiter } from "./rate-limit.mjs";
import { createSessionCookiePolicy } from "./session-cookie.mjs";
import { applySecurityHeaders } from "./security.mjs";
import { sendJson } from "./respond.mjs";
import { serveStaticFile } from "./static-files.mjs";

export function createApp(config, dependencies = {}) {
  const publicRoot = config.projectRoot;
  if (!config.migrationsManagedExternally) {
    (dependencies.runMigrations || runMigrations)(config.databaseFilePath);
  }
  const store = dependencies.store || createAuditStore(config.databaseFilePath);
  const jobStore = dependencies.jobStore || createAuditJobStore(config.databaseFilePath);
  const authStore = dependencies.authStore || createAuthStore(config.databaseFilePath);
  const passwordService = dependencies.passwordService || createPasswordService({ maxConcurrency: config.authScryptMaxConcurrency });
  const authService = dependencies.authService || createAuthService({ authStore, passwordService });
  const cookiePolicy = dependencies.cookiePolicy || createSessionCookiePolicy({ publicOrigin: config.publicOrigin });
  const telemetry = dependencies.telemetry || createAuditTelemetry({ enabled: config.telemetryEnabled && config.env !== "test" });
  const readinessCheck = dependencies.readinessCheck || createSqliteReadinessCheck(config.databaseFilePath);
  const enforceRateLimit =
    dependencies.enforceRateLimit ||
    createRateLimiter({
      windowMs: config.rateLimitWindowMs,
      max: config.rateLimitMax
    });
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
    })
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
  let stopping = false;

  const server = createServer(async (request, response) => {
    applySecurityHeaders(response);
    const url = new URL(request.url || "/", `http://${config.host}:${config.port}`);

    try {
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

      const file = await serveStaticFile(request.url, publicRoot);
      response.writeHead(200, { "Content-Type": file.contentType });
      return response.end(file.body);
    } catch (error) {
      if (isHttpError(error)) {
        return sendJson(response, error.statusCode, {
          error: {
            code: error.code,
            message: error.message
          }
        });
      }

      if (url.pathname.startsWith("/api/")) {
        return sendJson(response, 500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Something went wrong."
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
  const sessionCleanup = (dependencies.startSessionCleanupScheduler || startSessionCleanupScheduler)({
    ...dependencies.sessionCleanupOptions,
    authStore,
    telemetry
  });
  server.once("close", () => sessionCleanup.stop());
  server.markStopping = () => {
    stopping = true;
  };

  return server;
}
