import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeEmail } from "../src/auth/email.mjs";

describe("email identity", () => {
  it("preserves the trimmed submitted form and normalizes ASCII identity", () => {
    assert.deepEqual(normalizeEmail("  Owner+Alerts@Example.COM  "), {
      original: "Owner+Alerts@Example.COM",
      normalized: "owner+alerts@example.com"
    });
    assert.equal(normalizeEmail("first.last@example.com").normalized, "first.last@example.com");
  });

  it("converts an internationalized domain without changing the ASCII-only local-part policy", () => {
    assert.deepEqual(normalizeEmail("OWNER@bücher.example"), {
      original: "OWNER@bücher.example",
      normalized: "owner@xn--bcher-kva.example"
    });
  });

  it("rejects unsafe or unsupported email input with a safe typed error", () => {
    const invalidValues = [
      null,
      "owner @example.com",
      "owner\u0000@example.com",
      "owner@@example.com",
      "@example.com",
      "owner@",
      "öwner@example.com",
      `owner@${"a".repeat(250)}.com`,
      "owner@\uD800.example"
    ];

    for (const value of invalidValues) {
      assert.throws(
        () => normalizeEmail(value),
        (error) => error?.code === "INVALID_EMAIL" && error.message === "Enter a valid email address."
      );
    }
  });
});
