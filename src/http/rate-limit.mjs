import { HttpError } from "./http-error.mjs";

function getClientKey(request) {
  // No trusted reverse proxy is configured. A caller-controlled forwarding
  // header must not be able to select a fresh rate-limit bucket.
  return request.socket.remoteAddress || "unknown";
}

export function createRateLimiter({
  windowMs,
  max,
  maxBuckets = 1_000,
  clock = () => Date.now(),
  keySelector = getClientKey
}) {
  if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1) {
    throw new TypeError("Rate-limit bucket capacity must be a positive integer.");
  }
  const buckets = new Map();

  return function enforceRateLimit(request, response, context) {
    const now = clock();
    const key = keySelector(request, context);
    if (typeof key !== "string" || key.length < 1 || key.length > 256) {
      throw new TypeError("Rate-limit key must contain 1-256 characters.");
    }
    const current = buckets.get(key);

    if (!current && buckets.size >= maxBuckets) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) {
          buckets.delete(bucketKey);
        }
      }
      if (buckets.size >= maxBuckets) {
        response.setHeader("Retry-After", String(Math.ceil(windowMs / 1_000)));
        throw new HttpError(429, "Too many requests. Please try again soon.", "RATE_LIMITED");
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
