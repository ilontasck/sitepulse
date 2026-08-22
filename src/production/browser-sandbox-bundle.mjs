import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const browserSandboxBundleRoot = fileURLToPath(new URL("../../", import.meta.url));

export const browserSandboxSystemdUnitNames = [
  "noqori.target",
  "noqori-migrate.service",
  "noqori-api.service",
  "noqori-worker.service",
  "noqori-audit-sandbox.service",
  "noqori-audit-sandbox-verify.service",
  "noqori-audit-runner.socket",
  "noqori-audit-runner.service"
];

const bundleDirectories = ["deploy", "scripts", "src", "test/linux", "node_modules"];

function updateBundleHash(hash, path, contents) {
  hash.update(Buffer.from(`${Buffer.byteLength(path)}:${path}:${contents.length}:`));
  hash.update(contents);
}

export function computeBrowserSandboxBundleHashFromEntries(entries) {
  const normalized = entries.map(({ path, contents }) => ({
    path: String(path).replaceAll("\\", "/"),
    contents: Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
  })).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(normalized.map(({ path }) => path)).size !== normalized.length) throw new Error("SANDBOX_BUNDLE_DUPLICATE_PATH");
  const hash = createHash("sha256");
  for (const entry of normalized) updateBundleHash(hash, entry.path, entry.contents);
  return hash.digest("hex");
}

function collectFiles(path, root, paths) {
  const children = readdirSync(path, { withFileTypes: true });
  for (const child of children) {
    const childPath = resolve(path, child.name);
    if (child.isSymbolicLink()) throw new Error("SANDBOX_BUNDLE_SYMLINK");
    if (child.isDirectory()) collectFiles(childPath, root, paths);
    else if (child.isFile()) paths.push(childPath);
    else throw new Error("SANDBOX_BUNDLE_UNSUPPORTED_ENTRY");
  }
}

export function computeBrowserSandboxBundleHash({ bundleRoot = browserSandboxBundleRoot } = {}) {
  const paths = [];
  for (const entry of bundleDirectories) {
    const path = resolve(bundleRoot, entry);
    collectFiles(path, bundleRoot, paths);
  }
  for (const file of ["package.json", "pnpm-lock.yaml"]) {
    const path = resolve(bundleRoot, file);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("SANDBOX_BUNDLE_INVALID_MANIFEST");
    paths.push(path);
  }
  const hash = createHash("sha256");
  for (const path of paths.sort((left, right) => relative(bundleRoot, left).localeCompare(relative(bundleRoot, right)))) {
    const relativePath = relative(bundleRoot, path).replaceAll("\\", "/");
    updateBundleHash(hash, relativePath, readFileSync(path));
  }
  return hash.digest("hex");
}

export function verifyInstalledBrowserSandboxUnits({
  bundleRoot = browserSandboxBundleRoot,
  unitNames = browserSandboxSystemdUnitNames,
  readFile = (path) => readFileSync(path),
  runCommand = (command, args) => spawnSync(command, args, { encoding: "utf8" })
} = {}) {
  try {
    return unitNames.every((unitName) => {
      const fragment = runCommand("systemctl", ["show", unitName, "--property=FragmentPath", "--value"]);
      const dropIns = runCommand("systemctl", ["show", unitName, "--property=DropInPaths", "--value"]);
      const installedPath = `/etc/systemd/system/${unitName}`;
      return fragment.status === 0 && fragment.stdout.trim() === installedPath &&
        dropIns.status === 0 && dropIns.stdout.trim() === "" &&
        Buffer.from(readFile(installedPath)).equals(Buffer.from(readFile(resolve(bundleRoot, "deploy/systemd", unitName))));
    });
  } catch {
    return false;
  }
}
