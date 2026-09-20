export const migration008RetentionDeletion = {
  version: 8,
  name: "retention and deletion foundation",
  up(database) {
    database.exec(`
      ALTER TABLE audits ADD COLUMN expires_at TEXT;
      ALTER TABLE audits ADD COLUMN deleted_at TEXT;
      ALTER TABLE users ADD COLUMN deletion_requested_at TEXT;
      ALTER TABLE users ADD COLUMN purge_after TEXT;

      UPDATE audits
      SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+30 days')
      WHERE expires_at IS NULL;

      CREATE INDEX idx_audits_active_expiry
        ON audits (expires_at, id)
        WHERE deleted_at IS NULL;

      CREATE INDEX idx_users_purge_after
        ON users (purge_after, id)
        WHERE deletion_requested_at IS NOT NULL;
    `);
  }
};
