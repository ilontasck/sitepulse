import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createScryptLimiter } from "../src/auth/scrypt-limiter.mjs";

describe("bounded scrypt concurrency", () => {
  it("rejects excess work immediately instead of creating a wait queue", async () => {
    const limiter = createScryptLimiter({ maxConcurrency: 1 });
    let release;
    const first = limiter.run(() => new Promise((resolve) => {
      release = resolve;
    }));

    await assert.rejects(
      limiter.run(() => Promise.resolve("must not run")),
      (error) => error?.code === "AUTH_CAPACITY_EXCEEDED"
    );
    release("done");
    assert.equal(await first, "done");
  });

  it("releases capacity after both success and failure", async () => {
    const limiter = createScryptLimiter({ maxConcurrency: 1 });

    assert.equal(await limiter.run(async () => "first"), "first");
    await assert.rejects(limiter.run(async () => {
      throw new Error("expected test failure");
    }), /expected test failure/);
    assert.equal(await limiter.run(async () => "third"), "third");
  });
});
