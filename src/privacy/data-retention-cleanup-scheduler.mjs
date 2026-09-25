const DEFAULT_INTERVAL_MS = 21_600_000;
const DEFAULT_BATCH_SIZE = 100;

function positiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

export function startDataRetentionCleanupScheduler({
  cleanupStore,
  telemetry,
  intervalMs = DEFAULT_INTERVAL_MS,
  batchSize = DEFAULT_BATCH_SIZE,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
}) {
  if (!cleanupStore || typeof cleanupStore.cleanup !== "function") {
    throw new TypeError("cleanupStore.cleanup is required.");
  }
  positiveInteger("intervalMs", intervalMs);
  positiveInteger("batchSize", batchSize);
  let stopped = false;
  let running = false;

  async function runCleanup() {
    if (stopped || running) return false;
    running = true;
    try {
      await cleanupStore.cleanup({ limit: batchSize });
    } catch {
      try {
        telemetry?.record("data_retention_cleanup_failed", {
          outcome: "failure", reason: "storage_error", errorCode: "DB_FAILURE"
        });
      } catch {
        // Cleanup telemetry must not affect the application lifecycle.
      }
    } finally {
      running = false;
    }
    return true;
  }

  void runCleanup();
  const timer = setIntervalFn(() => void runCleanup(), intervalMs);
  timer?.unref?.();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
    }
  };
}
