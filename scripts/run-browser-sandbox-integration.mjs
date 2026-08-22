import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, chownSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { browserSandboxKernelChecks } from "../src/production/browser-sandbox-attestation.mjs";
import { browserSandboxAttestationPath, browserSandboxKernelEvidencePath } from "../src/production/browser-sandbox-policy.mjs";
import { computeBrowserSandboxBundleHash, verifyInstalledBrowserSandboxUnits } from "../src/production/browser-sandbox-bundle.mjs";

if (process.platform !== "linux") {
  console.log("BROWSER SANDBOX LINUX INTEGRATION: UNAVAILABLE (requires a disposable root Linux VM)");
  process.exit(2);
}
if (typeof process.getuid !== "function" || process.getuid() !== 0) {
  console.error("BROWSER SANDBOX LINUX INTEGRATION: UNAVAILABLE (root required)");
  process.exit(2);
}

const script = fileURLToPath(new URL("../test/linux/browser-sandbox.integration.sh", import.meta.url));
const bundleRoot = fileURLToPath(new URL("../", import.meta.url));
const initialAttestation = JSON.parse(readFileSync(browserSandboxAttestationPath, "utf8"));
if (initialAttestation.bundleHash !== computeBrowserSandboxBundleHash({ bundleRoot }) || !verifyInstalledBrowserSandboxUnits({ bundleRoot })) {
  console.error("BROWSER SANDBOX LINUX INTEGRATION: IMMUTABLE BUNDLE MISMATCH");
  process.exit(1);
}
const result = spawnSync("/bin/bash", [script], { cwd: bundleRoot, stdio: "inherit", env: process.env });
if (result.status === 0) {
  const attestation = JSON.parse(readFileSync(browserSandboxAttestationPath, "utf8"));
  const runnerMemoryPeakBytes = Number(readFileSync("/run/noqori-audit/kernel-memory-peak", "utf8").trim());
  const temporary = `${browserSandboxKernelEvidencePath}.${process.pid}.${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify({
    schemaVersion: 2,
    configHash: attestation.configHash,
    bundleHash: attestation.bundleHash,
    platformHash: attestation.platformHash,
    bootId: attestation.bootId,
    checks: browserSandboxKernelChecks,
    systemdVerified: true,
    runnerMemoryMaxBytes: 2_147_483_648,
    runnerMemoryPeakBytes,
    runnerTasksMax: 512,
    completedAt: new Date().toISOString()
  })}\n`, { mode: 0o440 });
  chownSync(temporary, 0, 0);
  chmodSync(temporary, 0o440);
  renameSync(temporary, browserSandboxKernelEvidencePath);
}
process.exit(result.status ?? 1);
