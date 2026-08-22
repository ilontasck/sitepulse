import { randomUUID } from "node:crypto";
import { chmodSync, chownSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { loadBrowserSandboxAttestation } from "../src/production/browser-sandbox-attestation.mjs";
import {
  browserSandboxAcceptanceTestPath,
  browserSandboxAttestationPath
} from "../src/production/browser-sandbox-policy.mjs";

const action = process.argv[2];
if (process.platform !== "linux" || process.getuid?.() !== 0 || !["enable", "disable"].includes(action)) {
  console.error("BROWSER_SANDBOX_ACCEPTANCE_TEST_REQUIRES_ROOT_LINUX");
  process.exitCode = 1;
} else {
  const attestation = loadBrowserSandboxAttestation();
  if (!attestation.valid) {
    console.error("BROWSER_SANDBOX_ATTESTATION_INVALID");
    process.exitCode = 1;
  } else {
    const current = JSON.parse(readFileSync(browserSandboxAttestationPath, "utf8"));
    const temporary = `${browserSandboxAcceptanceTestPath}.${process.pid}.${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify({
      schemaVersion: 2,
      configHash: current.configHash,
      bundleHash: current.bundleHash,
      platformHash: current.platformHash,
      bootId: current.bootId,
      enabled: action === "enable",
      expiresAt: action === "enable"
        ? new Date(Date.now() + 15 * 60_000).toISOString()
        : "1970-01-01T00:00:00.000Z"
    })}\n`, { mode: 0o444 });
    chownSync(temporary, 0, 0);
    chmodSync(temporary, 0o444);
    renameSync(temporary, browserSandboxAcceptanceTestPath);
    console.log(action === "enable"
      ? "BROWSER_SANDBOX_ACCEPTANCE_TEST_ENABLED"
      : "BROWSER_SANDBOX_ACCEPTANCE_TEST_DISABLED");
  }
}
