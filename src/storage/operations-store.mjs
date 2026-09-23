import { randomUUID } from "node:crypto";
import { getPlanPolicy, getQuotaPeriod } from "../plans/plan-policy.mjs";
import { isCorrelationId } from "../telemetry/log-context.mjs";
import { queueMetrics } from "../telemetry/queue-metrics.mjs";
import { withDatabase, withImmediateTransaction } from "./sqlite-database.mjs";

export class OperationsCursorError extends Error {}
export class OperationsJobNotFoundError extends Error {}
export class JobNotRetryableError extends Error {}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Operations clock must be valid.");
  return date.toISOString();
}

function encodeCursor(kind, time, id) {
  return Buffer.from(JSON.stringify({ v: 1, kind, time, id })).toString("base64url");
}

function decodeCursor(value, kind) {
  if (value == null) return null;
  try {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (cursor?.v !== 1 || cursor.kind !== kind || typeof cursor.time !== "string" || !Number.isFinite(Date.parse(cursor.time)) || typeof cursor.id !== "string" || !cursor.id) throw new Error();
    return cursor;
  } catch {
    throw new OperationsCursorError("Invalid operations cursor.");
  }
}

function pageLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 50) throw new TypeError("Operations page limit must be 1-50.");
  return value;
}

function failedItem(row) {
  return { id: row.id, createdAt: row.created_at, failedAt: row.failed_at, attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts, errorCode: row.error_code || "AUDIT_FAILED", planCode: row.plan_code_snapshot,
    requestId: isCorrelationId(row.request_id) ? row.request_id : null };
}

function logItem(row) {
  return { createdAt: row.created_at, action: row.action, targetType: row.target_type, targetId: row.target_id,
    outcome: row.outcome, requestId: isCorrelationId(row.request_id) ? row.request_id : null };
}

export function createOperationsStore(databaseFilePath, options = {}) {
  const clock = options.clock || (() => new Date());
  const idGenerator = options.idGenerator || randomUUID;
  return {
    snapshot({ api }) {
      const nowDate = clock();
      const now = nowDate instanceof Date ? nowDate.getTime() : new Date(nowDate).getTime();
      const period = getQuotaPeriod(now);
      const operational = queueMetrics(databaseFilePath, { now, windowMs: api.windowMs || 900_000 });
      return withDatabase(databaseFilePath, (database) => {
        const users = database.prepare(`SELECT
          SUM(CASE WHEN disabled_at IS NULL AND deletion_requested_at IS NULL THEN 1 ELSE 0 END) active,
          SUM(CASE WHEN disabled_at IS NULL AND deletion_requested_at IS NULL AND plan_code='free' THEN 1 ELSE 0 END) free,
          SUM(CASE WHEN disabled_at IS NULL AND deletion_requested_at IS NULL AND plan_code='pro' THEN 1 ELSE 0 END) pro,
          SUM(CASE WHEN deletion_requested_at IS NOT NULL THEN 1 ELSE 0 END) deletion_pending,
          SUM(CASE WHEN disabled_at IS NOT NULL THEN 1 ELSE 0 END) disabled FROM users`).get();
        const freeLimit = getPlanPolicy("free").monthlyAuditLimit;
        const proLimit = getPlanPolicy("pro").monthlyAuditLimit;
        const quota = database.prepare(`SELECT COALESCE(SUM(m.used_count),0) total_used,
          COALESCE(SUM(CASE WHEN u.plan_code='free' THEN m.used_count ELSE 0 END),0) free_used,
          COALESCE(SUM(CASE WHEN u.plan_code='pro' THEN m.used_count ELSE 0 END),0) pro_used,
          COALESCE(SUM(CASE WHEN (u.plan_code='free' AND m.used_count>=?) OR (u.plan_code='pro' AND m.used_count>=?) THEN 1 ELSE 0 END),0) at_limit
          FROM audit_monthly_usage m JOIN users u ON u.id=m.user_id
          WHERE m.period_start=? AND u.disabled_at IS NULL AND u.deletion_requested_at IS NULL`).get(freeLimit, proLimit, period.startsAt);
        return { database: { reachable: true }, ...operational, api,
          users: { active: users.active || 0, free: users.free || 0, pro: users.pro || 0, deletionPending: users.deletion_pending || 0, disabled: users.disabled || 0 },
          quota: { periodStart: period.startsAt, resetsAt: period.resetsAt, totalUsed: quota.total_used, freeUsed: quota.free_used, proUsed: quota.pro_used, usersAtLimit: quota.at_limit } };
      });
    },

    listFailed({ limit = 20, cursor = null } = {}) {
      const take = pageLimit(limit); const after = decodeCursor(cursor, "failed");
      return withDatabase(databaseFilePath, (database) => {
        const rows = after ? database.prepare(`SELECT * FROM audit_jobs WHERE status='failed' AND (failed_at < ? OR (failed_at = ? AND id < ?)) ORDER BY failed_at DESC,id DESC LIMIT ?`).all(after.time,after.time,after.id,take+1)
          : database.prepare(`SELECT * FROM audit_jobs WHERE status='failed' ORDER BY failed_at DESC,id DESC LIMIT ?`).all(take+1);
        const hasMore = rows.length > take; const visible = rows.slice(0,take); const last = visible.at(-1);
        return { items: visible.map(failedItem), nextCursor: hasMore ? encodeCursor("failed",last.failed_at,last.id) : null };
      });
    },

    listAuditLog({ limit = 20, cursor = null } = {}) {
      const take = pageLimit(limit); const after = decodeCursor(cursor, "audit-log");
      return withDatabase(databaseFilePath, (database) => {
        const rows = after ? database.prepare(`SELECT * FROM admin_operation_log WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC,id DESC LIMIT ?`).all(after.time,after.time,after.id,take+1)
          : database.prepare(`SELECT * FROM admin_operation_log ORDER BY created_at DESC,id DESC LIMIT ?`).all(take+1);
        const hasMore=rows.length>take; const visible=rows.slice(0,take); const last=visible.at(-1);
        return { items:visible.map(logItem),nextCursor:hasMore?encodeCursor("audit-log",last.created_at,last.id):null };
      });
    },

    retryJob({ jobId, requestId = null }) {
      const now = iso(clock());
      return withDatabase(databaseFilePath, (database) => withImmediateTransaction(database, () => {
        const job = database.prepare(`SELECT j.*,u.id owner_id,u.disabled_at,u.deletion_requested_at FROM audit_jobs j LEFT JOIN users u ON u.id=j.user_id WHERE j.id=?`).get(jobId);
        if (!job) throw new OperationsJobNotFoundError("Operation job was not found.");
        if (job.status !== "failed" || job.audit_id !== null || (job.user_id !== null && (!job.owner_id || job.disabled_at !== null || job.deletion_requested_at !== null))) throw new JobNotRetryableError("Job is not retryable.");
        const result = database.prepare(`UPDATE audit_jobs SET status='queued',attempt_count=0,available_at=?,updated_at=?,worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,started_at=NULL,completed_at=NULL,failed_at=NULL,error_code=NULL,error_message=NULL WHERE id=? AND status='failed'`).run(now,now,jobId);
        if (result.changes !== 1) throw new JobNotRetryableError("Job is not retryable.");
        database.prepare(`INSERT INTO admin_operation_log (id,created_at,action,target_type,target_id,outcome,request_id) VALUES (?,?, 'job.retry','audit_job',?,'accepted',?)`).run(idGenerator(),now,jobId,isCorrelationId(requestId)?requestId:null);
        return { id:jobId,status:"queued" };
      }));
    }
  };
}
