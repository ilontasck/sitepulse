import { isCorrelationId } from "../telemetry/log-context.mjs";
import { randomUUID } from "node:crypto";
import { createAuditRecord, insertAuditRecord } from "./audit-record.mjs";
import { withDatabase, withImmediateTransaction } from "./sqlite-database.mjs";
import { FREE_REPORT_TTL_MS } from "./audit-store.mjs";

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

export function createAuditJobStore(databaseFilePath, options = {}) {
  const clock = options.clock || (() => new Date());
  const idGenerator = options.idGenerator || randomUUID;
  const leaseTokenGenerator = options.leaseTokenGenerator || randomUUID;
  const reportTtlMs = options.reportTtlMs ?? FREE_REPORT_TTL_MS;

  return {
    enqueue({ normalizedUrl, userId, requestId = null }) {
      const now = toIsoTime(clock());
      const id = idGenerator();
      const ownerId = requireUserId(userId);

      return withDatabase(databaseFilePath, (database) => {
        database.prepare(`
          INSERT INTO audit_jobs (
            id, status, normalized_url, attempt_count, max_attempts,
            available_at, created_at, updated_at, user_id, request_id
          ) VALUES (?, 'queued', ?, 0, 2, ?, ?, ?, ?, ?)
        `).run(id, normalizedUrl, now, now, now, ownerId, isCorrelationId(requestId) ? requestId : null);

        return toJob(database.prepare("SELECT * FROM audit_jobs WHERE id = ?").get(id));
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
            SELECT audit_jobs.id, audit_jobs.user_id, users.disabled_at, users.deletion_requested_at
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
          const expiresAt = new Date(new Date(now).getTime() + reportTtlMs).toISOString();
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
            RETURNING id, request_id, attempt_count, created_at
          `).all(now, now, now);
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
