import { withDatabase } from "../storage/sqlite-database.mjs";

// Aggregate in SQLite; never materialize customer rows or URLs in the API.
export function queueMetrics(databaseFilePath, { now = Date.now(), windowMs = 900_000 } = {}) {
  const since = new Date(now - windowMs).toISOString();
  return withDatabase(databaseFilePath, (database) => {
    const queue = { queued: 0, running: 0, failed: 0, completed: 0 };
    for (const row of database.prepare("SELECT status, COUNT(*) AS count FROM audit_jobs GROUP BY status").all()) queue[row.status] = row.count;
    const oldest = database.prepare("SELECT MIN(created_at) AS oldest FROM audit_jobs WHERE status = 'queued'").get().oldest;
    const completed = database.prepare(`SELECT COUNT(*) AS count,
      AVG((julianday(completed_at) - julianday(created_at)) * 86400000) AS latency,
      MAX(completed_at) AS last FROM audit_jobs WHERE completed_at >= ?`).get(since);
    const failed = database.prepare("SELECT COUNT(*) AS count FROM audit_jobs WHERE failed_at >= ?").get(since).count;
    const total = completed.count + failed;
    return {
      windowMs, queue: { ...queue, oldestQueuedAgeMs: oldest ? Math.max(0, now - Date.parse(oldest)) : 0 },
      recent: { completed: completed.count, failed, failureRate: total ? failed / total : 0,
        completionLatencyAvgMs: completed.latency === null ? null : Math.max(0, Math.round(completed.latency)),
        lastCompletedAt: completed.last || null }
    };
  });
}

export function createApiMetrics({ now = Date.now, windowMs = 900_000 } = {}) {
  // Fixed number of minute buckets bounds memory even during traffic spikes.
  const buckets = new Map();
  const prune = () => { for (const key of buckets.keys()) if (key < Math.floor((now() - windowMs) / 60_000)) buckets.delete(key); };
  return {
    record({ statusCode, durationMs, errorCode }) {
      prune();
      const key = Math.floor(now() / 60_000);
      const bucket = buckets.get(key) || { requests: 0, errors: 0, dbErrors: 0, durationMs: 0, maxMs: 0 };
      bucket.requests++; bucket.errors += statusCode >= 500 ? 1 : 0;
      bucket.dbErrors += errorCode === "DB_FAILURE" ? 1 : 0;
      bucket.durationMs += durationMs; bucket.maxMs = Math.max(bucket.maxMs, durationMs);
      buckets.set(key, bucket);
    },
    snapshot() {
      prune();
      const sum = { requests: 0, errors: 0, dbErrors: 0, durationMs: 0, maxMs: 0 };
      for (const bucket of buckets.values()) {
        for (const key of ["requests", "errors", "dbErrors", "durationMs"]) sum[key] += bucket[key];
        sum.maxMs = Math.max(sum.maxMs, bucket.maxMs);
      }
      return { windowMs, requests: sum.requests, errors: sum.errors, dbErrors: sum.dbErrors,
        latencyAvgMs: sum.requests ? Math.round(sum.durationMs / sum.requests) : null, latencyMaxMs: sum.maxMs };
    }
  };
}
