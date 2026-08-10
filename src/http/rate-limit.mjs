import { HttpError } from "./http-error.mjs";

function getClientKey(request) {
  // No trusted reverse proxy is configured. A caller-controlled forwarding
  // header must not be able to select a fresh rate-limit bucket.
  return request.socket.remoteAddress || "unknown";
}

export function createRateLimiter({ windowMs, max }) {
  const buckets = new Map();

  return function enforceRateLimit(request, response) {
    const now = Date.now();
    const key = getClientKey(request);
    const current = buckets.get(key);

    if (buckets.size > 1_000) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) {
          buckets.delete(bucketKey);
        }
      }
    }

    if (!current || current.resetAt <= now) {
      buckets.set(key, {
        count: 1,
        resetAt: now + windowMs
      });
      response.setHeader("RateLimit-Limit", String(max));
      response.setHeader("RateLimit-Remaining", String(Math.max(max - 1, 0)));
      return;
    }

    current.count += 1;
    response.setHeader("RateLimit-Limit", String(max));
    response.setHeader("RateLimit-Remaining", String(Math.max(max - current.count, 0)));

    if (current.count > max) {
      response.setHeader("Retry-After", String(Math.ceil((current.resetAt - now) / 1000)));
      throw new HttpError(429, "Too many requests. Please try again soon.", "RATE_LIMITED");
    }
  };
}
