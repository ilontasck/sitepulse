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

  it("supports a safe caller-selected ownership key without using request credentials", () => {
    const seenContexts = [];
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 1,
      keySelector(_request, context) {
        seenContexts.push(context);
        return `user:${context.userId}`;
      }
    });
    const request = { socket: { remoteAddress: "192.0.2.1" } };

    assert.doesNotThrow(() => limiter(request, responseStub(), { userId: "user-a" }));
    assert.doesNotThrow(() => limiter(request, responseStub(), { userId: "user-b" }));
    assert.throws(
      () => limiter(request, responseStub(), { userId: "user-a" }),
      (error) => error?.statusCode === 429 && error?.code === "RATE_LIMITED"
    );
    assert.deepEqual(seenContexts, [{ userId: "user-a" }, { userId: "user-b" }, { userId: "user-a" }]);
  });
});
