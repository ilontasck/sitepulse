import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "../http/http-error.mjs";

const allowedProtocols = new Set(["http:", "https:"]);
const blockedHostnames = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google.internal."
]);
const blockedHostnameSuffixes = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa"];
const defaultMaxRedirects = 3;
// Modern application homepages commonly inline framework/bootstrap data well above
// 250 KB. Keep a hard cap, but leave enough room to audit representative JS-heavy
// pages such as react.dev without treating ordinary HTML as an attack payload.
const defaultMaxHtmlBytes = 1_500_000;
const defaultTimeoutMs = 4500;

function isPrivateIpv4(address) {
  const parts = address.split(".").map((part) => Number(part));

  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b, c] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6(address) {
  let normalized = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const ipv4Tail = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];

  if (ipv4Tail) {
    const parts = ipv4Tail.split(".").map(Number);
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    normalized = normalized.slice(0, -ipv4Tail.length) + `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(Math.max(missing, 0)).fill("0"), ...right];

  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

function isUnsafeIpv6(address) {
  const groups = parseIpv6(address);
  if (!groups) return true;
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = groups;
  const isUnspecified = groups.every((group) => group === 0);
  const isLoopback = groups.slice(0, 7).every((group) => group === 0) && eighth === 1;
  const isIpv4Mapped = groups.slice(0, 5).every((group) => group === 0) && sixth === 0xffff;

  if (isIpv4Mapped) {
    return isPrivateIpv4(`${seventh >> 8}.${seventh & 255}.${eighth >> 8}.${eighth & 255}`);
  }

  return (
    isUnspecified ||
    isLoopback ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && second === 0x0db8) ||
    first === 0x2002 ||
    (first === 0x0064 && second === 0xff9b && third === 0 && fourth === 0 && fifth === 0 && sixth === 0)
  );
}

export function isUnsafeIpAddress(address) {
  const normalizedAddress = address.replace(/^\[|\]$/g, "");
  const type = isIP(normalizedAddress);

  if (type === 4) {
    return isPrivateIpv4(normalizedAddress);
  }

  if (type === 6) {
    return isUnsafeIpv6(normalizedAddress);
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

  if (!hostname || blockedHostnames.has(hostname) || blockedHostnameSuffixes.some((suffix) => hostname.endsWith(suffix))) {
    throw new HttpError(400, "Localhost and internal URLs cannot be scanned.", "UNSAFE_URL");
  }

  const addressHostname = hostname.replace(/^\[|\]$/g, "");

  if (isIP(addressHostname)) {
    if (isUnsafeIpAddress(addressHostname)) {
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
    const timer = setTimeout(() => controller.abort(new Error("Website scan timed out.")), timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const startedAt = Date.now();
    let response;

    try {
      response = await fetcher(currentUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "SitePulseAuditBot/0.2 (+https://sitepulse.local)"
        },
        redirect: "manual",
        signal
      });
    } catch (error) {
      if (controller.signal.aborted && !options.signal?.aborted) {
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
