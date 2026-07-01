import { createServer } from "node:http";
import { join } from "node:path";
import { createAuditStore } from "../storage/audit-store.mjs";
import { handleAuditApi } from "./audit-routes.mjs";
import { HttpError } from "./http-error.mjs";
import { isHttpError } from "./http-error.mjs";
import { createRateLimiter } from "./rate-limit.mjs";
import { applySecurityHeaders } from "./security.mjs";
import { sendJson } from "./respond.mjs";
import { serveStaticFile } from "./static-files.mjs";

export function createApp(config, dependencies = {}) {
  const publicRoot = config.projectRoot;
  const store = dependencies.store || createAuditStore(config.databaseFilePath);
  const auditGenerator = dependencies.auditGenerator;
  const enforceRateLimit =
    dependencies.enforceRateLimit ||
    createRateLimiter({
      windowMs: config.rateLimitWindowMs,
      max: config.rateLimitMax
    });

  return createServer(async (request, response) => {
    applySecurityHeaders(response);
    const url = new URL(request.url || "/", `http://${config.host}:${config.port}`);

    try {
      if (url.pathname.startsWith("/api/")) {
        enforceRateLimit(request, response);

        if (request.method === "GET" && url.pathname === "/api/health") {
          return sendJson(response, 200, {
            ok: true,
            service: "sitepulse",
            environment: config.env
          });
        }

        const handled = await handleAuditApi({ request, response, config, store, url, auditGenerator });

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
}
