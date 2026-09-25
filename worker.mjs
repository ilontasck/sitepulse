import { safeErrorCode } from "./src/audit/audit-failure-classifier.mjs";
import { randomUUID } from "node:crypto";
import { createAuditJobWorker } from "./src/audit/audit-job-worker.mjs";
import { createRenderedAuditLimiter } from "./src/audit/rendered-audit-limiter.mjs";
import { loadConfig } from "./src/config/env.mjs";
import { createSqliteReadinessCheck } from "./src/health/sqlite-readiness.mjs";
import { createWorkerHealthServer } from "./src/health/worker-health-server.mjs";
import { createAuditJobStore } from "./src/storage/audit-job-store.mjs";
import { runMigrations } from "./src/storage/migrations.mjs";
import { createAuditTelemetry } from "./src/telemetry/audit-telemetry.mjs";
import { resolveWorkerAuditExecution } from "./src/production/worker-audit-execution.mjs";

const workerId = randomUUID();
let telemetry = createAuditTelemetry();
async function main() {
  const config = loadConfig();
  telemetry = createAuditTelemetry({ enabled: config.telemetryEnabled });
  telemetry.record("worker.started", { worker: workerId });
  if (!config.migrationsManagedExternally) {
    runMigrations(config.databaseFilePath);
  }

  const jobStore = createAuditJobStore(config.databaseFilePath, {
    auditEmailNotificationsEnabled:config.auditEmailNotificationsEnabled,
    emailOutboxMaxAttempts:config.emailOutboxMaxAttempts,
    onRecovered({ failed, requeued }) {
      for (const [jobs, event] of [[failed, "audit.failed"], [requeued, "audit.retry_scheduled"]]) {
        for (const job of jobs) telemetry.record(event, { worker: workerId, jobId: job.id, requestId: job.request_id,
          attempt: job.attempt_count, phase: "recover", errorCode: "WORKER_LEASE_EXPIRED",
          durationMs: Math.max(0, Date.now() - Date.parse(job.created_at)),
          auditMode: config.renderedAuditEnabled ? "rendered" : "basic", outcome: event === "audit.failed" ? "failed" : "queued" });
      }
    }
  });
  const auditExecution = await resolveWorkerAuditExecution(config);
  const worker = createAuditJobWorker({
    jobStore,
    auditGenerator: auditExecution.auditGenerator,
    executorReadiness: auditExecution.executorReadiness,
    ...(auditExecution.securityValidator ? { securityValidator: auditExecution.securityValidator } : {}),
    renderedAuditLimiter: createRenderedAuditLimiter(1),
    telemetry,
    workerId,
    leaseMs: config.auditJobLeaseMs,
    heartbeatMs: config.auditJobHeartbeatMs,
    pollIntervalMs: config.auditWorkerPollIntervalMs,
    auditOptions: {
      renderedAuditEnabled: config.renderedAuditEnabled,
      renderedAuditTimeoutMs: config.renderedAuditTimeoutMs
    }
  });
  const sqliteReadiness = createSqliteReadinessCheck(config.databaseFilePath);
  const workerReadinessCheck = async () => {
    const [database, executor] = await Promise.all([
      sqliteReadiness(),
      auditExecution.executorReadiness().catch(() => ({ ready: false }))
    ]);
    return { ready: database?.ready === true && executor?.ready === true };
  };
  const waitForInitialWorkerReadiness = async (timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    do {
      if ((await workerReadinessCheck())?.ready === true) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    return false;
  };
  const healthServer = createWorkerHealthServer({
    host: config.workerHealthHost,
    port: config.workerHealthPort,
    readinessCheck: workerReadinessCheck,
    workerSnapshot: worker.snapshot
  });

  let shutdownRequested = false;
  const requestShutdown = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    healthServer.markStopping();
    worker.stop();
  };

  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  try {
    await healthServer.start();
    if (!await waitForInitialWorkerReadiness()) {
      throw new Error("AUDIT_WORKER_INITIAL_READINESS_FAILED");
    }
    healthServer.markReady();
    telemetry.record("worker.ready", { worker: workerId, phase: "startup" });
    await worker.run();
  } catch {
    telemetry.record("worker.error", { worker: workerId, errorCode: "WORKER_FAILURE" });
    process.exitCode = 1;
  } finally {
    healthServer.markStopping();
    try {
      await healthServer.close();
    } catch {
      telemetry.record("worker.error", { worker: workerId, phase: "shutdown", errorCode: "WORKER_FAILURE" });
      process.exitCode = 1;
    }
    telemetry.record("worker.shutdown", { worker: workerId, outcome: process.exitCode ? "failure" : "success" });
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
  }

}
await main().catch((error) => {
  telemetry.record("worker.error", { worker: workerId, phase: "startup", errorCode: safeErrorCode(error, "WORKER_FAILURE") });
  process.exitCode = 1;
});
