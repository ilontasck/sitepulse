import { isCorrelationId } from "../telemetry/log-context.mjs";
import { randomUUID } from "node:crypto";
import { createAuditRecord, insertAuditRecord } from "./audit-record.mjs";
import { withDatabase, withImmediateTransaction } from "./sqlite-database.mjs";
import { getPlanPolicy, getQuotaPeriod, reportExpiryForPlan } from "../plans/plan-policy.mjs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function toIsoTime(value) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new TypeError("Audit job clock must return a valid date or ISO timestamp.");
  }

  return date.toISOString();
}

function addMilliseconds(timestamp, milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new TypeError("leaseMs must be a positive integer.");
  }

  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
}

function toJob(row) {
  if (!row) return null;

  return {
    id: row.id,
    requestId: row.request_id || null,
    status: row.status,
    normalizedUrl: row.normalized_url,
    userId: row.user_id,
    auditId: row.audit_id,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    leaseExpiresAt: row.lease_expires_at,
    workerId: row.worker_id,
    leaseToken: row.lease_token,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at
  };
}

function requireUserId(userId) {
  if (typeof userId !== "string" || !uuidPattern.test(userId)) {
    throw new TypeError("userId must be a valid UUID.");
  }
  return userId;
}

function validateFailure(failure) {
  if (!failure || !["retry", "fail"].includes(failure.disposition)) {
    throw new TypeError("Audit job failure disposition must be retry or fail.");
  }

  if (typeof failure.code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code)) {
    throw new TypeError("Audit job failure code must be a safe stable code.");
  }

  if (typeof failure.message !== "string" || failure.message.length < 1 || failure.message.length > 500) {
    throw new TypeError("Audit job failure message must contain 1-500 characters.");
  }

  return failure;
}

export class AuditQuotaExceededError extends Error {
  constructor(quota) {
    super("The monthly audit quota has been used.");
    this.name = "AuditQuotaExceededError";
    this.quota = quota;
  }
}

function quotaSnapshot(planCode, used, period, renderedAuditEnabled = false) {
  const policy = getPlanPolicy(planCode);
  return {
    plan: planCode,
    quota: {
      limit: policy.monthlyAuditLimit,
      used,
      remaining: Math.max(0, policy.monthlyAuditLimit - used),
      periodStart: period.startsAt,
      resetsAt: period.resetsAt
    },
    features: {
      renderedEligible: policy.renderedAuditEligible,
      renderedAvailable: policy.renderedAuditEligible && renderedAuditEnabled,
      retention: policy.retention
    }
  };
}

function refundQuota(database, row) {
  if (!row?.quota_charged || !row.quota_period_start || !row.user_id) return;
  const cleared = database.prepare(`
    UPDATE audit_jobs SET quota_charged = 0
    WHERE id = ? AND quota_charged = 1
  `).run(row.id);
  if (cleared.changes === 1) {
    database.prepare(`
      UPDATE audit_monthly_usage SET used_count = MAX(used_count - 1, 0)
      WHERE user_id = ? AND period_start = ?
    `).run(row.user_id, row.quota_period_start);
  }
}

export function createAuditJobStore(databaseFilePath, options = {}) {
  const clock = options.clock || (() => new Date());
  const idGenerator = options.idGenerator || randomUUID;
  const leaseTokenGenerator = options.leaseTokenGenerator || randomUUID;

  return {
    enqueue({ normalizedUrl, userId, requestId = null, renderedAuditEnabled = false }) {
      const now = toIsoTime(clock());
      const id = idGenerator();
      const ownerId = requireUserId(userId);

      return withDatabase(databaseFilePath, (database) => withImmediateTransaction(database, () => {
        const user = database.prepare(`
          SELECT plan_code FROM users
          WHERE id = ? AND disabled_at IS NULL AND deletion_requested_at IS NULL
        `).get(ownerId);
        if (!user) throw new Error("Audit owner is unavailable.");
        const period = getQuotaPeriod(now);
        const policy = getPlanPolicy(user.plan_code);
        database.prepare(`
          INSERT INTO audit_monthly_usage (user_id, period_start, used_count)
          VALUES (?, ?, 0)
          ON CONFLICT (user_id, period_start) DO NOTHING
        `).run(ownerId, period.startsAt);
        const usage = database.prepare(`
          UPDATE audit_monthly_usage SET used_count = used_count + 1
          WHERE user_id = ? AND period_start = ? AND used_count < ?
          RETURNING used_count
        `).get(ownerId, period.startsAt, policy.monthlyAuditLimit);
        if (!usage) {
          const used = database.prepare(`
            SELECT used_count FROM audit_monthly_usage WHERE user_id = ? AND period_start = ?
          `).get(ownerId, period.startsAt).used_count;
          throw new AuditQuotaExceededError(quotaSnapshot(user.plan_code, used, period, renderedAuditEnabled));
        }
        database.prepare(`
          INSERT INTO audit_jobs (
            id, status, normalized_url, attempt_count, max_attempts,
            available_at, created_at, updated_at, user_id, request_id,
            plan_code_snapshot, quota_period_start, quota_charged
          ) VALUES (?, 'queued', ?, 0, 2, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(id, normalizedUrl, now, now, now, ownerId, isCorrelationId(requestId) ? requestId : null,
          user.plan_code, period.startsAt);

        return toJob(database.prepare("SELECT * FROM audit_jobs WHERE id = ?").get(id));
      }));
    },

    quotaForUser(userId, { renderedAuditEnabled = false } = {}) {
      const ownerId = requireUserId(userId);
      const now = toIsoTime(clock());
      const period = getQuotaPeriod(now);
      return withDatabase(databaseFilePath, (database) => {
        const user = database.prepare(`
          SELECT plan_code FROM users
          WHERE id = ? AND disabled_at IS NULL AND deletion_requested_at IS NULL
        `).get(ownerId);
        if (!user) return null;
        const used = database.prepare(`
          SELECT used_count FROM audit_monthly_usage WHERE user_id = ? AND period_start = ?
        `).get(ownerId, period.startsAt)?.used_count || 0;
        return quotaSnapshot(user.plan_code, used, period, renderedAuditEnabled);
      });
    },

    findById(jobId) {
      return withDatabase(databaseFilePath, (database) =>
        toJob(database.prepare("SELECT * FROM audit_jobs WHERE id = ? LIMIT 1").get(jobId))
      );
    },

    findByIdForUser(jobId, userId) {
      const now = toIsoTime(clock());
      return withDatabase(databaseFilePath, (database) =>
        toJob(database.prepare(`
          SELECT audit_jobs.*
          FROM audit_jobs
          INNER JOIN users ON users.id = audit_jobs.user_id
          LEFT JOIN audits ON audits.id = audit_jobs.audit_id
          WHERE audit_jobs.id = ? AND audit_jobs.user_id = ?
            AND users.disabled_at IS NULL
            AND users.deletion_requested_at IS NULL
            AND (
              audit_jobs.audit_id IS NULL
              OR (audits.deleted_at IS NULL AND audits.expires_at > ?)
            )
          LIMIT 1
        `).get(jobId, userId, now))
      );
    },

    claimNext({ workerId, leaseMs }) {
      const now = toIsoTime(clock());
      const leaseToken = leaseTokenGenerator();
      const leaseExpiresAt = addMilliseconds(now, leaseMs);

      return withDatabase(databaseFilePath, (database) =>
        withImmediateTransaction(database, () => {
          const row = database.prepare(`
            UPDATE audit_jobs
            SET status = 'running',
                attempt_count = attempt_count + 1,
                worker_id = ?,
                lease_token = ?,
                lease_expires_at = ?,
                started_at = COALESCE(started_at, ?),
                updated_at = ?,
                error_code = NULL,
                error_message = NULL
            WHERE id = (
              SELECT audit_jobs.id
              FROM audit_jobs
              LEFT JOIN users ON users.id = audit_jobs.user_id
              WHERE audit_jobs.status = 'queued'
                AND audit_jobs.available_at <= ?
                AND audit_jobs.attempt_count < audit_jobs.max_attempts
                AND (audit_jobs.user_id IS NULL OR (
                  users.disabled_at IS NULL AND users.deletion_requested_at IS NULL
                ))
              ORDER BY audit_jobs.created_at ASC, audit_jobs.id ASC
              LIMIT 1
            )
              AND status = 'queued'
            RETURNING *
          `).get(workerId, leaseToken, leaseExpiresAt, now, now, now);

          return toJob(row);
        })
      );
    },

    renewLease({ jobId, workerId, leaseToken, leaseMs }) {
      const now = toIsoTime(clock());
      const leaseExpiresAt = addMilliseconds(now, leaseMs);

      return withDatabase(databaseFilePath, (database) => {
        const row = database.prepare(`
          UPDATE audit_jobs
          SET lease_expires_at = ?, updated_at = ?
          WHERE id = ?
            AND status = 'running'
            AND worker_id = ?
            AND lease_token = ?
            AND (audit_jobs.user_id IS NULL OR EXISTS (
              SELECT 1 FROM users
              WHERE users.id = audit_jobs.user_id
                AND users.disabled_at IS NULL
                AND users.deletion_requested_at IS NULL
            ))
          RETURNING *
        `).get(leaseExpiresAt, now, jobId, workerId, leaseToken);

        return row ? { renewed: true, job: toJob(row) } : { renewed: false, job: null };
      });
    },

    complete({ jobId, workerId, leaseToken, audit }) {
      const now = toIsoTime(clock());

      return withDatabase(databaseFilePath, (database) =>
        withImmediateTransaction(database, () => {
          const ownedJob = database.prepare(`
            SELECT audit_jobs.id, audit_jobs.user_id, audit_jobs.plan_code_snapshot,
                   users.disabled_at, users.deletion_requested_at
            FROM audit_jobs
            LEFT JOIN users ON users.id = audit_jobs.user_id
            WHERE audit_jobs.id = ?
              AND audit_jobs.status = 'running'
              AND audit_jobs.worker_id = ?
              AND audit_jobs.lease_token = ?
          `).get(jobId, workerId, leaseToken);

          if (!ownedJob) {
            return { completed: false, job: null, audit: null };
          }
          if (ownedJob.user_id && (ownedJob.disabled_at || ownedJob.deletion_requested_at)) {
            database.prepare("DELETE FROM audit_jobs WHERE id = ?").run(jobId);
            return { completed: false, job: null, audit: null };
          }

          const auditRecord = createAuditRecord(audit, { id: idGenerator(), now });
          const expiresAt = reportExpiryForPlan(ownedJob.plan_code_snapshot, now);
          insertAuditRecord(database, auditRecord, { userId: ownedJob.user_id, expiresAt });
          const completedJob = database.prepare(`
            UPDATE audit_jobs
            SET status = 'completed',
                audit_id = ?,
                completed_at = ?,
                updated_at = ?,
                worker_id = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                error_code = NULL,
                error_message = NULL
            WHERE id = ?
              AND status = 'running'
              AND worker_id = ?
              AND lease_token = ?
            RETURNING *
          `).get(auditRecord.id, now, now, jobId, workerId, leaseToken);

          if (!completedJob) {
            throw new Error("Audit job ownership was lost during completion.");
          }

          return { completed: true, job: toJob(completedJob), audit: auditRecord };
        })
      );
    },

    handleFailure({ jobId, workerId, leaseToken, failure }) {
      const safeFailure = validateFailure(failure);
      const now = toIsoTime(clock());

      return withDatabase(databaseFilePath, (database) =>
        withImmediateTransaction(database, () => {
          const ownedJob = database.prepare(`
            SELECT audit_jobs.attempt_count, audit_jobs.max_attempts, audit_jobs.user_id,
                   users.disabled_at, users.deletion_requested_at
            FROM audit_jobs
            LEFT JOIN users ON users.id = audit_jobs.user_id
            WHERE audit_jobs.id = ?
              AND audit_jobs.status = 'running'
              AND audit_jobs.worker_id = ?
              AND audit_jobs.lease_token = ?
          `).get(jobId, workerId, leaseToken);

          if (!ownedJob) {
            return { transitioned: false, job: null };
          }
          if (ownedJob.user_id && (ownedJob.disabled_at || ownedJob.deletion_requested_at)) {
            database.prepare("DELETE FROM audit_jobs WHERE id = ?").run(jobId);
            return { transitioned: false, job: null };
          }

          const shouldRetry = safeFailure.disposition === "retry" && ownedJob.attempt_count < ownedJob.max_attempts;
          const row = shouldRetry
            ? database.prepare(`
                UPDATE audit_jobs
                SET status = 'queued',
                    available_at = ?,
                    updated_at = ?,
                    worker_id = NULL,
                    lease_token = NULL,
                    lease_expires_at = NULL,
                    error_code = ?,
                    error_message = ?,
                    failed_at = NULL
                WHERE id = ?
                  AND status = 'running'
                  AND worker_id = ?
                  AND lease_token = ?
                RETURNING *
              `).get(now, now, safeFailure.code, safeFailure.message, jobId, workerId, leaseToken)
            : database.prepare(`
                UPDATE audit_jobs
                SET status = 'failed',
                    failed_at = ?,
                    updated_at = ?,
                    worker_id = NULL,
                    lease_token = NULL,
                    lease_expires_at = NULL,
                    error_code = ?,
                    error_message = ?
                WHERE id = ?
                  AND status = 'running'
                  AND worker_id = ?
                  AND lease_token = ?
                RETURNING *
              `).get(now, now, safeFailure.code, safeFailure.message, jobId, workerId, leaseToken);

          if (!row) {
            throw new Error("Audit job ownership was lost during failure handling.");
          }

          if (!shouldRetry) refundQuota(database, row);

          return { transitioned: true, job: toJob(row) };
        })
      );
    },

    recoverExpired() {
      const now = toIsoTime(clock());

      const recovered = withDatabase(databaseFilePath, (database) =>
        withImmediateTransaction(database, () => {
          database.prepare(`
            DELETE FROM audit_jobs
            WHERE status = 'running'
              AND EXISTS (
                SELECT 1 FROM users
                WHERE users.id = audit_jobs.user_id
                  AND (users.disabled_at IS NOT NULL OR users.deletion_requested_at IS NOT NULL)
              )
          `).run();
          const failed = database.prepare(`
            UPDATE audit_jobs
            SET status = 'failed',
                failed_at = ?,
                updated_at = ?,
                worker_id = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                error_code = 'WORKER_LEASE_EXPIRED',
                error_message = 'The audit worker stopped before completing the job.'
            WHERE status = 'running'
              AND lease_expires_at <= ?
              AND attempt_count >= max_attempts
              AND (audit_jobs.user_id IS NULL OR EXISTS (
                SELECT 1 FROM users
                WHERE users.id = audit_jobs.user_id
                  AND users.disabled_at IS NULL
                  AND users.deletion_requested_at IS NULL
              ))
            RETURNING id, request_id, attempt_count, created_at, user_id, quota_period_start, quota_charged
          `).all(now, now, now);
          for (const row of failed) refundQuota(database, row);
          const requeued = database.prepare(`
            UPDATE audit_jobs
            SET status = 'queued',
                available_at = ?,
                updated_at = ?,
                worker_id = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                error_code = 'WORKER_LEASE_EXPIRED',
                error_message = 'The audit worker stopped before completing the job.',
                failed_at = NULL
            WHERE status = 'running'
              AND lease_expires_at <= ?
              AND attempt_count < max_attempts
              AND (audit_jobs.user_id IS NULL OR EXISTS (
                SELECT 1 FROM users
                WHERE users.id = audit_jobs.user_id
                  AND users.disabled_at IS NULL
                  AND users.deletion_requested_at IS NULL
              ))
            RETURNING id, request_id, attempt_count, created_at
          `).all(now, now, now);

          return { failed, requeued };
        })
      );
      try { options.onRecovered?.(recovered); } catch { /* Committed recovery must survive telemetry failures. */ }
      return { failed: recovered.failed.length, requeued: recovered.requeued.length };
    }
  };
}
