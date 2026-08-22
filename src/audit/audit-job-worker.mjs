import { classifyAuditFailure } from "./audit-failure-classifier.mjs";
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

    const recovery = jobStore.recoverExpired();
    let executorReady = false;
    try {
      executorReady = (await executorReadiness())?.ready === true;
    } catch {
      executorReady = false;
    }
    if (!executorReady) {
      telemetry?.record("audit_executor_unavailable", { outcome: "not-ready", reason: "readiness-check" });
      return { status: "executor-unavailable", recovery };
    }
    const job = jobStore.claimNext({ workerId, leaseMs });

    if (!job) {
      return { status: "idle", recovery };
    }

    activeJob = true;
    telemetry?.record("audit_job_claimed", { outcome: "running", attempt: job.attemptCount });
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
      const audit = await auditGenerator(job.normalizedUrl, {
        ...auditOptions,
        renderedAuditLimiter,
        telemetry
      });
      await stopHeartbeat();

      if (heartbeat.lost()) {
        return { status: "ownership-lost", jobId: job.id };
      }

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

      telemetry?.record("audit_job_completed", { outcome: "success", attempt: job.attemptCount });
      return { status: "completed", jobId: job.id, auditId: completion.job.auditId };
    } catch (error) {
      await stopHeartbeat();

      if (heartbeat.lost()) {
        return { status: "ownership-lost", jobId: job.id };
      }

      const failure = failureClassifier(error, { phase: "worker" });
      const transition = jobStore.handleFailure({
        jobId: job.id,
        workerId,
        leaseToken: job.leaseToken,
        failure
      });

      if (!transition?.transitioned) {
        telemetry?.record("audit_job_ownership_lost", { outcome: "failure", reason: "failure-transition-rejected" });
        return { status: "ownership-lost", jobId: job.id };
      }

      telemetry?.record(
        transition.job.status === "queued" ? "audit_job_retry_scheduled" : "audit_job_failed",
        { outcome: transition.job.status, reason: failure.code, attempt: job.attemptCount }
      );
      return { status: transition.job.status, jobId: job.id, failure };
    } finally {
      await stopHeartbeat();
      activeJob = false;
    }
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
      return { stopping: stopRequested, activeJob };
    }
  };
}
