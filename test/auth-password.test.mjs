import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  createPasswordService,
  PASSWORD_SCRYPT_PARAMETERS,
  validatePassword
} from "../src/auth/password.mjs";

function fastDerive(passwordBytes, salt, { keyLength }) {
  const first = createHash("sha512").update(passwordBytes).update(salt).digest();
  return Promise.resolve(first.subarray(0, keyLength));
}

describe("password input and hashing", () => {
  it("accepts spaces and Unicode without trimming or normalization", () => {
    const withSpaces = "  twelve chars  ";
    const decomposed = "password-12e\u0301";

    assert.equal(validatePassword(withSpaces), withSpaces);
    assert.equal(validatePassword(decomposed), decomposed);
  });

  it("rejects short, oversized, non-string, and unpaired-surrogate input safely", () => {
    for (const value of ["elevenchars", "😀".repeat(33), "valid-length\uD800", null]) {
      assert.throws(
        () => validatePassword(value),
        (error) => error?.code === "INVALID_PASSWORD" && !error.message.includes(String(value))
      );
    }
  });

  it("encodes and verifies the exact v1 format through an injected derivation seam", async () => {
    const service = createPasswordService({ deriveKey: fastDerive });
    const encoded = await service.hashPassword("correct horse battery staple");
    const fields = encoded.split(":");

    assert.deepEqual(fields.slice(0, 7), ["sitepulse", "scrypt", "v1", "131072", "8", "1", "64"]);
    assert.equal(Buffer.from(fields[7], "base64url").length, 16);
    assert.equal(Buffer.from(fields[8], "base64url").length, 64);
    assert.equal(await service.verifyPassword("correct horse battery staple", encoded), true);
    assert.equal(await service.verifyPassword("incorrect password value", encoded), false);
    assert.equal(service.needsRehash(encoded), false);
  });

  it("uses a fresh salt for every password hash", async () => {
    const service = createPasswordService({ deriveKey: fastDerive });
    const first = await service.hashPassword("correct horse battery staple");
    const second = await service.hashPassword("correct horse battery staple");

    assert.notEqual(first.split(":")[7], second.split(":")[7]);
  });

  it("rejects malformed, extra-field, and attacker-controlled hash parameters without deriving", async () => {
    let derivations = 0;
    const service = createPasswordService({
      deriveKey(...args) {
        derivations += 1;
        return fastDerive(...args);
      }
    });
    const malformed = [
      "not-a-hash",
      "sitepulse:scrypt:v2:131072:8:1:64:AAAAAAAAAAAAAAAAAAAAAA:AAAA",
      "sitepulse:scrypt:v1:262144:8:1:64:AAAAAAAAAAAAAAAAAAAAAA:AAAA",
      "sitepulse:scrypt:v1:131072:8:1:64:AAAAAAAAAAAAAAAAAAAAAA:AAAA:extra",
      "sitepulse:scrypt:v1:131072:8:1:64:======================:AAAA",
      `sitepulse:scrypt:v1:131072:8:1:64:${"A".repeat(1_000_000)}:${"A".repeat(86)}`
    ];

    for (const encoded of malformed) {
      assert.equal(await service.verifyPassword("correct horse battery staple", encoded), false);
      assert.equal(service.needsRehash(encoded), true);
    }
    assert.equal(derivations, 0);
  });

  it("keeps the approved production scrypt resource parameters", () => {
    assert.deepEqual(PASSWORD_SCRYPT_PARAMETERS, {
      N: 131_072,
      r: 8,
      p: 1,
      keyLength: 64,
      saltLength: 16,
      maxmem: 268_435_456
    });
  });

  it("routes both hash and verify work through the same bounded limiter", async () => {
    const setupService = createPasswordService({ deriveKey: fastDerive });
    const encoded = await setupService.hashPassword("correct horse battery staple");
    let release;
    const service = createPasswordService({
      maxConcurrency: 1,
      deriveKey() {
        return new Promise((resolve) => {
          release = () => resolve(Buffer.alloc(64));
        });
      }
    });
    const activeHash = service.hashPassword("correct horse battery staple");

    await assert.rejects(
      service.verifyPassword("correct horse battery staple", encoded),
      (error) => error?.code === "AUTH_CAPACITY_EXCEEDED"
    );
    release();
    await activeHash;
  });
});
