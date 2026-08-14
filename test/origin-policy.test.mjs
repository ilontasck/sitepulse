import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requireTrustedOrigin } from "../src/http/origin-policy.mjs";

describe("strict mutation origin policy", () => {
  it("accepts only the exact configured origin", () => {
    const trusted = "https://sitepulse.example:8443";
    assert.doesNotThrow(() => requireTrustedOrigin({ headers: { origin: trusted } }, trusted));

    for (const origin of [
      undefined,
      "null",
      "not-an-origin",
      "http://sitepulse.example:8443",
      "https://sitepulse.example",
      "https://evil.example:8443",
      "https://sitepulse.example:8443/path"
    ]) {
      assert.throws(
        () => requireTrustedOrigin({ headers: { origin } }, trusted),
        (error) => error?.statusCode === 403 && error?.code === "CSRF_REJECTED"
      );
    }
  });
});
