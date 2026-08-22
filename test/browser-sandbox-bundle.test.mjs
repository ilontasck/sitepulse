import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeBrowserSandboxBundleHashFromEntries,
  verifyInstalledBrowserSandboxUnits
} from "../src/production/browser-sandbox-bundle.mjs";

describe("browser sandbox immutable bundle", () => {
  it("binds acceptance to paths and bytes across source and dependency closure", () => {
    const entries = [
      { path: "package.json", contents: Buffer.from("{\"type\":\"module\"}") },
      { path: "src/audit/audit-runner-server.mjs", contents: Buffer.from("export const gate = true;") },
      { path: "node_modules/lighthouse/index.js", contents: Buffer.from("export default 1;") }
    ];
    const initial = computeBrowserSandboxBundleHashFromEntries(entries);
    assert.match(initial, /^[a-f0-9]{64}$/);
    assert.notEqual(initial, computeBrowserSandboxBundleHashFromEntries(entries.map((entry) =>
      entry.path.includes("audit-runner-server") ? { ...entry, contents: Buffer.from("export const gate = false;") } : entry
    )));
    assert.notEqual(initial, computeBrowserSandboxBundleHashFromEntries(entries.map((entry) =>
      entry.path.includes("lighthouse") ? { ...entry, contents: Buffer.from("export default 2;") } : entry
    )));
  });

  it("accepts only exact installed unit bytes with no drop-ins", () => {
    const files = new Map([
      ["/bundle/deploy/systemd/noqori-audit-runner.service", "runner"],
      ["/etc/systemd/system/noqori-audit-runner.service", "runner"]
    ]);
    const verify = ({ installed = "runner", dropIns = "" } = {}) => {
      files.set("/etc/systemd/system/noqori-audit-runner.service", installed);
      return verifyInstalledBrowserSandboxUnits({
        bundleRoot: "/bundle",
        unitNames: ["noqori-audit-runner.service"],
        readFile: (path) => files.get(path),
        runCommand: (_command, args) => ({
          status: 0,
          stdout: args.includes("--property=FragmentPath")
            ? "/etc/systemd/system/noqori-audit-runner.service\n"
            : `${dropIns}\n`,
          stderr: ""
        })
      });
    };
    assert.equal(verify(), true);
    assert.equal(verify({ installed: "changed" }), false);
    assert.equal(verify({ dropIns: "/etc/systemd/system/noqori-audit-runner.service.d/override.conf" }), false);
  });
});
