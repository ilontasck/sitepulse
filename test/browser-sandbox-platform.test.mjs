import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectBrowserSandboxPlatform, measureBrowserSandboxPlatform } from "../src/production/browser-sandbox-platform.mjs";

describe("browser sandbox platform fingerprint", () => {
  it("changes when a security-relevant host or Chromium component changes", () => {
    const base = {
      osRelease: "ID=ubuntu\nVERSION_ID=26.04\n",
      kernelRelease: "6.20.0-1-generic",
      systemdVersion: "systemd 259",
      nftablesVersion: "nftables v1.1.0",
      iproute2Version: "ip utility, iproute2-6.12.0",
      nodeVersion: "v24.6.0",
      chromiumVersion: "Chromium 140.0.7339.16",
      chromiumSha256: "a".repeat(64)
    };
    const measured = measureBrowserSandboxPlatform(base);
    assert.match(measured.hash, /^[a-f0-9]{64}$/);
    assert.notEqual(measured.hash, measureBrowserSandboxPlatform({ ...base, kernelRelease: "6.20.0-2-generic" }).hash);
    assert.notEqual(measured.hash, measureBrowserSandboxPlatform({ ...base, chromiumSha256: "b".repeat(64) }).hash);
    assert.throws(() => measureBrowserSandboxPlatform({ ...base, chromiumSha256: "invalid" }), /SANDBOX_PLATFORM_INVALID/);
  });

  it("hashes a root-owned Chromium binary without executing it as root", () => {
    const commands = [];
    const result = collectBrowserSandboxPlatform({
      chromiumExecutablePath: "/opt/noqori/shared/ms-playwright/chromium-1228/chrome",
      statFile: () => ({ uid: 0, mode: 0o100555, isFile: () => true }),
      hashFile: () => "d".repeat(64),
      readFile: (path, encoding) => path === "/etc/os-release"
        ? "ID=ubuntu\nVERSION_ID=26.04\n"
        : path === "/proc/sys/kernel/osrelease"
          ? "6.20.0-1-generic\n"
          : encoding ? "unexpected" : Buffer.from("unexpected"),
      runCommand: (command) => {
        commands.push(command);
        return { status: 0, stdout: command === "systemd" ? "systemd 259\n" : `${command} v1\n`, stderr: "" };
      }
    });
    assert.match(result.hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(commands, ["systemd", "nft", "ip"]);
    assert.throws(() => collectBrowserSandboxPlatform({
      chromiumExecutablePath: "/tmp/chrome",
      statFile: () => ({ uid: 1000, mode: 0o100755, isFile: () => true })
    }), /SANDBOX_PLATFORM_INVALID/);
  });
});
