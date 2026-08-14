import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRateLimiter } from "../src/http/rate-limit.mjs";

function responseStub() {
  const headers = new Map();
  return {
    headers,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    }
  };
}

describe("bounded in-process rate limiting", () => {
  it("rejects new buckets at capacity and reclaims expired buckets", () => {
    let now = 1_000;
    const limiter = createRateLimiter({ windowMs: 100, max: 2, maxBuckets: 2, clock: () => now });
    const request = (remoteAddress) => ({ socket: { remoteAddress } });

    assert.doesNotThrow(() => limiter(request("192.0.2.1"), responseStub()));
    assert.doesNotThrow(() => limiter(request("192.0.2.2"), responseStub()));
    assert.throws(
      () => limiter(request("192.0.2.3"), responseStub()),
      (error) => error?.statusCode === 429 && error?.code === "RATE_LIMITED"
    );

    now = 1_101;
    assert.doesNotThrow(() => limiter(request("192.0.2.3"), responseStub()));
  });
});
