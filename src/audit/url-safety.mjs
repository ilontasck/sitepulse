import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "../http/http-error.mjs";

const allowedProtocols = new Set(["http:", "https:"]);
const blockedHostnames = new Set(["localhost", "localhost.localdomain"]);
const defaultMaxRedirects = 3;
const defaultMaxHtmlBytes = 250_000;
const defaultTimeoutMs = 4500;

function isPrivateIpv4(address) {
  const parts = address.split(".").map((part) => Number(part));

  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function expandIpv4MappedIpv6(address) {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? mapped[1] : "";
}

function isUnsafeIpv6(address) {
  const normalized = address.toLowerCase();

  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("ff")
  );
}

export function isUnsafeIpAddress(address) {
  const mappedIpv4 = expandIpv4MappedIpv6(address);

  if (mappedIpv4) {
    return isPrivateIpv4(mappedIpv4);
  }

  const type = isIP(address);

  if (type === 4) {
    return isPrivateIpv4(address);
  }

  if (type === 6) {
    return isUnsafeIpv6(address);
  }

  return true;
}

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/\.$/, "");
}

export async function assertSafeUrl(url, options = {}) {
  const resolver = options.resolver || lookup;
  const parsed = url instanceof URL ? url : new URL(url);
  const hostname = normalizeHostname(parsed.hostname);

  if (!allowedProtocols.has(parsed.protocol)) {
    throw new HttpError(400, "Only http and https website URLs are supported.", "UNSUPPORTED_URL_PROTOCOL");
  }

  if (!hostname || blockedHostnames.has(hostname)) {
    throw new HttpError(400, "Localhost and internal URLs cannot be scanned.", "UNSAFE_URL");
  }

  if (isIP(hostname)) {
    if (isUnsafeIpAddress(hostname)) {
      throw new HttpError(400, "Private or internal IP addresses cannot be scanned.", "UNSAFE_URL");
    }

    return parsed;
  }

  const records = await resolver(hostname, { all: true, verbatim: false });

  if (!records.length) {
    throw new HttpError(400, "The website hostname could not be resolved safely.", "HOSTNAME_NOT_RESOLVED");
  }

  const unsafeRecord = records.find((record) => isUnsafeIpAddress(record.address));

  if (unsafeRecord) {
    throw new HttpError(400, "The website resolves to a private or internal network address.", "UNSAFE_URL");
  }

  return parsed;
}

function buildRedirectUrl(location, currentUrl) {
  try {
    return new URL(location, currentUrl);
  } catch {
    throw new HttpError(400, "The website returned an invalid redirect URL.", "UNSAFE_REDIRECT");
  }
}

async function readLimitedText(response, maxBytes) {
  const reader = response.body?.getReader();

  if (!reader) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text);

    if (bytes > maxBytes) {
      throw new HttpError(413, "HTML document is too large to scan safely.", "HTML_TOO_LARGE");
    }

    return { text, bytes };
  }

  const chunks = [];
  let receivedBytes = 0;

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    receivedBytes += value.byteLength;

    if (receivedBytes > maxBytes) {
      throw new HttpError(413, "HTML document is too large to scan safely.", "HTML_TOO_LARGE");
    }

    chunks.push(value);
  }

  return {
    text: Buffer.concat(chunks).toString("utf8"),
    bytes: receivedBytes
  };
}

export async function fetchSafeHtml(inputUrl, options = {}) {
  const fetcher = options.fetcher || fetch;
  const maxRedirects = options.maxRedirects ?? defaultMaxRedirects;
  const maxHtmlBytes = options.maxHtmlBytes ?? defaultMaxHtmlBytes;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const redirects = [];
  let currentUrl = new URL(inputUrl);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    await assertSafeUrl(currentUrl, options);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let response;

    try {
      response = await fetcher(currentUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "SitePulseAuditBot/0.2 (+https://sitepulse.local)"
        },
        redirect: "manual",
        signal: controller.signal
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw new HttpError(504, "Website scan timed out.", "SCAN_TIMEOUT");
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");

      if (!location) {
        throw new HttpError(400, "The website returned a redirect without a location.", "UNSAFE_REDIRECT");
      }

      const nextUrl = buildRedirectUrl(location, currentUrl);
      redirects.push(nextUrl.toString());

      if (redirectCount === maxRedirects) {
        throw new HttpError(400, "The website redirects too many times to scan safely.", "TOO_MANY_REDIRECTS");
      }

      currentUrl = nextUrl;
      continue;
    }

    const contentType = response.headers.get("content-type") || "";
    const contentLength = Number(response.headers.get("content-length") || 0);

    if (!contentType.toLowerCase().includes("text/html")) {
      throw new HttpError(400, `Expected HTML but received ${contentType || "unknown content type"}.`, "NON_HTML_RESPONSE");
    }

    if (contentLength > maxHtmlBytes) {
      throw new HttpError(413, "HTML document is too large to scan safely.", "HTML_TOO_LARGE");
    }

    const html = await readLimitedText(response, maxHtmlBytes);

    return {
      finalUrl: currentUrl.toString().replace(/\/$/, ""),
      redirects,
      response,
      html: html.text,
      htmlBytes: html.bytes,
      responseTimeMs: Date.now() - startedAt
    };
  }

  throw new HttpError(400, "The website redirects too many times to scan safely.", "TOO_MANY_REDIRECTS");
}
