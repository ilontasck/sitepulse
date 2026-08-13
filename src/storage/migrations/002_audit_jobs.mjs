export const migration002AuditJobs = {
  version: 2,
  name: "audit jobs",
  up(database) {
    database.exec(`
      CREATE TABLE audit_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL
          CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        normalized_url TEXT NOT NULL,
        audit_id TEXT REFERENCES audits(id),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts = 2),
        available_at TEXT NOT NULL,
        lease_expires_at TEXT,
        worker_id TEXT,
        lease_token TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        failed_at TEXT,
        CHECK (
          (status = 'queued' AND audit_id IS NULL AND worker_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
          OR
          (status = 'running' AND audit_id IS NULL AND worker_id IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
          OR
          (status = 'completed' AND audit_id IS NOT NULL AND completed_at IS NOT NULL)
          OR
          (status = 'failed' AND audit_id IS NULL AND failed_at IS NOT NULL)
        )
      );

      CREATE INDEX idx_audit_jobs_claim
        ON audit_jobs (status, available_at, created_at);

      CREATE INDEX idx_audit_jobs_expired_lease
        ON audit_jobs (status, lease_expires_at);

      CREATE UNIQUE INDEX idx_audit_jobs_audit_id
        ON audit_jobs (audit_id)
        WHERE audit_id IS NOT NULL;
    `);
  }
};
