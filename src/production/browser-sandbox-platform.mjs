import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

const platformKeys = [
  "chromiumSha256",
  "chromiumVersion",
  "iproute2Version",
  "kernelRelease",
  "nftablesVersion",
  "nodeVersion",
  "osRelease",
  "systemdVersion"
];

export function measureBrowserSandboxPlatform(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SANDBOX_PLATFORM_INVALID");
  if (Object.keys(value).sort().join("\0") !== platformKeys.join("\0")) throw new Error("SANDBOX_PLATFORM_INVALID");
  for (const key of platformKeys) {
    if (typeof value[key] !== "string" || value[key].length < 1 || value[key].length > 16_384) {
      throw new Error("SANDBOX_PLATFORM_INVALID");
    }
  }
  if (!/^[a-f0-9]{64}$/.test(value.chromiumSha256)) throw new Error("SANDBOX_PLATFORM_INVALID");
  const canonical = JSON.stringify(Object.fromEntries(platformKeys.map((key) => [key, value[key]])));
  return { hash: createHash("sha256").update(canonical).digest("hex") };
}

function commandVersion(command, args, runCommand) {
  const result = runCommand(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error("SANDBOX_PLATFORM_INVALID");
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (!output) throw new Error("SANDBOX_PLATFORM_INVALID");
  return output.split("\n")[0];
}

function hashFileSha256(path) {
  const descriptor = openSync(path, "r");
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

export function collectBrowserSandboxPlatform({
  chromiumExecutablePath,
  readFile = readFileSync,
  statFile = statSync,
  hashFile = hashFileSha256,
  runCommand = spawnSync
}) {
  if (!chromiumExecutablePath || typeof chromiumExecutablePath !== "string") throw new Error("SANDBOX_PLATFORM_INVALID");
  const chromiumStat = statFile(chromiumExecutablePath);
  if (!chromiumStat.isFile() || chromiumStat.uid !== 0 || (chromiumStat.mode & 0o022) !== 0) {
    throw new Error("SANDBOX_PLATFORM_INVALID");
  }
  return measureBrowserSandboxPlatform({
    osRelease: readFile("/etc/os-release", "utf8"),
    kernelRelease: readFile("/proc/sys/kernel/osrelease", "utf8").trim(),
    systemdVersion: commandVersion("systemd", ["--version"], runCommand),
    nftablesVersion: commandVersion("nft", ["--version"], runCommand),
    iproute2Version: commandVersion("ip", ["-Version"], runCommand),
    nodeVersion: process.version,
    chromiumVersion: chromiumExecutablePath,
    chromiumSha256: hashFile(chromiumExecutablePath)
  });
}
