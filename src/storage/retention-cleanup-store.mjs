import { withDatabase, withImmediateTransaction } from "./sqlite-database.mjs";

function isoTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Retention cleanup clock must return a valid date.");
  return date.toISOString();
}

function boundedLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Retention cleanup limit must be a positive integer.");
  return Math.min(value, 1_000);
}

export function createRetentionCleanupStore(databaseFilePath, options = {}) {
  const clock = options.clock || (() => new Date());

  return {
    cleanup({ limit = 100 } = {}) {
      const now = isoTime(clock());
      const operationLogCutoff = new Date(new Date(now).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const batchSize = boundedLimit(limit);
      return withDatabase(databaseFilePath, (database) => withImmediateTransaction(database, () => {
        const reportIds = database.prepare(`
          SELECT id FROM audits
          WHERE deleted_at IS NOT NULL OR expires_at <= ?
          ORDER BY COALESCE(deleted_at, expires_at), id
          LIMIT ?
        `).all(now, batchSize).map(({ id }) => id);
        const deleteJobsForReport = database.prepare("DELETE FROM audit_jobs WHERE audit_id = ?");
        const deleteReport = database.prepare("DELETE FROM audits WHERE id = ?");
        for (const id of reportIds) {
          deleteJobsForReport.run(id);
          deleteReport.run(id);
        }

        const pendingJobIds = database.prepare(`
          SELECT audit_jobs.id
          FROM audit_jobs
          INNER JOIN users ON users.id = audit_jobs.user_id
          WHERE users.deletion_requested_at IS NOT NULL
            AND audit_jobs.status IN ('queued', 'running')
          ORDER BY audit_jobs.created_at, audit_jobs.id
          LIMIT ?
        `).all(batchSize).map(({ id }) => id);
        const deleteJob = database.prepare("DELETE FROM audit_jobs WHERE id = ?");
        for (const id of pendingJobIds) deleteJob.run(id);

        const accountIds = database.prepare(`
          SELECT id FROM users
          WHERE deletion_requested_at IS NOT NULL AND purge_after <= ?
          ORDER BY purge_after, id
          LIMIT ?
        `).all(now, batchSize).map(({ id }) => id);
        const deleteUserJobs = database.prepare("DELETE FROM audit_jobs WHERE user_id = ?");
        const deleteUserReports = database.prepare("DELETE FROM audits WHERE user_id = ?");
        const deleteUser = database.prepare("DELETE FROM users WHERE id = ?");
        for (const id of accountIds) {
          deleteUserJobs.run(id);
          deleteUserReports.run(id);
          deleteUser.run(id);
        }

        const operationIds = database.prepare(`
          SELECT id FROM admin_operation_log
          WHERE created_at < ? ORDER BY created_at, id LIMIT ?
        `).all(operationLogCutoff, batchSize).map(({ id }) => id);
        const deleteOperation = database.prepare("DELETE FROM admin_operation_log WHERE id = ?");
        for (const id of operationIds) deleteOperation.run(id);

        const verificationIds=database.prepare(`SELECT id FROM email_verification_tokens WHERE expires_at<=? OR COALESCE(used_at,invalidated_at)<? ORDER BY expires_at,id LIMIT ?`).all(now,operationLogCutoff,batchSize).map(({id})=>id);
        const deleteVerification=database.prepare("DELETE FROM email_verification_tokens WHERE id=?");for(const id of verificationIds)deleteVerification.run(id);
        const outboxIds=database.prepare(`SELECT id FROM transactional_email_outbox WHERE COALESCE(delivered_at,dead_lettered_at,canceled_at)<? ORDER BY COALESCE(delivered_at,dead_lettered_at,canceled_at),id LIMIT ?`).all(operationLogCutoff,batchSize).map(({id})=>id);
        const deleteOutbox=database.prepare("DELETE FROM transactional_email_outbox WHERE id=?");for(const id of outboxIds)deleteOutbox.run(id);

        return { reports: reportIds.length, pendingJobs: pendingJobIds.length, accounts: accountIds.length, adminOperations: operationIds.length,emailVerificationTokens:verificationIds.length,emailOutbox:outboxIds.length };
      }));
    }
  };
}
