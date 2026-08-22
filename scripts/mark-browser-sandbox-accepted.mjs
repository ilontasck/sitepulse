import { randomUUID } from "node:crypto";
import { chmodSync, chownSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  loadBrowserSandboxAttestation,
  verifyBrowserSandboxAcceptanceEvidence
} from "../src/production/browser-sandbox-attestation.mjs";
import {
  browserSandboxAcceptanceEvidencePath,
  browserSandboxAcceptancePath,
  browserSandboxAttestationPath
} from "../src/production/browser-sandbox-policy.mjs";

if (process.platform !== "linux" || process.getuid?.() !== 0) {
  console.error("BROWSER_SANDBOX_ACCEPTANCE_REQUIRES_ROOT_LINUX");
  process.exitCode = 1;
} else if (loadBrowserSandboxAttestation().valid !== true) {
  console.error("BROWSER_SANDBOX_ATTESTATION_INVALID");
  process.exitCode = 1;
} else {
  const current = JSON.parse(readFileSync(browserSandboxAttestationPath, "utf8"));
  if (!verifyBrowserSandboxAcceptanceEvidence({
    evidencePath: browserSandboxAcceptanceEvidencePath,
    expectedConfigHash: current.configHash,
    expectedBundleHash: current.bundleHash,
    expectedPlatformHash: current.platformHash
  }).valid) {
    console.error("BROWSER_SANDBOX_VM_EVIDENCE_INCOMPLETE");
    process.exitCode = 1;
  } else {
    const acceptanceTemporary = `${browserSandboxAcceptancePath}.${process.pid}.${randomUUID()}`;
    writeFileSync(acceptanceTemporary, `${JSON.stringify({
      schemaVersion: 2,
      configHash: current.configHash,
      bundleHash: current.bundleHash,
      platformHash: current.platformHash,
      acceptedAt: new Date().toISOString()
    })}\n`, { mode: 0o440 });
    chownSync(acceptanceTemporary, 0, 0);
    chmodSync(acceptanceTemporary, 0o440);
    renameSync(acceptanceTemporary, browserSandboxAcceptancePath);
    const temporary = `${browserSandboxAttestationPath}.${process.pid}.${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify({ ...current, vmAcceptancePassed: true })}\n`, { mode: 0o444 });
    chownSync(temporary, 0, 0);
    chmodSync(temporary, 0o444);
    renameSync(temporary, browserSandboxAttestationPath);
    console.log("BROWSER_SANDBOX_VM_ACCEPTANCE_RECORDED");
  }
}
