import assert from "node:assert/strict";
import { it } from "node:test";
import { scanWebsite } from "../src/audit/scanner-service.mjs";

it("propagates runner cancellation instead of converting it into an HTML fallback", async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error("cancelled"), { code: "AUDIT_RUNNER_CANCELLED" });
  let fallbackCalls = 0;
  controller.abort(reason);

  await assert.rejects(
    scanWebsite({ normalizedUrl: "https://example.com", domain: "example.com" }, {
      signal: controller.signal,
      htmlScanner: async () => { throw reason; },
      fallbackScanner: () => { fallbackCalls += 1; return {}; }
    }),
    (error) => error === reason
  );
  assert.equal(fallbackCalls, 0);
});
