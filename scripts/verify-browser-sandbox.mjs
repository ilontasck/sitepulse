import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { loadBrowserSandboxAttestation } from "../src/production/browser-sandbox-attestation.mjs";
import { browserSandboxConfigPath } from "../src/production/browser-sandbox-preflight.mjs";
import {
  browserSandboxKernelPolicyHashPath,
  browserSandboxBundleHashPath,
  browserSandboxPlatformHashPath,
  browserSandboxNamespacePath,
  browserSandboxOwnershipPath,
  computeBrowserSandboxConfigHash
} from "../src/production/browser-sandbox-policy.mjs";
import { computeBrowserSandboxBundleHash, verifyInstalledBrowserSandboxUnits } from "../src/production/browser-sandbox-bundle.mjs";
import { hashOwnedNftablesState } from "../src/production/nftables-state.mjs";
import { collectBrowserSandboxPlatform } from "../src/production/browser-sandbox-platform.mjs";
import { chromium } from "playwright";

function succeeds(name, args, expected = null) {
  const result = spawnSync(name, args, { encoding: "utf8" });
  return result.status === 0 && (expected === null || expected.test(result.stdout));
}

function jsonCommand(name, args) {
  const result = spawnSync(name, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error("invalid");
  return JSON.parse(result.stdout);
}

try {
  const configText = readFileSync(browserSandboxConfigPath, "utf8");
  const config = JSON.parse(configText);
  const expectedHash = computeBrowserSandboxConfigHash(configText);
  const currentPlatformHash = collectBrowserSandboxPlatform({ chromiumExecutablePath: chromium.executablePath() }).hash;
  const attestation = loadBrowserSandboxAttestation();
  const namespaceStat = statSync(browserSandboxNamespacePath);
  const ownershipStat = statSync(browserSandboxOwnershipPath);
  const ownership = JSON.parse(readFileSync(browserSandboxOwnershipPath, "utf8"));
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const resolverPath = `/etc/netns/${config.namespace}/resolv.conf`;
  const resolverStat = statSync(resolverPath);
  const resolver = readFileSync(resolverPath, "utf8").trim().split("\n");
  const socketStat = statSync("/run/noqori-audit.sock");
  const rpcGidResult = spawnSync("getent", ["group", "noqori-audit-rpc"], { encoding: "utf8" });
  const rpcGid = Number(rpcGidResult.stdout.split(":")[2]);
  const storedHash = readFileSync("/run/noqori-audit/expected-config.sha256", "utf8").trim();
  const storedBundleHash = readFileSync(browserSandboxBundleHashPath, "utf8").trim();
  const platformHashStat = statSync(browserSandboxPlatformHashPath);
  const storedPlatformHash = readFileSync(browserSandboxPlatformHashPath, "utf8").trim();
  const currentBundleHash = computeBrowserSandboxBundleHash();
  const kernelHashStat = statSync(browserSandboxKernelPolicyHashPath);
  const storedKernelHash = readFileSync(browserSandboxKernelPolicyHashPath, "utf8").trim();
  const actualKernelHash = hashOwnedNftablesState({
    hostIngress: jsonCommand("nft", ["-j", "list", "table", "netdev", "noqori_audit_host"]),
    hostForward: jsonCommand("nft", ["-j", "list", "table", "inet", "noqori_audit_forward"]),
    hostNat: jsonCommand("nft", ["-j", "list", "table", "ip", "noqori_audit_nat"]),
    namespace: jsonCommand("ip", ["netns", "exec", config.namespace, "nft", "-j", "list", "table", "inet", "noqori_audit_namespace"])
  });
  const valid =
    attestation.valid === true &&
    attestation.platformHash === currentPlatformHash &&
    platformHashStat.uid === 0 && (platformHashStat.mode & 0o222) === 0 && storedPlatformHash === currentPlatformHash &&
    attestation.bundleHash === currentBundleHash && storedBundleHash === currentBundleHash &&
    verifyInstalledBrowserSandboxUnits() &&
    namespaceStat.ino === attestation.namespaceInode &&
    ownershipStat.uid === 0 && (ownershipStat.mode & 0o022) === 0 &&
    ownership.namespaceInode === namespaceStat.ino && ownership.bootId === bootId &&
    storedHash === expectedHash &&
    kernelHashStat.uid === 0 && (kernelHashStat.mode & 0o222) === 0 &&
    /^[a-f0-9]{64}$/.test(storedKernelHash) && storedKernelHash === actualKernelHash &&
    resolverStat.uid === 0 && (resolverStat.mode & 0o222) === 0 &&
    resolver.join("\n") === config.dnsResolvers.map((ip) => `nameserver ${ip}`).join("\n") &&
    socketStat.uid === 0 && socketStat.gid === rpcGid && Number.isInteger(rpcGid) && (socketStat.mode & 0o777) === 0o660 &&
    succeeds("ip", ["link", "show", config.hostVeth]) &&
    succeeds("ip", ["-n", config.namespace, "route", "show", "default"], /default/) &&
    succeeds("ip", ["netns", "exec", config.namespace, "sysctl", "-n", "net.ipv6.conf.all.disable_ipv6"], /^1\s*$/);
  if (!valid) throw new Error("invalid");
  console.log("BROWSER_SANDBOX_ATTESTATION_OK");
} catch {
  console.error("BROWSER_SANDBOX_ATTESTATION_INVALID");
  process.exitCode = 1;
}
