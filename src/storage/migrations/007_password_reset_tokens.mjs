export const migration007PasswordResetTokens = {
  version: 7,
  name: "password_reset_tokens",
  up(database) {
    database.exec(`
      CREATE TABLE password_reset_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash BLOB NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        invalidated_at TEXT,
        CHECK (length(token_hash) = 32),
        CHECK (expires_at > created_at),
        CHECK (used_at IS NULL OR used_at >= created_at),
        CHECK (invalidated_at IS NULL OR invalidated_at >= created_at),
        CHECK (used_at IS NULL OR invalidated_at IS NULL)
      );

      CREATE UNIQUE INDEX idx_password_reset_tokens_hash
        ON password_reset_tokens (token_hash);

      CREATE INDEX idx_password_reset_tokens_user_pending
        ON password_reset_tokens (user_id, expires_at)
        WHERE used_at IS NULL AND invalidated_at IS NULL;

      CREATE INDEX idx_password_reset_tokens_expiry
        ON password_reset_tokens (expires_at);
    `);
  }
};
