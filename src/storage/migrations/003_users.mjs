export const migration003Users = {
  version: 3,
  name: "users",
  up(database) {
    database.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email_original TEXT NOT NULL,
        email_normalized TEXT NOT NULL COLLATE BINARY,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        disabled_at TEXT,
        CHECK (length(email_original) BETWEEN 3 AND 254),
        CHECK (length(email_normalized) BETWEEN 3 AND 254),
        CHECK (email_normalized = lower(email_normalized)),
        CHECK (length(password_hash) BETWEEN 64 AND 512)
      );

      CREATE UNIQUE INDEX idx_users_email_normalized
        ON users (email_normalized);
    `);
  }
};
