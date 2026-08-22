import { readFileSync, statSync } from "node:fs";
import {
  browserSandboxAttestationPath,
  browserSandboxBundleHashPath,
  browserSandboxExpectedHashPath,
  browserSandboxNamespacePath
} from "./browser-sandbox-policy.mjs";

const schemaVersion = 2;
const maximumAttestationBytes = 4_096;
const expectedKeys = [
  "bootId",
  "bundleHash",
  "configHash",
  "createdAt",
  "namespaceInode",
  "namespacePath",
  "platformHash",
  "schemaVersion",
  "vmAcceptancePassed"
];
export const browserSandboxAcceptanceChecks = [
  "systemd-unit-verification",
  "public-http-https",
  "quic-udp-443",
  "blocked-addresses",
  "private-redirect",
  "private-subresources",
  "private-websocket",
  "dns-rebinding",
  "mixed-a-aaaa",
  "no-direct-fallback",
  "policy-corruption",
  "runner-capabilities",
  "runner-client-disconnect-cancellation",
  "runner-client-timeout-cancellation",
  "runner-sigint-cancellation",
  "runner-sigterm-cancellation",
  "rpc-isolation",
  "single-worker-cgroup",
  "runner-resource-budget",
  "reboot-persistence",
  "worker-crash-recovery-fencing",
  "api-independence"
];
export const browserSandboxKernelChecks = browserSandboxAcceptanceChecks.filter((check) => ![
  "reboot-persistence",
  "single-worker-cgroup",
  "worker-crash-recovery-fencing"
].includes(check));

function invalid() {
  return { valid: false, code: "SANDBOX_ATTESTATION_INVALID" };
}

function isSecureCredential(stat, serviceUid) {
  if (!stat.isFile() || ![0, serviceUid].includes(stat.uid)) return false;
  const permissions = stat.mode & 0o777;
  return permissions === 0o400 ||
    (stat.uid === 0 && stat.gid === 0 && permissions === 0o440);
}

export function verifyBrowserSandboxAttestation({
  attestationPath,
  expectedConfigHash,
  expectedBundleHash,
  expectedNamespacePath,
  currentBootId,
  readFile = (path) => readFileSync(path, "utf8"),
  statFile = statSync
}) {
  try {
    const stat = statFile(attestationPath);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return invalid();

    const encoded = readFile(attestationPath);
    if (Buffer.byteLength(encoded, "utf8") > maximumAttestationBytes) return invalid();

    const value = JSON.parse(encoded);
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) return invalid();
    if (value.schemaVersion !== schemaVersion) return invalid();
    if (!/^[a-f0-9]{64}$/.test(value.configHash) || value.configHash !== expectedConfigHash) return invalid();
    if (!/^[a-f0-9]{64}$/.test(value.bundleHash) || value.bundleHash !== expectedBundleHash) return invalid();
    if (!/^[a-f0-9]{64}$/.test(value.platformHash)) return invalid();
    if (value.namespacePath !== expectedNamespacePath) return invalid();
    if (!Number.isSafeInteger(value.namespaceInode) || value.namespaceInode <= 0) return invalid();
    if (typeof value.bootId !== "string" || value.bootId !== currentBootId) return invalid();
    if (typeof value.vmAcceptancePassed !== "boolean") return invalid();
    if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return invalid();

    return {
      valid: true,
      vmAcceptancePassed: value.vmAcceptancePassed,
      bundleHash: value.bundleHash,
      namespaceInode: value.namespaceInode,
      platformHash: value.platformHash
    };
  } catch {
    return invalid();
  }
}

export function loadBrowserSandboxAttestation({
  attestationPath = browserSandboxAttestationPath,
  expectedHashPath = browserSandboxExpectedHashPath,
  bundleHashPath = browserSandboxBundleHashPath,
  namespacePath = browserSandboxNamespacePath,
  bootIdPath = "/proc/sys/kernel/random/boot_id",
  readFile = (path) => readFileSync(path, "utf8"),
  statFile = statSync
} = {}) {
  try {
    const hashStat = statFile(expectedHashPath);
    if (!hashStat.isFile() || hashStat.uid !== 0 || (hashStat.mode & 0o022) !== 0) return invalid();
    const namespaceStat = statFile(namespacePath);
    if (namespaceStat.uid !== 0 || !Number.isSafeInteger(namespaceStat.ino) || namespaceStat.ino <= 0) return invalid();
    const expectedConfigHash = readFile(expectedHashPath).trim();
    const bundleHashStat = statFile(bundleHashPath);
    if (!bundleHashStat.isFile() || bundleHashStat.uid !== 0 || (bundleHashStat.mode & 0o022) !== 0) return invalid();
    const expectedBundleHash = readFile(bundleHashPath).trim();
    const currentBootId = readFile(bootIdPath).trim();
    const attestation = verifyBrowserSandboxAttestation({
      attestationPath,
      expectedConfigHash,
      expectedBundleHash,
      expectedNamespacePath: namespacePath,
      currentBootId,
      readFile,
      statFile
    });
    if (!attestation.valid || attestation.namespaceInode !== namespaceStat.ino) return invalid();
    return attestation;
  } catch {
    return invalid();
  }
}

export function loadAuditRunnerAcceptance({
  credentialsDirectory,
  currentPlatformHash,
  currentBundleHash,
  bootIdPath = "/proc/sys/kernel/random/boot_id",
  processNamespacePath = "/proc/self/ns/net",
  readFile = (path) => readFileSync(path, "utf8"),
  statFile = statSync,
  getUid = () => process.getuid?.(),
  now = () => new Date()
} = {}) {
  try {
    if (!credentialsDirectory || typeof credentialsDirectory !== "string" ||
      (currentPlatformHash !== undefined && !/^[a-f0-9]{64}$/.test(currentPlatformHash)) ||
      !/^[a-f0-9]{64}$/.test(currentBundleHash || "")) return invalid();
    const attestationPath = `${credentialsDirectory}/sandbox-attestation`;
    const hashPath = `${credentialsDirectory}/sandbox-config-hash`;
    const bundleHashPath = `${credentialsDirectory}/sandbox-bundle-hash`;
    const platformHashPath = `${credentialsDirectory}/sandbox-platform-hash`;
    const hashStat = statFile(hashPath);
    if (!isSecureCredential(hashStat, getUid())) return invalid();
    const expectedConfigHash = readFile(hashPath).trim();
    const bundleHashStat = statFile(bundleHashPath);
    if (!isSecureCredential(bundleHashStat, getUid())) return invalid();
    const expectedBundleHash = readFile(bundleHashPath).trim();
    if (expectedBundleHash !== currentBundleHash) return invalid();
    const platformHashStat = statFile(platformHashPath);
    if (!isSecureCredential(platformHashStat, getUid())) return invalid();
    const expectedPlatformHash = readFile(platformHashPath).trim();
    if (!/^[a-f0-9]{64}$/.test(expectedPlatformHash) ||
      (currentPlatformHash !== undefined && expectedPlatformHash !== currentPlatformHash)) return invalid();
    const currentBootId = readFile(bootIdPath).trim();
    const attestationStat = statFile(attestationPath);
    if (!isSecureCredential(attestationStat, getUid())) return invalid();
    const attestation = verifyBrowserSandboxAttestation({
      attestationPath,
      expectedConfigHash,
      expectedBundleHash,
      expectedNamespacePath: browserSandboxNamespacePath,
      currentBootId,
      readFile,
      statFile: (path) => path === attestationPath
        ? { ...attestationStat, uid: 0, isFile: () => attestationStat.isFile() }
        : statFile(path)
    });
    const processNamespace = statFile(processNamespacePath);
    if (!attestation.valid || attestation.platformHash !== expectedPlatformHash || attestation.bundleHash !== currentBundleHash || processNamespace.ino !== attestation.namespaceInode) return invalid();
    let acceptanceTestAllowed = false;
    try {
      const testPath = `${credentialsDirectory}/sandbox-acceptance-test`;
      const testStat = statFile(testPath);
      if (!isSecureCredential(testStat, getUid())) return invalid();
      const testValue = JSON.parse(readFile(testPath));
      const testKeys = Object.keys(testValue || {}).sort().join(",");
      const expiresAt = Date.parse(testValue.expiresAt);
      const nowMs = now().getTime();
      if (
        testKeys !== "bootId,bundleHash,configHash,enabled,expiresAt,platformHash,schemaVersion" ||
        testValue.schemaVersion !== schemaVersion ||
        testValue.configHash !== expectedConfigHash ||
        testValue.bundleHash !== currentBundleHash ||
        testValue.platformHash !== expectedPlatformHash ||
        testValue.bootId !== currentBootId ||
        typeof testValue.enabled !== "boolean" ||
        !Number.isFinite(expiresAt) ||
        expiresAt > nowMs + 20 * 60_000
      ) return invalid();
      acceptanceTestAllowed = testValue.enabled && expiresAt > nowMs;
    } catch {
      return invalid();
    }
    return {
      valid: true,
      renderedAuditAllowed: attestation.vmAcceptancePassed === true || acceptanceTestAllowed
    };
  } catch {
    return invalid();
  }
}

export function verifyBrowserSandboxAcceptanceEvidence({
  evidencePath,
  expectedConfigHash,
  expectedBundleHash,
  expectedPlatformHash,
  readFile = (path) => readFileSync(path, "utf8"),
  statFile = statSync
}) {
  try {
    const stat = statFile(evidencePath);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return invalid();
    const encoded = readFile(evidencePath);
    if (Buffer.byteLength(encoded, "utf8") > 8_192) return invalid();
    const value = JSON.parse(encoded);
    const keys = Object.keys(value || {}).sort().join(",");
    if (keys !== "afterRebootBootId,beforeRebootBootId,bundleHash,checks,completedAt,configHash,platformHash,schemaVersion") return invalid();
    if (value.schemaVersion !== schemaVersion || value.configHash !== expectedConfigHash || value.bundleHash !== expectedBundleHash || value.platformHash !== expectedPlatformHash) return invalid();
    if (!/^[a-f0-9]{64}$/.test(value.platformHash)) return invalid();
    if (typeof value.beforeRebootBootId !== "string" || typeof value.afterRebootBootId !== "string" || value.beforeRebootBootId === value.afterRebootBootId) return invalid();
    if (typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt))) return invalid();
    if (!Array.isArray(value.checks) || value.checks.join("\0") !== browserSandboxAcceptanceChecks.join("\0")) return invalid();
    return { valid: true };
  } catch {
    return invalid();
  }
}

export function verifyBrowserSandboxKernelEvidence({
  evidencePath,
  expectedConfigHash,
  expectedBundleHash,
  expectedPlatformHash,
  currentBootId,
  readFile = (path) => readFileSync(path, "utf8"),
  statFile = statSync
}) {
  try {
    const stat = statFile(evidencePath);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return invalid();
    const encoded = readFile(evidencePath);
    if (Buffer.byteLength(encoded, "utf8") > 8_192) return invalid();
    const value = JSON.parse(encoded);
    const keys = Object.keys(value || {}).sort().join(",");
    if (keys !== "bootId,bundleHash,checks,completedAt,configHash,platformHash,runnerMemoryMaxBytes,runnerMemoryPeakBytes,runnerTasksMax,schemaVersion,systemdVerified") return invalid();
    if (value.schemaVersion !== schemaVersion || value.configHash !== expectedConfigHash || value.bundleHash !== expectedBundleHash || value.platformHash !== expectedPlatformHash || value.bootId !== currentBootId) return invalid();
    if (value.systemdVerified !== true || value.runnerMemoryMaxBytes !== 2_147_483_648 || value.runnerTasksMax !== 512) return invalid();
    if (!Number.isSafeInteger(value.runnerMemoryPeakBytes) || value.runnerMemoryPeakBytes <= 0 || value.runnerMemoryPeakBytes > value.runnerMemoryMaxBytes) return invalid();
    if (!Array.isArray(value.checks) || value.checks.join("\0") !== browserSandboxKernelChecks.join("\0")) return invalid();
    if (typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt))) return invalid();
    return { valid: true };
  } catch {
    return invalid();
  }
}
