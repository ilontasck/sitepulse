import { generateAudit } from "../src/audit/audit-engine.mjs";
import { createAuditRunnerServer } from "../src/audit/audit-runner-server.mjs";
import { loadAuditRunnerAcceptance } from "../src/production/browser-sandbox-attestation.mjs";
import { computeBrowserSandboxBundleHash } from "../src/production/browser-sandbox-bundle.mjs";

const listenPid = Number(process.env.LISTEN_PID);
const listenFds = Number(process.env.LISTEN_FDS);
if (listenPid !== process.pid || listenFds !== 1) {
  console.error("AUDIT_RUNNER_SOCKET_ACTIVATION_REQUIRED");
  process.exitCode = 1;
} else {
  let acceptance = { valid: false };
  try {
    acceptance = loadAuditRunnerAcceptance({
      credentialsDirectory: process.env.CREDENTIALS_DIRECTORY,
      currentBundleHash: computeBrowserSandboxBundleHash()
    });
  } catch {
    acceptance = { valid: false };
  }
  if (!acceptance.valid) {
    console.error("AUDIT_RUNNER_ATTESTATION_INVALID");
    process.exitCode = 1;
  }
  const allowedEnvironment = new Set(["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "PLAYWRIGHT_BROWSERS_PATH"]);
  for (const key of Object.keys(process.env)) {
    if (!allowedEnvironment.has(key)) delete process.env[key];
  }
  process.env.NODE_ENV = "production";

  const server = createAuditRunnerServer({
    listenFd: 3,
    auditGenerator: generateAudit,
    renderedAuditAllowed: acceptance.renderedAuditAllowed === true
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await server.close();
    } catch {
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (acceptance.valid) {
    try {
      await server.start();
    } catch {
      console.error("AUDIT_RUNNER_START_FAILED");
      process.exitCode = 1;
    }
  }
}
