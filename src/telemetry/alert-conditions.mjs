export const alertThresholds = Object.freeze({
  queued: 20, oldestQueuedAgeMs: 120_000, failureRate: 0.25, minFinishedJobs: 5,
  apiLatencyAvgMs: 2_000, apiErrorRate: 0.1, minApiRequests: 10, dbErrors: 3, workerStarts: 4
});

export function evaluateAlerts({ operations, apiReady, workerReady, journal }, thresholds = alertThresholds) {
  const alerts = [];
  if (!apiReady) alerts.push("API_UNAVAILABLE");
  if (!workerReady) alerts.push("WORKER_UNAVAILABLE");
  if (!operations) alerts.push("OPERATIONS_UNAVAILABLE");
  if (!journal) alerts.push("JOURNAL_UNAVAILABLE");
  if (operations) {
    if (operations.queue.queued > thresholds.queued) alerts.push("QUEUE_BACKLOG");
    if (operations.queue.oldestQueuedAgeMs > thresholds.oldestQueuedAgeMs) alerts.push("QUEUE_TOO_OLD");
    const total = operations.recent.completed + operations.recent.failed;
    if (total >= thresholds.minFinishedJobs && operations.recent.failureRate >= thresholds.failureRate) alerts.push("AUDIT_FAILURE_RATE");
    if (operations.api.requests >= thresholds.minApiRequests && operations.api.latencyAvgMs > thresholds.apiLatencyAvgMs) alerts.push("API_LATENCY");
    if (operations.api.requests >= thresholds.minApiRequests && operations.api.errors / operations.api.requests >= thresholds.apiErrorRate) alerts.push("API_ERROR_RATE");
  }
  if (Math.max(journal?.dbErrors || 0, operations?.api.dbErrors || 0) >= thresholds.dbErrors) alerts.push("REPEATED_DB_ERRORS");
  if (Math.max(journal?.workerStarts || 0, journal?.workerStartupErrors || 0) >= thresholds.workerStarts) alerts.push("REPEATED_WORKER_RESTARTS");
  return alerts;
}

export function summarizeJournal(lines) {
  let dbErrors = 0;
  let workerStarts = 0;
  let workerStartupErrors = 0;
  for (const line of lines.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (entry.errorCode === "DB_FAILURE") dbErrors++;
      if (entry.event === "worker.started") workerStarts++;
      if (entry.event === "worker.error" && entry.phase === "startup") workerStartupErrors++;
    } catch { /* Other systemd/Node messages are not application events. */ }
  }
  return { dbErrors, workerStarts, workerStartupErrors };
}
