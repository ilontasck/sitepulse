import { randomUUID } from "node:crypto";
import { chmodSync, chownSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  browserSandboxAcceptanceChecks,
  loadBrowserSandboxAttestation,
  verifyBrowserSandboxKernelEvidence
} from "../src/production/browser-sandbox-attestation.mjs";
import {
  browserSandboxAcceptanceEvidencePath,
  browserSandboxAttestationPath,
  browserSandboxKernelEvidencePath
} from "../src/production/browser-sandbox-policy.mjs";
import { computeBrowserSandboxBundleHash, verifyInstalledBrowserSandboxUnits } from "../src/production/browser-sandbox-bundle.mjs";

const preparePath = "/var/lib/noqori/browser-sandbox-pre-reboot.json";
const queueResultPath = "/var/lib/noqori/browser-sandbox-queue-result.json";
const action = process.argv[2];
const bundleRoot = fileURLToPath(new URL("../", import.meta.url));

function writeRootFile(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o440 });
  chownSync(temporary, 0, 0);
  chmodSync(temporary, 0o440);
  renameSync(temporary, path);
}
function readRootFile(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error("VM_ACCEPTANCE_EVIDENCE_PERMISSIONS");
  return JSON.parse(readFileSync(path, "utf8"));
}
function run(script, args = []) {
  const absoluteScript = fileURLToPath(new URL(`../${script}`, import.meta.url));
  const result = spawnSync("/usr/bin/node", [absoluteScript, ...args], { cwd: bundleRoot, stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error("VM_ACCEPTANCE_PHASE_FAILED");
}

if (process.platform !== "linux" || process.getuid?.() !== 0 || !["prepare-reboot", "complete"].includes(action)) {
  console.error("BROWSER_SANDBOX_VM_ACCEPTANCE_REQUIRES_ROOT_LINUX");
  process.exitCode = 2;
} else {
  try {
    const attestation = loadBrowserSandboxAttestation();
    if (!attestation.valid) throw new Error("VM_ACCEPTANCE_ATTESTATION_INVALID");
    const current = JSON.parse(readFileSync(browserSandboxAttestationPath, "utf8"));
    if (current.bundleHash !== computeBrowserSandboxBundleHash({ bundleRoot }) || !verifyInstalledBrowserSandboxUnits({ bundleRoot })) {
      throw new Error("VM_ACCEPTANCE_IMMUTABLE_BUNDLE_MISMATCH");
    }
    if (action === "prepare-reboot") {
      writeRootFile(preparePath, {
        schemaVersion: 2,
        configHash: current.configHash,
        bundleHash: current.bundleHash,
        platformHash: current.platformHash,
        bootId: current.bootId,
        preparedAt: new Date().toISOString()
      });
      console.log("BROWSER SANDBOX VM ACCEPTANCE: REBOOT REQUIRED");
    } else {
      const before = readRootFile(preparePath);
      if (before.schemaVersion !== 2 || before.configHash !== current.configHash || before.bundleHash !== current.bundleHash || before.platformHash !== current.platformHash || before.bootId === current.bootId) {
        throw new Error("VM_ACCEPTANCE_REBOOT_NOT_PROVEN");
      }
      run("scripts/run-browser-sandbox-integration.mjs");
      const restoredAttestation = loadBrowserSandboxAttestation();
      if (!restoredAttestation.valid) throw new Error("VM_ACCEPTANCE_RESTORED_ATTESTATION_INVALID");
      const restored = JSON.parse(readFileSync(browserSandboxAttestationPath, "utf8"));
      if (restored.configHash !== current.configHash || restored.bundleHash !== current.bundleHash || restored.platformHash !== current.platformHash || restored.bootId !== current.bootId) {
        throw new Error("VM_ACCEPTANCE_RESTORED_ATTESTATION_MISMATCH");
      }
      if (!verifyBrowserSandboxKernelEvidence({
        evidencePath: browserSandboxKernelEvidencePath,
        expectedConfigHash: restored.configHash,
        expectedBundleHash: restored.bundleHash,
        expectedPlatformHash: restored.platformHash,
        currentBootId: restored.bootId
      }).valid) throw new Error("VM_ACCEPTANCE_KERNEL_EVIDENCE_INVALID");
      run("scripts/verify-worker-crash-recovery-on-vm.mjs");
      const queue = readRootFile(queueResultPath);
      if (queue.schemaVersion !== 2 || queue.configHash !== restored.configHash || queue.bundleHash !== restored.bundleHash || queue.platformHash !== restored.platformHash || queue.bootId !== restored.bootId || queue.namespaceInode !== restored.namespaceInode || queue.readyBeforeClaim !== true || queue.attemptCount !== 2 || queue.workerProcessCount !== 1) {
        throw new Error("VM_ACCEPTANCE_QUEUE_EVIDENCE_INVALID");
      }
      writeRootFile(browserSandboxAcceptanceEvidencePath, {
        schemaVersion: 2,
        configHash: restored.configHash,
        bundleHash: restored.bundleHash,
        platformHash: restored.platformHash,
        beforeRebootBootId: before.bootId,
        afterRebootBootId: restored.bootId,
        checks: browserSandboxAcceptanceChecks,
        completedAt: new Date().toISOString()
      });
      run("scripts/mark-browser-sandbox-accepted.mjs");
      console.log("BROWSER SANDBOX FULL VM ACCEPTANCE: PASS");
    }
  } catch (error) {
    console.error(error?.message?.startsWith("VM_ACCEPTANCE_") ? error.message : "BROWSER_SANDBOX_VM_ACCEPTANCE_FAILED");
    process.exitCode = 1;
  }
}
