import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { isUnsafeIpAddress } from "../audit/url-safety.mjs";

export const browserSandboxConfigPath = "/etc/noqori/audit-network.json";

function unavailable(code) {
  return { ready: false, code };
}

function defaultCommand(name, args) {
  const result = spawnSync(name, args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

export function runBrowserSandboxPreflight({
  platform = process.platform,
  architecture = process.arch,
  getUid = () => process.getuid?.(),
  readOsRelease = () => readFileSync("/etc/os-release", "utf8"),
  configPath = browserSandboxConfigPath,
  readConfig = (path) => readFileSync(path, "utf8"),
  statConfig = statSync,
  command = defaultCommand
} = {}) {
  try {
    if (platform !== "linux" || architecture !== "x64" || getUid() !== 0) return unavailable("UNSUPPORTED_SANDBOX_HOST");
    const osRelease = readOsRelease();
    if (!/^ID=ubuntu$/m.test(osRelease) || !/^VERSION_ID="?26\.04"?$/m.test(osRelease)) {
      return unavailable("UBUNTU_26_04_REQUIRED");
    }
    const systemd = command("systemctl", ["--version"]);
    const systemdVersion = Number(systemd.stdout.match(/systemd\s+(\d+)/)?.[1]);
    if (systemd.status !== 0 || systemdVersion < 259) return unavailable("SYSTEMD_259_REQUIRED");
    if (command("systemd-analyze", ["verify", "deploy/systemd/noqori-audit-runner.service"]).status !== 0) {
      return unavailable("NETWORK_NAMESPACE_PATH_UNSUPPORTED");
    }
    for (const tool of ["/usr/bin/node", "/usr/sbin/ip", "/usr/sbin/nft", "/usr/sbin/sysctl"]) {
      if (command("test", ["-x", tool]).status !== 0) return unavailable("SANDBOX_TOOL_MISSING");
    }
    const nodeMajor = Number(command("/usr/bin/node", ["--version"]).stdout.match(/^v(\d+)/)?.[1]);
    if (nodeMajor !== 24) return unavailable("NODE_24_REQUIRED");
    if (command("ip", ["netns", "list"]).status !== 0 || command("nft", ["--version"]).status !== 0) {
      return unavailable("KERNEL_NETWORK_SANDBOX_UNAVAILABLE");
    }
    const stat = statConfig(configPath);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o027) !== 0) return unavailable("SANDBOX_CONFIG_PERMISSIONS");
    const config = JSON.parse(readConfig(configPath));
    const configKeys = Object.keys(config || {}).sort().join(",");
    if (
      configKeys !== "dnsResolvers,enableIpv6,enableQuic,hostAddress,hostInterface,hostPublicIpv4,hostVeth,namespace,namespaceAddress,namespaceVeth,schemaVersion" ||
      config.schemaVersion !== 1 ||
      config.namespace !== "noqori-audit" ||
      config.hostVeth !== "nq-audit-host" ||
      config.namespaceVeth !== "nq-audit-net" ||
      config.hostAddress !== "198.19.0.1/30" ||
      config.namespaceAddress !== "198.19.0.2/30" ||
      config.enableIpv6 !== false ||
      config.enableQuic !== false ||
      !/^[a-zA-Z0-9_.-]{1,15}$/.test(config.hostInterface) ||
      isIP(config.hostPublicIpv4) !== 4 || isUnsafeIpAddress(config.hostPublicIpv4) ||
      !Array.isArray(config.dnsResolvers) ||
      config.dnsResolvers.length !== 2 ||
      config.dnsResolvers.some((value) => isIP(value) !== 4 || isUnsafeIpAddress(value))
    ) return unavailable("SANDBOX_CONFIG_INVALID");
    return { ready: true, config };
  } catch {
    return unavailable("SANDBOX_PREFLIGHT_FAILED");
  }
}
