import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const unitNames = [
  "noqori.target",
  "noqori-migrate.service",
  "noqori-api.service",
  "noqori-worker.service",
  "noqori-audit-sandbox.service",
  "noqori-audit-sandbox-verify.service",
  "noqori-audit-runner.socket",
  "noqori-audit-runner.service"
];

const unitPaths = unitNames.map((name) =>
  fileURLToPath(new URL(`../../deploy/systemd/${name}`, import.meta.url))
);

export function verifySystemdUnits({
  platform = process.platform,
  runCommand = spawnSync
} = {}) {
  if (platform !== "linux") {
    return { status: "UNAVAILABLE", reason: "systemd verification requires Linux." };
  }

  const result = runCommand("systemd-analyze", ["verify", ...unitPaths], {
    encoding: "utf8",
    shell: false
  });

  if (result.error?.code === "ENOENT") {
    return { status: "UNAVAILABLE", reason: "systemd-analyze is not installed." };
  }

  if (result.error || result.status !== 0) {
    return {
      status: "FAILED",
      reason: "systemd-analyze rejected the NOQORI unit files.",
      details: String(result.stderr || result.error?.message || "").trim()
    };
  }

  return { status: "PASS", units: [...unitNames] };
}
