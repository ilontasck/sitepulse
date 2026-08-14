export const migration004Sessions = {
  version: 4,
  name: "sessions",
  up(database) {
    database.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash BLOB NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        CHECK (length(token_hash) = 32),
        CHECK (expires_at > created_at),
        CHECK (revoked_at IS NULL OR revoked_at >= created_at)
      );

      CREATE UNIQUE INDEX idx_sessions_token_hash
        ON sessions (token_hash);

      CREATE INDEX idx_sessions_user_id
        ON sessions (user_id);

      CREATE INDEX idx_sessions_active_expiry
        ON sessions (expires_at)
        WHERE revoked_at IS NULL;
    `);
  }
};
