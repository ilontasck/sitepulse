import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, chownSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { chromium } from "playwright";
import { runBrowserSandboxPreflight, browserSandboxConfigPath } from "../src/production/browser-sandbox-preflight.mjs";
import {
  browserSandboxAttestationPath,
  browserSandboxBundleHashPath,
  browserSandboxAcceptanceTestPath,
  browserSandboxAcceptancePath,
  browserSandboxExpectedHashPath,
  browserSandboxKernelPolicyHashPath,
  browserSandboxNamespacePath,
  browserSandboxOwnershipPath,
  browserSandboxRuntimeDirectory,
  computeBrowserSandboxConfigHash
} from "../src/production/browser-sandbox-policy.mjs";
import { computeBrowserSandboxBundleHash, verifyInstalledBrowserSandboxUnits } from "../src/production/browser-sandbox-bundle.mjs";
import { hashOwnedNftablesState } from "../src/production/nftables-state.mjs";
import { collectBrowserSandboxPlatform } from "../src/production/browser-sandbox-platform.mjs";

function command(name, args, { allowFailure = false, input } = {}) {
  const result = spawnSync(name, args, { encoding: "utf8", input });
  if (!allowFailure && result.status !== 0) throw new Error(`SANDBOX_COMMAND_FAILED:${name}`);
  return result;
}

function exists(name, args) {
  return command(name, args, { allowFailure: true }).status === 0;
}

function readOwnedNftablesState(config) {
  return {
    hostIngress: JSON.parse(command("nft", ["-j", "list", "table", "netdev", "noqori_audit_host"]).stdout),
    hostForward: JSON.parse(command("nft", ["-j", "list", "table", "inet", "noqori_audit_forward"]).stdout),
    hostNat: JSON.parse(command("nft", ["-j", "list", "table", "ip", "noqori_audit_nat"]).stdout),
    namespace: JSON.parse(command("ip", ["netns", "exec", config.namespace, "nft", "-j", "list", "table", "inet", "noqori_audit_namespace"]).stdout)
  };
}

function renderPolicy(source, replacements) {
  let value = source;
  for (const [key, replacement] of Object.entries(replacements)) value = value.replaceAll(`@${key}@`, replacement);
  if (/@[A-Z0-9_]+@/.test(value)) throw new Error("SANDBOX_POLICY_PLACEHOLDER");
  return value;
}

function writeAtomicRootFile(path, contents, mode = 0o440) {
  const temporary = `${path}.${process.pid}.${randomUUID()}`;
  writeFileSync(temporary, contents, { mode });
  chownSync(temporary, 0, 0);
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function removeFile(path) {
  try { unlinkSync(path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

function ownsResources(config) {
  try {
    const ownerStat = statSync(browserSandboxOwnershipPath);
    const owner = JSON.parse(readFileSync(browserSandboxOwnershipPath, "utf8"));
    const namespaceStat = statSync(browserSandboxNamespacePath);
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const link = command("ip", ["-details", "link", "show", config.hostVeth], { allowFailure: true });
    return ownerStat.uid === 0 &&
      (ownerStat.mode & 0o022) === 0 &&
      owner.schemaVersion === 1 &&
      owner.bootId === bootId &&
      owner.namespaceInode === namespaceStat.ino &&
      link.status === 0 &&
      link.stdout.includes("alias noqori-audit-owned");
  } catch {
    return false;
  }
}

function teardown(config, { trustedOwnership = false } = {}) {
  for (const path of [browserSandboxAttestationPath, browserSandboxAcceptanceTestPath, browserSandboxExpectedHashPath, browserSandboxKernelPolicyHashPath, browserSandboxBundleHashPath]) {
    removeFile(path);
  }
  const resourcesExist = exists("ip", ["netns", "exec", config.namespace, "true"]) ||
    exists("ip", ["link", "show", config.hostVeth]) ||
    exists("nft", ["list", "table", "netdev", "noqori_audit_host"]) ||
    exists("nft", ["list", "table", "inet", "noqori_audit_forward"]) ||
    exists("nft", ["list", "table", "ip", "noqori_audit_nat"]);
  if (resourcesExist && !trustedOwnership && !ownsResources(config)) throw new Error("SANDBOX_RESOURCE_OWNERSHIP_MISMATCH");
  command("nft", ["delete", "table", "netdev", "noqori_audit_host"], { allowFailure: true });
  command("nft", ["delete", "table", "inet", "noqori_audit_forward"], { allowFailure: true });
  command("nft", ["delete", "table", "ip", "noqori_audit_nat"], { allowFailure: true });
  command("ip", ["netns", "delete", config.namespace], { allowFailure: true });
  removeFile(browserSandboxOwnershipPath);
  removeFile(`/etc/netns/${config.namespace}/resolv.conf`);
}

const preflight = runBrowserSandboxPreflight();
if (!preflight.ready) {
  console.error(preflight.code);
  process.exitCode = 1;
} else {
  const config = preflight.config;
  if (process.argv.includes("--teardown")) {
    teardown(config);
  } else {
    let trustedOwnership = false;
    try {
      for (const path of [browserSandboxAttestationPath, browserSandboxAcceptanceTestPath, browserSandboxExpectedHashPath, browserSandboxKernelPolicyHashPath, browserSandboxBundleHashPath]) {
        removeFile(path);
      }
      if (!isIP(config.hostPublicIpv4) || config.hostPublicIpv4 === "0.0.0.0" || !/^[a-zA-Z0-9_.-]{1,15}$/.test(config.hostInterface)) {
        throw new Error("SANDBOX_HOST_NETWORK_CONFIG_INVALID");
      }
      if (!exists("sysctl", ["-n", "net.ipv4.ip_forward"]) || command("sysctl", ["-n", "net.ipv4.ip_forward"]).stdout.trim() !== "1") {
        throw new Error("SANDBOX_IP_FORWARDING_REQUIRED");
      }
      const namespaceExists = exists("ip", ["netns", "exec", config.namespace, "true"]);
      const vethExists = exists("ip", ["link", "show", config.hostVeth]);
      const tableExists = exists("nft", ["list", "table", "netdev", "noqori_audit_host"]) ||
        exists("nft", ["list", "table", "inet", "noqori_audit_forward"]) ||
        exists("nft", ["list", "table", "ip", "noqori_audit_nat"]);
      if (namespaceExists || vethExists || tableExists) {
        if (!namespaceExists || !vethExists || !ownsResources(config)) throw new Error("SANDBOX_RESOURCE_OWNERSHIP_MISMATCH");
        trustedOwnership = true;
      } else {
        trustedOwnership = true;
        command("ip", ["netns", "add", config.namespace]);
        command("ip", ["link", "add", config.hostVeth, "type", "veth", "peer", "name", config.namespaceVeth]);
        command("ip", ["link", "set", config.namespaceVeth, "netns", config.namespace]);
        command("ip", ["link", "set", "dev", config.hostVeth, "alias", "noqori-audit-owned"]);
        const owner = {
          schemaVersion: 1,
          bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
          namespaceInode: statSync(browserSandboxNamespacePath).ino
        };
        writeAtomicRootFile(browserSandboxOwnershipPath, `${JSON.stringify(owner)}\n`, 0o440);
      }
      command("ip", ["address", "replace", config.hostAddress, "dev", config.hostVeth]);
      command("ip", ["link", "set", config.hostVeth, "up"]);
      command("ip", ["-n", config.namespace, "address", "replace", config.namespaceAddress, "dev", config.namespaceVeth]);
      command("ip", ["-n", config.namespace, "link", "set", "lo", "up"]);
      command("ip", ["-n", config.namespace, "link", "set", config.namespaceVeth, "up"]);
      const gateway = config.hostAddress.split("/")[0];
      command("ip", ["-n", config.namespace, "route", "replace", "default", "via", gateway, "dev", config.namespaceVeth]);
      command("ip", ["netns", "exec", config.namespace, "sysctl", "-qw", "net.ipv6.conf.all.disable_ipv6=1"]);
      command("ip", ["netns", "exec", config.namespace, "sysctl", "-qw", "net.ipv6.conf.default.disable_ipv6=1"]);

      mkdirSync(`/etc/netns/${config.namespace}`, { recursive: true, mode: 0o755 });
      writeAtomicRootFile(`/etc/netns/${config.namespace}/resolv.conf`, `${config.dnsResolvers.map((ip) => `nameserver ${ip}`).join("\n")}\n`, 0o444);
      const registry = JSON.parse(readFileSync(new URL("../deploy/network/iana-special-purpose-ipv4.json", import.meta.url), "utf8"));
      const replacements = {
        BLOCKED_IPV4: registry.blockedPrefixes.join(", "),
        DNS_IPV4: config.dnsResolvers.join(", "),
        GATEWAY_IPV4: gateway,
        HOST_PUBLIC_IPV4: config.hostPublicIpv4,
        HOST_INTERFACE: config.hostInterface
      };
      const namespacePolicy = renderPolicy(readFileSync(new URL("../deploy/network/noqori-audit-namespace.nft", import.meta.url), "utf8"), replacements);
      const hostPolicy = renderPolicy(readFileSync(new URL("../deploy/network/noqori-audit-host.nft", import.meta.url), "utf8"), replacements);
      command("ip", ["netns", "exec", config.namespace, "nft", "delete", "table", "inet", "noqori_audit_namespace"], { allowFailure: true });
      command("ip", ["netns", "exec", config.namespace, "nft", "-f", "-"], { input: namespacePolicy });
      command("nft", ["delete", "table", "netdev", "noqori_audit_host"], { allowFailure: true });
      command("nft", ["delete", "table", "inet", "noqori_audit_forward"], { allowFailure: true });
      command("nft", ["delete", "table", "ip", "noqori_audit_nat"], { allowFailure: true });
      command("nft", ["-f", "-"], { input: hostPolicy });

      mkdirSync(browserSandboxRuntimeDirectory, { recursive: true, mode: 0o750 });
      const configText = readFileSync(browserSandboxConfigPath, "utf8");
      const configHash = computeBrowserSandboxConfigHash(configText);
      const bundleHash = computeBrowserSandboxBundleHash();
      if (!verifyInstalledBrowserSandboxUnits()) throw new Error("SANDBOX_INSTALLED_UNITS_MISMATCH");
      const platformHash = collectBrowserSandboxPlatform({ chromiumExecutablePath: chromium.executablePath() }).hash;
      let vmAcceptancePassed = false;
      try {
        const acceptanceStat = statSync(browserSandboxAcceptancePath);
        const acceptance = JSON.parse(readFileSync(browserSandboxAcceptancePath, "utf8"));
        vmAcceptancePassed = acceptanceStat.uid === 0 &&
          (acceptanceStat.mode & 0o022) === 0 &&
          acceptance.schemaVersion === 2 &&
          acceptance.configHash === configHash &&
          acceptance.bundleHash === bundleHash &&
          acceptance.platformHash === platformHash &&
          typeof acceptance.acceptedAt === "string";
      } catch {
        vmAcceptancePassed = false;
      }
      writeAtomicRootFile(browserSandboxExpectedHashPath, `${configHash}\n`, 0o444);
      writeAtomicRootFile(browserSandboxBundleHashPath, `${bundleHash}\n`, 0o444);
      writeAtomicRootFile(browserSandboxKernelPolicyHashPath, `${hashOwnedNftablesState(readOwnedNftablesState(config))}\n`, 0o444);
      writeAtomicRootFile(browserSandboxAcceptanceTestPath, `${JSON.stringify({
        schemaVersion: 2,
        configHash,
        bundleHash,
        platformHash,
        bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
        enabled: false,
        expiresAt: "1970-01-01T00:00:00.000Z"
      })}\n`, 0o444);
      const namespaceInode = statSync(browserSandboxNamespacePath).ino;
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      writeAtomicRootFile(browserSandboxAttestationPath, `${JSON.stringify({
        schemaVersion: 2,
        configHash,
        bundleHash,
        platformHash,
        namespacePath: browserSandboxNamespacePath,
        namespaceInode,
        bootId,
        vmAcceptancePassed,
        createdAt: new Date().toISOString()
      })}\n`, 0o444);
    } catch (error) {
      if (trustedOwnership) teardown(config, { trustedOwnership: true });
      console.error(error?.message?.startsWith("SANDBOX_") ? error.message : "SANDBOX_SETUP_FAILED");
      process.exitCode = 1;
    }
  }
}
