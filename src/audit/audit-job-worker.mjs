import { withLogContext } from "../telemetry/log-context.mjs";
import { classifyAuditFailure, safeErrorCode } from "./audit-failure-classifier.mjs";
import { assertSafeUrl } from "./url-safety.mjs";
import { normalizeWebsiteUrl } from "./url-validation.mjs";

async function validateQueuedUrl(normalizedUrl) {
  const target = normalizeWebsiteUrl(normalizedUrl);
  await assertSafeUrl(target.normalizedUrl);
  return target;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createAuditJobWorker(options) {
  const {
    jobStore,
    auditGenerator,
    executorReadiness = async () => ({ ready: true }),
    renderedAuditLimiter,
    telemetry,
    workerId,
    securityValidator = validateQueuedUrl,
    failureClassifier = classifyAuditFailure,
    leaseMs = 30_000,
    heartbeatMs = 10_000,
    pollIntervalMs = 500,
    auditOptions = {},
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    sleep = defaultSleep
  } = options || {};

  if (!jobStore || typeof jobStore.claimNext !== "function" || !workerId || typeof auditGenerator !== "function") {
    throw new TypeError("Audit job worker requires a job store, workerId, and audit generator.");
  }

  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs >= leaseMs) {
    throw new TypeError("Audit job heartbeat must be a positive integer shorter than the lease.");
  }

  let stopRequested = false;
  let activeJob = false;
  let executorAvailable;
  let lastJobAt = null;
  let lastPollAt = null;

  function startHeartbeat(job) {
    let ownershipLost = false;
    let renewalPromise = null;

    const renew = async () => {
      if (ownershipLost || renewalPromise) return;

      renewalPromise = Promise.resolve().then(() =>
        jobStore.renewLease({
          jobId: job.id,
          workerId,
          leaseToken: job.leaseToken,
          leaseMs
        })
      );

      try {
        const result = await renewalPromise;

        if (!result?.renewed) {
          ownershipLost = true;
          telemetry?.record("audit_job_ownership_lost", { outcome: "failure", reason: "lease-renewal-rejected" });
        }
      } catch {
        ownershipLost = true;
        telemetry?.record("worker.error", { phase: "heartbeat", errorCode: "DB_FAILURE" });
        telemetry?.record("audit_job_ownership_lost", { outcome: "failure", reason: "lease-renewal-error" });
      } finally {
        renewalPromise = null;
      }
    };

    const timer = setIntervalFn(renew, heartbeatMs);

    return {
      lost() {
        return ownershipLost;
      },
      async stop() {
        clearIntervalFn(timer);

        try {
          await renewalPromise;
        } catch {
          ownershipLost = true;
        }
      }
    };
  }

  async function runOnce() {
    if (stopRequested) return { status: "stopped" };

    lastPollAt = new Date().toISOString();
    let recovery;
    try { recovery = jobStore.recoverExpired(); }
    catch (error) {
      telemetry?.record("worker.error", { worker: workerId, phase: "recover", errorCode: safeErrorCode(error, "QUEUE_FAILURE") });
      throw error;
    }
    let executorReady = false;
    try {
      executorReady = (await executorReadiness())?.ready === true;
    } catch {
      executorReady = false;
    }
    if (executorAvailable !== executorReady) {
      telemetry?.record(executorReady ? "worker.ready" : "worker.error", { worker: workerId,
        phase: "readiness", outcome: executorReady ? "ready" : "not-ready",
        ...(executorReady ? {} : { errorCode: "AUDIT_RUNNER_UNAVAILABLE" }) });
      executorAvailable = executorReady;
    }
    if (!executorReady) {
      return { status: "executor-unavailable", recovery };
    }
    let job;
    try { job = jobStore.claimNext({ workerId, leaseMs }); }
    catch (error) {
      telemetry?.record("worker.error", { worker: workerId, phase: "claim", errorCode: safeErrorCode(error, "QUEUE_FAILURE") });
      throw error;
    }

    if (!job) {
      return { status: "idle", recovery };
    }

    activeJob = true;
    lastJobAt = new Date().toISOString();
    const started = performance.now();
    return withLogContext({ jobId: job.id, requestId: job.requestId, worker: workerId,
      auditMode: auditOptions.renderedAuditEnabled ? "rendered" : "basic", attempt: job.attemptCount }, async () => {
      telemetry?.record("worker.job_claimed", { outcome: "running", durationMs: 0 });
      telemetry?.record("audit.started", { outcome: "running", durationMs: 0,
        queueWaitMs: Math.max(0, Date.now() - Date.parse(job.createdAt)) });
      let phase = "preflight";
      const heartbeat = startHeartbeat(job);
      let heartbeatStopped = false;

      const stopHeartbeat = async () => {
        if (heartbeatStopped) return;
        heartbeatStopped = true;
        await heartbeat.stop();
      };

      try {
        await securityValidator(job.normalizedUrl);
        // Known v1 limitation: rendered failures converted by scanner-service into
        // a successful HTML fallback do not reach this worker failure classifier.
        phase = "generate";
        const audit = await auditGenerator(job.normalizedUrl, {
          ...auditOptions,
          renderedAuditLimiter,
          telemetry
        });
        await stopHeartbeat();

        if (heartbeat.lost()) {
          return { status: "ownership-lost", jobId: job.id };
        }

        phase = "persist";
        const completion = jobStore.complete({
          jobId: job.id,
          workerId,
          leaseToken: job.leaseToken,
          audit
        });

        if (!completion?.completed) {
          telemetry?.record("audit_job_ownership_lost", { outcome: "failure", reason: "completion-rejected" });
          return { status: "ownership-lost", jobId: job.id };
        }

        const fields = { outcome: "success", auditId: completion.job.auditId, durationMs: Math.round(performance.now() - started) };
        telemetry?.record("audit.completed", fields);
        telemetry?.record("worker.job_completed", fields);
        return { status: "completed", jobId: job.id, auditId: completion.job.auditId };
      } catch (error) {
        await stopHeartbeat();

        if (heartbeat.lost()) {
          return { status: "ownership-lost", jobId: job.id };
        }

        const failure = phase === "persist"
          ? { disposition: "retry", code: safeErrorCode(error, "DB_FAILURE"), message: "Audit storage is temporarily unavailable." }
          : failureClassifier(error, { phase: "worker" });
        const failureFields = { phase, errorCode: safeErrorCode({ code: failure.code }, "AUDIT_FAILED"), durationMs: Math.round(performance.now() - started), outcome: "failure" };
        telemetry?.record("worker.job_failed", failureFields);
        let transition;
        try { transition = jobStore.handleFailure({
          jobId: job.id,
          workerId,
          leaseToken: job.leaseToken,
          failure
        }); } catch (storageError) {
          telemetry?.record("worker.error", { phase: "failure-transition", errorCode: safeErrorCode(storageError, "DB_FAILURE") });
          throw storageError;
        }

        if (!transition?.transitioned) {
          telemetry?.record("audit_job_ownership_lost", { outcome: "failure", reason: "failure-transition-rejected" });
          return { status: "ownership-lost", jobId: job.id };
        }

        telemetry?.record(
          transition.job.status === "queued" ? "audit.retry_scheduled" : "audit.failed",
          { ...failureFields, outcome: transition.job.status }
        );
        return { status: transition.job.status, jobId: job.id, failure };
      } finally {
        await stopHeartbeat();
        activeJob = false;
      }
    });
  }

  async function run() {
    while (!stopRequested) {
      const result = await runOnce();

      if (new Set(["idle", "executor-unavailable"]).has(result.status) && !stopRequested) {
        await sleep(pollIntervalMs);
      }
    }

    return { status: "stopped" };
  }

  return {
    runOnce,
    run,
    stop() {
      stopRequested = true;
      return { stopping: true, activeJob };
    },
    snapshot() {
      return { stopping: stopRequested, activeJob, executorAvailable, lastJobAt, lastPollAt };
    }
  };
}
