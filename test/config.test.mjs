import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config/env.mjs";

describe("configuration", () => {
  it("rejects invalid resource and rate-limit values", () => {
    assert.throws(() => loadConfig({ REQUEST_BODY_LIMIT_BYTES: "unlimited" }), /positive integer/);
    assert.throws(() => loadConfig({ RATE_LIMIT_WINDOW_MS: 0 }), /positive integer/);
    assert.throws(() => loadConfig({ RATE_LIMIT_MAX: -1 }), /positive integer/);
  });
});
