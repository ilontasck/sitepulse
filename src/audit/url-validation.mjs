import { HttpError } from "../http/http-error.mjs";

const blockedHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);
const allowedProtocols = new Set(["http:", "https:"]);

export function normalizeWebsiteUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "Website URL is required.", "URL_REQUIRED");
  }

  if (value.length > 2048) {
    throw new HttpError(400, "Website URL is too long.", "URL_TOO_LONG");
  }

  const raw = value.trim();
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;

  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new HttpError(400, "Use a valid website address, like studio.example.com.", "INVALID_URL");
  }

  const hostname = parsed.hostname.toLowerCase();

  if (!allowedProtocols.has(parsed.protocol)) {
    throw new HttpError(400, "Only http and https website URLs are supported.", "UNSUPPORTED_URL_PROTOCOL");
  }

  if (!hostname.includes(".") || hostname.includes(" ") || blockedHosts.has(hostname)) {
    throw new HttpError(400, "Use a public website domain, like example.com.", "INVALID_PUBLIC_DOMAIN");
  }

  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";

  return {
    normalizedUrl: parsed.toString().replace(/\/$/, ""),
    domain: hostname.replace(/^www\./, "")
  };
}
