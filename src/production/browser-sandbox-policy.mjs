import { createHash } from "node:crypto";

export const browserSandboxNamespacePath = "/run/netns/noqori-audit";
export const browserSandboxRuntimeDirectory = "/run/noqori-audit";
export const browserSandboxAttestationPath = `${browserSandboxRuntimeDirectory}/attestation.json`;
export const browserSandboxExpectedHashPath = `${browserSandboxRuntimeDirectory}/expected-config.sha256`;
export const browserSandboxKernelPolicyHashPath = `${browserSandboxRuntimeDirectory}/kernel-policy.sha256`;
export const browserSandboxBundleHashPath = `${browserSandboxRuntimeDirectory}/bundle.sha256`;
export const browserSandboxPlatformHashPath = `${browserSandboxRuntimeDirectory}/platform.sha256`;
export const browserSandboxAcceptanceTestPath = `${browserSandboxRuntimeDirectory}/acceptance-test.json`;
export const browserSandboxOwnershipPath = `${browserSandboxRuntimeDirectory}/resource-owner.json`;
export const browserSandboxAcceptancePath = "/etc/noqori/audit-vm-acceptance.json";
export const browserSandboxAcceptanceEvidencePath = "/var/lib/noqori/browser-sandbox-acceptance-result.json";
export const browserSandboxKernelEvidencePath = "/var/lib/noqori/browser-sandbox-kernel-result.json";

export function computeBrowserSandboxConfigHash(configText) {
  return createHash("sha256").update(Buffer.from(configText)).digest("hex");
}
