import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateSessionToken, hashSessionToken } from "../src/auth/session-token.mjs";

describe("session token crypto", () => {
  it("generates unique 256-bit unpadded base64url tokens", () => {
    const first = generateSessionToken();
    const second = generateSessionToken();

    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(first, "base64url").length, 32);
    assert.notEqual(first, second);
  });

  it("hashes valid tokens to a 32-byte SHA-256 buffer and rejects malformed tokens", () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);

    assert.equal(Buffer.isBuffer(hash), true);
    assert.equal(hash.length, 32);
    for (const invalid of [null, "short", `${token}=`, `${token}a`, "!".repeat(43)]) {
      assert.equal(hashSessionToken(invalid), null);
    }
  });

  it("hashes the opaque cookie value rather than persisting its decoded random bytes", () => {
    const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    assert.equal(
      hashSessionToken(token).toString("hex"),
      "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a"
    );
  });
});
