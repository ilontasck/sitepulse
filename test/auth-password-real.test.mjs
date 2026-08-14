import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPasswordService } from "../src/auth/password.mjs";

describe("production scrypt integration", () => {
  it("derives and verifies with the approved N=2^17 profile", async () => {
    const service = createPasswordService({ maxConcurrency: 1 });
    const encoded = await service.hashPassword("production parameter test password");

    assert.equal(await service.verifyPassword("production parameter test password", encoded), true);
    assert.equal(await service.verifyDummyPassword("unrecognized account password"), false);
  });
});
