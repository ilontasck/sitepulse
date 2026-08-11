import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRenderedAuditLimiter, RenderedAuditCapacityError } from "../src/audit/rendered-audit-limiter.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("rendered audit concurrency limiter", () => {
  it("rejects excess work immediately without creating a queue", async () => {
    const limiter = createRenderedAuditLimiter(1);
    const gate = deferred();
    const first = limiter.run(() => gate.promise);

    await assert.rejects(() => limiter.run(async () => "second"), RenderedAuditCapacityError);
    assert.deepEqual(limiter.snapshot(), { active: 1, available: 0, maxConcurrency: 1 });
    gate.resolve("first");
    assert.equal(await first, "first");
    assert.equal(limiter.snapshot().active, 0);
  });

  it("releases its slot after crashes and timeouts", async () => {
    const limiter = createRenderedAuditLimiter(1);

    await assert.rejects(() => limiter.run(async () => {
      throw new Error("Chromium crashed");
    }), /crashed/);
    assert.equal(await limiter.run(async () => "after-crash"), "after-crash");

    await assert.rejects(() => limiter.run(async () => {
      throw new Error("Rendered audit exceeded timeout");
    }), /timeout/);
    assert.equal(await limiter.run(async () => "after-timeout"), "after-timeout");
    assert.equal(limiter.snapshot().active, 0);
  });
});
