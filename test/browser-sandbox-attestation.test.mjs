import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  browserSandboxAcceptanceChecks,
  loadAuditRunnerAcceptance,
  loadBrowserSandboxAttestation,
  verifyBrowserSandboxAcceptanceEvidence,
  verifyBrowserSandboxKernelEvidence,
  verifyBrowserSandboxAttestation
} from "../src/production/browser-sandbox-attestation.mjs";

const expectedHash = "a".repeat(64);
const expectedPlatformHash = "b".repeat(64);
const expectedBundleHash = "c".repeat(64);
const validPayload = JSON.stringify({
  schemaVersion: 2,
  configHash: expectedHash,
  bundleHash: expectedBundleHash,
  platformHash: expectedPlatformHash,
  namespacePath: "/run/netns/noqori-audit",
  namespaceInode: 4026533001,
  bootId: "11111111-2222-4333-8444-555555555555",
  vmAcceptancePassed: false,
  createdAt: "2026-08-21T10:00:00.000Z"
});

function verify(overrides = {}) {
  return verifyBrowserSandboxAttestation({
    attestationPath: "/run/noqori-audit-attestation.json",
    expectedConfigHash: expectedHash,
    expectedBundleHash,
    expectedNamespacePath: "/run/netns/noqori-audit",
    currentBootId: "11111111-2222-4333-8444-555555555555",
    readFile: () => validPayload,
    statFile: () => ({ uid: 0, gid: 991, mode: 0o100440, isFile: () => true }),
    ...overrides
  });
}

describe("browser sandbox attestation", () => {
  it("accepts only a root-owned boot-bound attestation with the expected configuration hash", () => {
    assert.deepEqual(verify(), {
      valid: true,
      vmAcceptancePassed: false,
      namespaceInode: 4026533001,
      platformHash: expectedPlatformHash,
      bundleHash: expectedBundleHash
    });
    assert.equal(verify({ statFile: () => ({ uid: 501, gid: 20, mode: 0o100440, isFile: () => true }) }).valid, false);
    assert.equal(verify({ readFile: () => validPayload.replace(expectedHash, "b".repeat(64)) }).valid, false);
    assert.equal(verify({ currentBootId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }).valid, false);
    assert.equal(verify({ readFile: () => validPayload.replace(/}$/, ',"secret":"no"}') }).valid, false);
    assert.equal(verify({ statFile: () => ({ uid: 0, gid: 991, mode: 0o100466, isFile: () => true }) }).valid, false);
    assert.equal(verify({ readFile: () => "x".repeat(4_097) }).valid, false);
    assert.equal(verify({ readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } }).valid, false);
  });

  it("binds acceptance to the current root-owned namespace handle inode", () => {
    const files = new Map([
      ["/expected", `${expectedHash}\n`],
      ["/bundle", `${expectedBundleHash}\n`],
      ["/boot", "11111111-2222-4333-8444-555555555555\n"],
      ["/attestation", validPayload]
    ]);
    const load = (namespaceInode) => loadBrowserSandboxAttestation({
      attestationPath: "/attestation",
      expectedHashPath: "/expected",
      bundleHashPath: "/bundle",
      namespacePath: "/run/netns/noqori-audit",
      bootIdPath: "/boot",
      readFile: (path) => files.get(path),
      getUid: () => 1001,
      statFile: (path) => {
        if (path === "/run/netns/noqori-audit") return { uid: 0, ino: namespaceInode };
        return { uid: 0, mode: 0o100440, isFile: () => true };
      }
    });

    assert.equal(load(4026533001).valid, true);
    assert.equal(load(4026533999).valid, false);
  });

  it("lets the runner trust rendered acceptance only from root credentials for its current namespace", () => {
    const acceptedPayload = validPayload.replace('"vmAcceptancePassed":false', '"vmAcceptancePassed":true');
    const files = new Map([
      ["/credentials/sandbox-attestation", acceptedPayload],
      ["/credentials/sandbox-config-hash", `${expectedHash}\n`],
      ["/credentials/sandbox-bundle-hash", `${expectedBundleHash}\n`],
      ["/credentials/sandbox-platform-hash", `${expectedPlatformHash}\n`],
      ["/credentials/sandbox-acceptance-test", JSON.stringify({
        schemaVersion: 2,
        configHash: expectedHash,
        bundleHash: expectedBundleHash,
        platformHash: expectedPlatformHash,
        bootId: "11111111-2222-4333-8444-555555555555",
        enabled: false,
        expiresAt: "2026-08-21T12:15:00.000Z"
      })],
      ["/proc/sys/kernel/random/boot_id", "11111111-2222-4333-8444-555555555555\n"]
    ]);
    const load = ({ namespaceInode = 4026533001, credentialUid = 0, credentialGid = 0, credentialMode = 0o100400 } = {}) => loadAuditRunnerAcceptance({
      credentialsDirectory: "/credentials",
      currentPlatformHash: expectedPlatformHash,
      currentBundleHash: expectedBundleHash,
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      readFile: (path) => files.get(path),
      statFile: (path) => {
        if (path === "/proc/self/ns/net") return { uid: 0, ino: namespaceInode };
        return Object.assign(Object.create({ isFile: () => true }), {
          uid: credentialUid,
          gid: credentialGid,
          mode: credentialMode
        });
      }
    });

    assert.deepEqual(load(), { valid: true, renderedAuditAllowed: true });
    assert.deepEqual(load({ credentialMode: 0o100440 }), { valid: true, renderedAuditAllowed: true });
    assert.equal(load({ credentialMode: 0o100440, credentialGid: 1000 }).valid, false);
    assert.equal(load({ credentialMode: 0o100460 }).valid, false);
    assert.equal(load({ namespaceInode: 4026533999 }).valid, false);
    assert.equal(load({ credentialUid: 1000 }).valid, false);
    assert.equal(loadAuditRunnerAcceptance({
      credentialsDirectory: "/credentials",
      currentPlatformHash: expectedPlatformHash,
      currentBundleHash: "d".repeat(64),
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      readFile: (path) => files.get(path),
      statFile: (path) => path === "/proc/self/ns/net"
        ? { uid: 0, ino: 4026533001 }
        : { uid: 0, mode: 0o100400, isFile: () => true }
    }).valid, false);
    assert.equal(loadAuditRunnerAcceptance({
      credentialsDirectory: "/credentials",
      currentPlatformHash: "c".repeat(64),
      currentBundleHash: expectedBundleHash,
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      readFile: (path) => files.get(path),
      statFile: (path) => path === "/proc/self/ns/net"
        ? { uid: 0, ino: 4026533001 }
        : { uid: 0, mode: 0o100400, isFile: () => true }
    }).valid, false);

    files.set("/credentials/sandbox-attestation", validPayload);
    files.set("/credentials/sandbox-acceptance-test", JSON.stringify({
      schemaVersion: 2,
      configHash: expectedHash,
      bundleHash: expectedBundleHash,
      platformHash: expectedPlatformHash,
      bootId: "11111111-2222-4333-8444-555555555555",
      enabled: true,
      expiresAt: "2026-08-21T12:15:00.000Z"
    }));
    assert.deepEqual(loadAuditRunnerAcceptance({
      credentialsDirectory: "/credentials",
      currentPlatformHash: expectedPlatformHash,
      currentBundleHash: expectedBundleHash,
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      readFile: (path) => files.get(path),
      getUid: () => 1001,
      statFile: (path) => path === "/proc/self/ns/net"
        ? { uid: 0, ino: 4026533001 }
        : { uid: 0, mode: 0o100400, isFile: () => true }
    }), { valid: true, renderedAuditAllowed: true });
  });

  it("requires complete reboot-bound VM evidence before acceptance can be recorded", () => {
    const checks = [...browserSandboxAcceptanceChecks];
    const payload = JSON.stringify({
      schemaVersion: 2,
      configHash: expectedHash,
      bundleHash: expectedBundleHash,
      platformHash: expectedPlatformHash,
      beforeRebootBootId: "11111111-2222-4333-8444-555555555555",
      afterRebootBootId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      checks,
      completedAt: "2026-08-21T12:00:00.000Z"
    });
    const verify = (value = payload) => verifyBrowserSandboxAcceptanceEvidence({
      evidencePath: "/evidence",
      expectedConfigHash: expectedHash,
      expectedBundleHash,
      expectedPlatformHash,
      readFile: () => value,
      statFile: () => ({ uid: 0, mode: 0o100440, isFile: () => true })
    });
    assert.equal(verify().valid, true);
    assert.equal(verify(payload.replace('"rpc-isolation",', "")).valid, false);
    assert.equal(verify(payload.replace(expectedPlatformHash, "c".repeat(64))).valid, false);
    assert.equal(verify(payload.replace("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "11111111-2222-4333-8444-555555555555")).valid, false);
  });

  it("accepts kernel evidence only with measured systemd, cancellation, and cgroup gates", () => {
    const payload = JSON.stringify({
      schemaVersion: 2,
      configHash: expectedHash,
      bundleHash: expectedBundleHash,
      platformHash: expectedPlatformHash,
      bootId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      checks: browserSandboxAcceptanceChecks.filter((check) => ![
        "reboot-persistence", "single-worker-cgroup", "worker-crash-recovery-fencing"
      ].includes(check)),
      systemdVerified: true,
      runnerMemoryMaxBytes: 2_147_483_648,
      runnerMemoryPeakBytes: 456_789_012,
      runnerTasksMax: 512,
      completedAt: "2026-08-21T12:00:00.000Z"
    });
    const verifyKernel = (value = payload) => verifyBrowserSandboxKernelEvidence({
      evidencePath: "/kernel-evidence",
      expectedConfigHash: expectedHash,
      expectedBundleHash,
      expectedPlatformHash,
      currentBootId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      readFile: () => value,
      statFile: () => ({ uid: 0, mode: 0o100440, isFile: () => true })
    });
    assert.equal(verifyKernel().valid, true);
    assert.equal(verifyKernel(payload.replace('"systemdVerified":true', '"systemdVerified":false')).valid, false);
    assert.equal(verifyKernel(payload.replace('"runnerMemoryPeakBytes":456789012', '"runnerMemoryPeakBytes":2147483649')).valid, false);
    assert.equal(verifyKernel(payload.replace('"runner-client-timeout-cancellation",', "")).valid, false);
  });
});
