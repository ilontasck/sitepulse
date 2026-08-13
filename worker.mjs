import { randomUUID } from "node:crypto";
import { createAuditJobWorker } from "./src/audit/audit-job-worker.mjs";
import { createRenderedAuditLimiter } from "./src/audit/rendered-audit-limiter.mjs";
import { loadConfig } from "./src/config/env.mjs";
import { createAuditJobStore } from "./src/storage/audit-job-store.mjs";
import { runMigrations } from "./src/storage/migrations.mjs";
import { createAuditTelemetry } from "./src/telemetry/audit-telemetry.mjs";

const config = loadConfig();
runMigrations(config.databaseFilePath);

const telemetry = createAuditTelemetry({ enabled: config.telemetryEnabled });
const worker = createAuditJobWorker({
  jobStore: createAuditJobStore(config.databaseFilePath),
  renderedAuditLimiter: createRenderedAuditLimiter(1),
  telemetry,
  workerId: randomUUID(),
  leaseMs: config.auditJobLeaseMs,
  heartbeatMs: config.auditJobHeartbeatMs,
  pollIntervalMs: config.auditWorkerPollIntervalMs,
  auditOptions: {
    renderedAuditEnabled: config.renderedAuditEnabled,
    renderedAuditTimeoutMs: config.renderedAuditTimeoutMs
  }
});

let shutdownRequested = false;
const requestShutdown = () => {
  if (shutdownRequested) return;
  shutdownRequested = true;
  worker.stop();
};

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

try {
  await worker.run();
} catch {
  telemetry.record("audit_worker_stopped", { outcome: "failure", reason: "worker-loop-error" });
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", requestShutdown);
  process.removeListener("SIGTERM", requestShutdown);
}
