export const migration005AuditOwnership = {
  version: 5,
  name: "audit ownership",
  up(database) {
    database.exec(`
      ALTER TABLE audit_jobs
      ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;

      ALTER TABLE audits
      ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;

      CREATE INDEX idx_audit_jobs_user_created
        ON audit_jobs (user_id, created_at DESC, id DESC)
        WHERE user_id IS NOT NULL;

      CREATE INDEX idx_audits_user_created
        ON audits (user_id, created_at DESC, id DESC)
        WHERE user_id IS NOT NULL;
    `);
  }
};
