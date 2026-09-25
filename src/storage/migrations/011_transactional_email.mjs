export const migration011TransactionalEmail = {
  version: 11,
  name: "transactional email",
  up(database) {
    database.exec(`
      ALTER TABLE users ADD COLUMN email_verified_at TEXT;
      UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

      CREATE TABLE email_verification_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash BLOB NOT NULL UNIQUE CHECK(length(token_hash)=32),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL CHECK(expires_at > created_at),
        used_at TEXT,
        invalidated_at TEXT,
        CHECK(used_at IS NULL OR used_at >= created_at),
        CHECK(invalidated_at IS NULL OR invalidated_at >= created_at),
        CHECK(used_at IS NULL OR invalidated_at IS NULL)
      );
      CREATE UNIQUE INDEX idx_email_verification_one_active
        ON email_verification_tokens(user_id) WHERE used_at IS NULL AND invalidated_at IS NULL;
      CREATE INDEX idx_email_verification_cleanup
        ON email_verification_tokens(expires_at, used_at, invalidated_at, id);

      CREATE TABLE transactional_email_outbox (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('audit_ready','audit_failed')),
        job_id TEXT NOT NULL REFERENCES audit_jobs(id) ON DELETE CASCADE,
        audit_id TEXT REFERENCES audits(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        available_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
        max_attempts INTEGER NOT NULL CHECK(max_attempts > 0),
        claimed_until TEXT,
        claim_token TEXT,
        delivered_at TEXT,
        dead_lettered_at TEXT,
        canceled_at TEXT,
        last_error_code TEXT,
        UNIQUE(kind, job_id),
        CHECK((claimed_until IS NULL) = (claim_token IS NULL)),
        CHECK(kind='audit_ready' OR audit_id IS NULL)
      );
      CREATE INDEX idx_transactional_email_pending
        ON transactional_email_outbox(available_at, created_at, id)
        WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND canceled_at IS NULL;
      CREATE INDEX idx_transactional_email_user ON transactional_email_outbox(user_id, created_at);
      CREATE INDEX idx_transactional_email_cleanup
        ON transactional_email_outbox(delivered_at, dead_lettered_at, canceled_at, id);
    `);
  }
};
