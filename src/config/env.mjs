import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

function parsePort(name, value, fallback) {
  const port = Number(value ?? fallback);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} must be an integer between 0 and 65535.`);
  }

  return port;
}

function parseLoopbackHost(name, value, fallback) {
  const host = String(value ?? fallback);
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error(`${name} must be 127.0.0.1 or ::1.`);
  }
  return host;
}

function parsePositiveInteger(name, value, fallback) {
  const parsed = Number(value ?? fallback);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function parseBoundedPositiveInteger(name, value, fallback, maximum) {
  const parsed = parsePositiveInteger(name, value, fallback);
  if (parsed > maximum) {
    throw new Error(`${name} must be at most ${maximum}.`);
  }
  return parsed;
}

function parseBoolean(name, value, fallback = false) {
  const normalized = String(value ?? fallback).toLowerCase();

  if (normalized !== "true" && normalized !== "false") {
    throw new Error(`${name} must be true or false.`);
  }

  return normalized === "true";
}

function parsePublicOrigin(value, { environment, host, port }) {
  if (!value) {
    if (environment === "production") {
      throw new Error("PUBLIC_ORIGIN is required in production.");
    }
    const safeHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return `http://${safeHost}:${port}`;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be an absolute HTTP or HTTPS origin.");
  }

  if (
    !new Set(["http:", "https:"]).has(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin === "null"
  ) {
    throw new Error("PUBLIC_ORIGIN must be an absolute HTTP or HTTPS origin without a path, query, or fragment.");
  }
  if (environment === "production" && parsed.protocol !== "https:") {
    throw new Error("PUBLIC_ORIGIN must use HTTPS in production.");
  }
  return parsed.origin;
}

export function loadConfig(overrides = {}) {
  const env = overrides.NODE_ENV || process.env.NODE_ENV || "development";
  const host = overrides.HOST || process.env.HOST || "127.0.0.1";
  const port = parsePort("PORT", overrides.PORT ?? process.env.PORT, 3000);
  const databaseFilePath =
    overrides.DATABASE_FILE_PATH ||
    process.env.DATABASE_FILE_PATH ||
    `${projectRoot}data/sitepulse.sqlite`;

  const auditJobLeaseMs = parsePositiveInteger(
    "AUDIT_JOB_LEASE_MS",
    overrides.AUDIT_JOB_LEASE_MS ?? process.env.AUDIT_JOB_LEASE_MS,
    30_000
  );
  const auditJobHeartbeatMs = parsePositiveInteger(
    "AUDIT_JOB_HEARTBEAT_MS",
    overrides.AUDIT_JOB_HEARTBEAT_MS ?? process.env.AUDIT_JOB_HEARTBEAT_MS,
    10_000
  );

  if (auditJobHeartbeatMs >= auditJobLeaseMs) {
    throw new Error("AUDIT_JOB_HEARTBEAT_MS must be shorter than AUDIT_JOB_LEASE_MS.");
  }

  return {
    env,
    host,
    port,
    publicOrigin: parsePublicOrigin(overrides.PUBLIC_ORIGIN ?? process.env.PUBLIC_ORIGIN, {
      environment: env,
      host,
      port
    }),
    projectRoot,
    adminApiKey: overrides.ADMIN_API_KEY || process.env.ADMIN_API_KEY || "",
    databaseFilePath,
    migrationsManagedExternally: parseBoolean(
      "MIGRATIONS_MANAGED_EXTERNALLY",
      overrides.MIGRATIONS_MANAGED_EXTERNALLY ?? process.env.MIGRATIONS_MANAGED_EXTERNALLY,
      false
    ),
    requestBodyLimitBytes: parsePositiveInteger(
      "REQUEST_BODY_LIMIT_BYTES",
      overrides.REQUEST_BODY_LIMIT_BYTES ?? process.env.REQUEST_BODY_LIMIT_BYTES,
      32_768
    ),
    rateLimitWindowMs: parsePositiveInteger(
      "RATE_LIMIT_WINDOW_MS",
      overrides.RATE_LIMIT_WINDOW_MS ?? process.env.RATE_LIMIT_WINDOW_MS,
      60_000
    ),
    rateLimitMax: parsePositiveInteger("RATE_LIMIT_MAX", overrides.RATE_LIMIT_MAX ?? process.env.RATE_LIMIT_MAX, 60),
    renderedAuditEnabled: parseBoolean(
      "RENDERED_AUDIT_ENABLED",
      overrides.RENDERED_AUDIT_ENABLED ?? process.env.RENDERED_AUDIT_ENABLED,
      false
    ),
    renderedAuditTimeoutMs: parsePositiveInteger(
      "RENDERED_AUDIT_TIMEOUT_MS",
      overrides.RENDERED_AUDIT_TIMEOUT_MS ?? process.env.RENDERED_AUDIT_TIMEOUT_MS,
      45_000
    ),
    renderedAuditMaxConcurrency: parsePositiveInteger(
      "RENDERED_AUDIT_MAX_CONCURRENCY",
      overrides.RENDERED_AUDIT_MAX_CONCURRENCY ?? process.env.RENDERED_AUDIT_MAX_CONCURRENCY,
      1
    ),
    auditWorkerPollIntervalMs: parsePositiveInteger(
      "AUDIT_WORKER_POLL_INTERVAL_MS",
      overrides.AUDIT_WORKER_POLL_INTERVAL_MS ?? process.env.AUDIT_WORKER_POLL_INTERVAL_MS,
      500
    ),
    workerHealthHost: parseLoopbackHost(
      "WORKER_HEALTH_HOST",
      overrides.WORKER_HEALTH_HOST ?? process.env.WORKER_HEALTH_HOST,
      "127.0.0.1"
    ),
    workerHealthPort: parsePort(
      "WORKER_HEALTH_PORT",
      overrides.WORKER_HEALTH_PORT ?? process.env.WORKER_HEALTH_PORT,
      3001
    ),
    auditJobLeaseMs,
    auditJobHeartbeatMs,
    authScryptMaxConcurrency: parseBoundedPositiveInteger(
      "AUTH_SCRYPT_MAX_CONCURRENCY",
      overrides.AUTH_SCRYPT_MAX_CONCURRENCY ?? process.env.AUTH_SCRYPT_MAX_CONCURRENCY,
      1,
      4
    ),
    authRegisterRateLimitWindowMs: parsePositiveInteger(
      "AUTH_REGISTER_RATE_LIMIT_WINDOW_MS",
      overrides.AUTH_REGISTER_RATE_LIMIT_WINDOW_MS ?? process.env.AUTH_REGISTER_RATE_LIMIT_WINDOW_MS,
      3_600_000
    ),
    authRegisterRateLimitMax: parsePositiveInteger(
      "AUTH_REGISTER_RATE_LIMIT_MAX",
      overrides.AUTH_REGISTER_RATE_LIMIT_MAX ?? process.env.AUTH_REGISTER_RATE_LIMIT_MAX,
      5
    ),
    authLoginRateLimitWindowMs: parsePositiveInteger(
      "AUTH_LOGIN_RATE_LIMIT_WINDOW_MS",
      overrides.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS ?? process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
      900_000
    ),
    authLoginRateLimitMax: parsePositiveInteger(
      "AUTH_LOGIN_RATE_LIMIT_MAX",
      overrides.AUTH_LOGIN_RATE_LIMIT_MAX ?? process.env.AUTH_LOGIN_RATE_LIMIT_MAX,
      30
    ),
    authGeneralRateLimitWindowMs: parsePositiveInteger(
      "AUTH_GENERAL_RATE_LIMIT_WINDOW_MS",
      overrides.AUTH_GENERAL_RATE_LIMIT_WINDOW_MS ?? process.env.AUTH_GENERAL_RATE_LIMIT_WINDOW_MS,
      60_000
    ),
    authGeneralRateLimitMax: parsePositiveInteger(
      "AUTH_GENERAL_RATE_LIMIT_MAX",
      overrides.AUTH_GENERAL_RATE_LIMIT_MAX ?? process.env.AUTH_GENERAL_RATE_LIMIT_MAX,
      120
    ),
    auditUserRateLimitWindowMs: parsePositiveInteger(
      "AUDIT_USER_RATE_LIMIT_WINDOW_MS",
      overrides.AUDIT_USER_RATE_LIMIT_WINDOW_MS ?? process.env.AUDIT_USER_RATE_LIMIT_WINDOW_MS,
      3_600_000
    ),
    auditUserRateLimitMax: parsePositiveInteger(
      "AUDIT_USER_RATE_LIMIT_MAX",
      overrides.AUDIT_USER_RATE_LIMIT_MAX ?? process.env.AUDIT_USER_RATE_LIMIT_MAX,
      10
    ),
    telemetryEnabled: parseBoolean("TELEMETRY_ENABLED", overrides.TELEMETRY_ENABLED ?? process.env.TELEMETRY_ENABLED, true)
  };
}
