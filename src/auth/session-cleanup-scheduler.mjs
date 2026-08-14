const DEFAULT_INTERVAL_MS = 3_600_000;
const DEFAULT_REVOKED_RETENTION_MS = 86_400_000;
const DEFAULT_BATCH_SIZE = 100;

function requirePositiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function recordCleanupFailure(telemetry) {
  try {
    telemetry?.record("auth_session_cleanup_failed", {
      outcome: "failure",
      reason: "storage_error"
    });
  } catch {
    // Cleanup observability must never affect the web process lifecycle.
  }
}

export function startSessionCleanupScheduler({
  authStore,
  telemetry,
  clock = () => new Date(),
  intervalMs = DEFAULT_INTERVAL_MS,
  revokedRetentionMs = DEFAULT_REVOKED_RETENTION_MS,
  batchSize = DEFAULT_BATCH_SIZE,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
}) {
  if (!authStore || typeof authStore.cleanupSessions !== "function") {
    throw new TypeError("authStore.cleanupSessions is required.");
  }
  requirePositiveInteger("intervalMs", intervalMs);
  requirePositiveInteger("revokedRetentionMs", revokedRetentionMs);
  requirePositiveInteger("batchSize", batchSize);

  let stopped = false;
  let running = false;

  async function runCleanup() {
    if (stopped || running) {
      return false;
    }

    running = true;
    try {
      const now = clock();
      const currentTime = now instanceof Date ? now : new Date(now);
      if (Number.isNaN(currentTime.getTime())) {
        throw new TypeError("Session cleanup clock returned an invalid time.");
      }
      await authStore.cleanupSessions({
        expiredBefore: currentTime.toISOString(),
        revokedBefore: new Date(currentTime.getTime() - revokedRetentionMs).toISOString(),
        limit: batchSize
      });
    } catch {
      recordCleanupFailure(telemetry);
    } finally {
      running = false;
    }

    return true;
  }

  void runCleanup();
  const timer = setIntervalFn(() => {
    void runCleanup();
  }, intervalMs);
  timer?.unref?.();

  return {
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      clearIntervalFn(timer);
    }
  };
}
