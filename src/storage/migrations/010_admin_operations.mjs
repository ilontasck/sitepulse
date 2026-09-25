export const migration010AdminOperations = {
  version: 10,
  name: "admin operations audit log",
  up(database) {
    database.exec(`
      CREATE TABLE admin_operation_log (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        request_id TEXT
      );

      CREATE INDEX idx_admin_operation_log_newest
        ON admin_operation_log (created_at DESC, id DESC);
      CREATE INDEX idx_audit_jobs_failed_newest
        ON audit_jobs (failed_at DESC, id DESC)
        WHERE status = 'failed';
    `);
  }
};
