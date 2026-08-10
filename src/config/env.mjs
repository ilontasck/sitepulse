import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

function parsePort(value) {
  const port = Number(value ?? 3000);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }

  return port;
}

function parsePositiveInteger(name, value, fallback) {
  const parsed = Number(value ?? fallback);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

export function loadConfig(overrides = {}) {
  const databaseFilePath =
    overrides.DATABASE_FILE_PATH ||
    process.env.DATABASE_FILE_PATH ||
    `${projectRoot}data/sitepulse.sqlite`;

  return {
    env: overrides.NODE_ENV || process.env.NODE_ENV || "development",
    host: overrides.HOST || process.env.HOST || "127.0.0.1",
    port: parsePort(overrides.PORT ?? process.env.PORT),
    projectRoot,
    adminApiKey: overrides.ADMIN_API_KEY || process.env.ADMIN_API_KEY || "",
    databaseFilePath,
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
    rateLimitMax: parsePositiveInteger("RATE_LIMIT_MAX", overrides.RATE_LIMIT_MAX ?? process.env.RATE_LIMIT_MAX, 60)
  };
}
