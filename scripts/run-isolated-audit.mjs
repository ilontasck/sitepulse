import { createAuditRunnerClient } from "../src/audit/audit-runner-client.mjs";

const url = process.argv[2];
const renderedAuditEnabled = process.argv.includes("--rendered");
const timeoutArgument = process.argv.find((argument) => argument.startsWith("--client-timeout-ms="));
const requestTimeoutMs = timeoutArgument ? Number(timeoutArgument.split("=")[1]) : 90_000;
if (!url) {
  console.error("ISOLATED_AUDIT_URL_REQUIRED");
  process.exitCode = 2;
} else {
  try {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 120_000) throw new Error("invalid");
    const client = createAuditRunnerClient({ socketPath: "/run/noqori-audit.sock", requestTimeoutMs });
    const audit = await client.generateAudit(url, { renderedAuditEnabled, renderedAuditTimeoutMs: 45_000 });
    if (!audit || typeof audit !== "object") throw new Error("invalid");
    console.log(JSON.stringify({ status: "completed", mode: audit.scanner?.mode, renderedStatus: audit.scanner?.renderedStatus }));
  } catch (error) {
    console.error(error?.code === "AUDIT_RUNNER_TIMEOUT" ? "AUDIT_RUNNER_TIMEOUT" : "ISOLATED_AUDIT_FAILED");
    process.exitCode = 1;
  }
}
