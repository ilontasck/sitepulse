import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runBrowserSandboxPreflight } from "../src/production/browser-sandbox-preflight.mjs";

const validConfig = JSON.stringify({
  schemaVersion: 1,
  namespace: "noqori-audit",
  hostVeth: "nq-audit-host",
  namespaceVeth: "nq-audit-net",
  hostAddress: "198.19.0.1/30",
  namespaceAddress: "198.19.0.2/30",
  hostInterface: "eth0",
  hostPublicIpv4: "93.184.216.34",
  dnsResolvers: ["1.1.1.1", "9.9.9.9"],
  enableIpv6: false,
  enableQuic: false
});

function preflight(overrides = {}) {
  return runBrowserSandboxPreflight({
    platform: "linux",
    architecture: "x64",
    getUid: () => 0,
    readOsRelease: () => 'ID=ubuntu\nVERSION_ID="26.04"\n',
    readConfig: () => validConfig,
    statConfig: () => ({ uid: 0, mode: 0o100440, isFile: () => true }),
    command: (name, args) => {
      if (name === "systemd") return { status: 0, stdout: "systemd 259 (259.2)" };
      if (name === "systemd-analyze") return { status: 0, stdout: "" };
      if (name === "/usr/bin/node") return { status: 0, stdout: "v24.14.0" };
      if (name === "test") return { status: 0, stdout: "" };
      if (["ip", "nft", "sysctl"].includes(name)) return { status: 0, stdout: "" };
      throw new Error(`unexpected ${name} ${args.join(" ")}`);
    },
    ...overrides
  });
}

describe("browser sandbox production preflight", () => {
  it("requires the fixed Linux/systemd 259 baseline and root-owned configuration", () => {
    assert.equal(preflight().ready, true);
    assert.equal(preflight({ platform: "darwin" }).ready, false);
    assert.equal(preflight({ architecture: "arm64" }).ready, false);
    assert.equal(preflight({ readOsRelease: () => 'ID=ubuntu\nVERSION_ID="24.04"\n' }).ready, false);
    assert.equal(preflight({ command: (name) => ({ status: 0, stdout: name === "systemd" ? "systemd 259" : name === "/usr/bin/node" ? "v22.0.0" : "" }) }).ready, false);
    assert.equal(preflight({ getUid: () => 1000 }).ready, false);
    assert.equal(preflight({ command: (name) => name === "systemd" ? { status: 0, stdout: "systemd 258" } : { status: 0, stdout: "" } }).ready, false);
    assert.equal(preflight({ statConfig: () => ({ uid: 1000, mode: 0o100440, isFile: () => true }) }).ready, false);
  });

  it("fails closed for resolver placeholders, IPv6, QUIC, or missing host tools", () => {
    assert.equal(preflight({ readConfig: () => validConfig.replace("1.1.1.1", "REPLACE_WITH_IPV4_RESOLVER_1") }).ready, false);
    assert.equal(preflight({ readConfig: () => validConfig.replace("1.1.1.1", "169.254.169.254") }).ready, false);
    assert.equal(preflight({ readConfig: () => validConfig.replace('"enableIpv6":false', '"enableIpv6":true') }).ready, false);
    assert.equal(preflight({ readConfig: () => validConfig.replace('"enableQuic":false', '"enableQuic":true') }).ready, false);
    assert.equal(preflight({ command: (name, args) => ({ status: name === "test" && args.includes("/usr/sbin/nft") ? 1 : 0, stdout: name === "systemd" ? "systemd 259" : name === "/usr/bin/node" ? "v24.0.0" : "" }) }).ready, false);
  });
});
