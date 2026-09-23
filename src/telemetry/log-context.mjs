import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const context = new AsyncLocalStorage();
export const isCorrelationId = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
// Always server-generated: client identifiers can contain secrets even with valid syntax.
export const createRequestId = () => randomUUID();
export const logContext = () => context.getStore() || {};
export const withLogContext = (fields, callback) => context.run({ ...logContext(), ...fields }, callback);

const routes = new Set(["/api/health", "/api/ready", "/api/operations", "/api/audits", "/api/audits/quota", "/api/audits/history", "/api/auth/config", "/api/auth/register", "/api/auth/login", "/api/auth/logout", "/api/auth/me"]);
export function logRoute(pathname) {
  if (routes.has(pathname)) return pathname;
  if (/^\/api\/audit-jobs\/[^/]+$/.test(pathname)) return "/api/audit-jobs/:id";
  if (/^\/api\/audits\/[^/]+$/.test(pathname)) return "/api/audits/:id";
  return pathname.startsWith("/api/") ? "/api/unknown" : "/static";
}
