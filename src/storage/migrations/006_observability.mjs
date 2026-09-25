export const migration006Observability = {
  version: 6,
  name: "production observability",
  up(database) {
    database.exec(`
      ALTER TABLE audit_jobs ADD COLUMN request_id TEXT;
      CREATE INDEX idx_audit_jobs_completed_at ON audit_jobs(completed_at) WHERE completed_at IS NOT NULL;
      CREATE INDEX idx_audit_jobs_failed_at ON audit_jobs(failed_at) WHERE failed_at IS NOT NULL;
    `);
  }
};
