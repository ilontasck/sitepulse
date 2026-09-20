import { randomUUID } from "node:crypto";
import { withDatabase, withImmediateTransaction } from "./sqlite-database.mjs";

const sqliteConstraintCode = 19;

export class AuthStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthStoreError";
    this.code = code;
  }
}

function toUser(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    emailOriginal: row.email_original,
    emailNormalized: row.email_normalized,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at,
    deletionRequestedAt: row.deletion_requested_at,
    purgeAfter: row.purge_after
  };
}

function toSession(row) {
  return {
    id: row.session_id ?? row.id,
    userId: row.session_user_id ?? row.user_id,
    createdAt: row.session_created_at ?? row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at
  };
}

function requireTokenHash(value, name) {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw new TypeError(`${name} must be a 32-byte Buffer.`);
  }
  return value;
}

function requireTimestamp(value, name) {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be an ISO timestamp.`);
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${name} must be an ISO timestamp.`);
  }
  return value;
}

function isSqliteConstraint(error) {
  return Number.isInteger(error?.errcode) && (error.errcode & 0xff) === sqliteConstraintCode;
}

export function createAuthStore(databaseFilePath, options = {}) {
  const clock = options.clock || (() => new Date().toISOString());
  const idGenerator = options.idGenerator || (() => randomUUID());

  async function findUserByNormalizedEmail(emailNormalized) {
    if (typeof emailNormalized !== "string") {
      return null;
    }
    return withDatabase(databaseFilePath, (database) =>
      toUser(database.prepare(`
        SELECT
          id, email_original, email_normalized, password_hash,
          created_at, updated_at, disabled_at, deletion_requested_at, purge_after
        FROM users
        WHERE email_normalized = ?
        LIMIT 1
      `).get(emailNormalized))
    );
  }

  return {
    async findUserById(userId) {
      return withDatabase(databaseFilePath, (database) => toUser(database.prepare(`
        SELECT id, email_original, email_normalized, password_hash,
               created_at, updated_at, disabled_at, deletion_requested_at, purge_after
        FROM users WHERE id = ? LIMIT 1
      `).get(userId)));
    },

    async createUserWithSession({
      emailOriginal,
      emailNormalized,
      passwordHash,
      sessionTokenHash,
      sessionExpiresAt
    }) {
      requireTokenHash(sessionTokenHash, "sessionTokenHash");
      requireTimestamp(sessionExpiresAt, "sessionExpiresAt");
      const now = requireTimestamp(clock(), "clock");
      const userId = idGenerator("user");
      const sessionId = idGenerator("session");

      try {
        return withDatabase(databaseFilePath, (database) =>
          withImmediateTransaction(database, () => {
            database.prepare(`
              INSERT INTO users (
                id, email_original, email_normalized, password_hash,
                created_at, updated_at, disabled_at
              ) VALUES (?, ?, ?, ?, ?, ?, NULL)
            `).run(userId, emailOriginal, emailNormalized, passwordHash, now, now);
            database.prepare(`
              INSERT INTO sessions (
                id, user_id, token_hash, created_at, expires_at, revoked_at
              ) VALUES (?, ?, ?, ?, ?, NULL)
            `).run(sessionId, userId, sessionTokenHash, now, sessionExpiresAt);

            return {
              user: {
                id: userId,
                emailOriginal,
                emailNormalized,
                passwordHash,
                createdAt: now,
                updatedAt: now,
                disabledAt: null
              },
              session: {
                id: sessionId,
                userId,
                createdAt: now,
                expiresAt: sessionExpiresAt,
                revokedAt: null
              }
            };
          })
        );
      } catch (error) {
        if (!isSqliteConstraint(error)) {
          throw error;
        }

        const existingUser = await findUserByNormalizedEmail(emailNormalized);
        if (existingUser) {
          throw new AuthStoreError("EMAIL_ALREADY_EXISTS", "An account already exists for this email.");
        }
        throw new AuthStoreError("AUTH_STORAGE_CONSTRAINT", "Authentication data could not be stored.");
      }
    },

    findUserByNormalizedEmail,

    async requestAccountDeletion({ userId, purgeAfter }) {
      const now = requireTimestamp(clock(), "clock");
      requireTimestamp(purgeAfter, "purgeAfter");
      return withDatabase(databaseFilePath, (database) => withImmediateTransaction(database, () => {
        const disabled = database.prepare(`
          UPDATE users
          SET disabled_at = ?, deletion_requested_at = ?, purge_after = ?, updated_at = ?
          WHERE id = ? AND disabled_at IS NULL AND deletion_requested_at IS NULL
        `).run(now, now, purgeAfter, now, userId);
        if (disabled.changes !== 1) return false;
        database.prepare(`
          UPDATE sessions SET revoked_at = ?
          WHERE user_id = ? AND revoked_at IS NULL
        `).run(now, userId);
        database.prepare(`
          UPDATE password_reset_tokens SET invalidated_at = ?
          WHERE user_id = ? AND used_at IS NULL AND invalidated_at IS NULL
        `).run(now, userId);
        return true;
      }));
    },

    async replacePasswordResetToken({ userId, tokenHash, expiresAt }) {
      requireTokenHash(tokenHash, "tokenHash");
      requireTimestamp(expiresAt, "expiresAt");
      const now = requireTimestamp(clock(), "clock");
      const tokenId = idGenerator("password-reset-token");

      return withDatabase(databaseFilePath, (database) =>
        withImmediateTransaction(database, () => {
          database.prepare(`
            UPDATE password_reset_tokens
            SET invalidated_at = ?
            WHERE user_id = ?
              AND used_at IS NULL
              AND invalidated_at IS NULL
          `).run(now, userId);
          database.prepare(`
            INSERT INTO password_reset_tokens (
              id, user_id, token_hash, created_at, expires_at, used_at, invalidated_at
            ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
          `).run(tokenId, userId, tokenHash, now, expiresAt);
          return { id: tokenId, userId, createdAt: now, expiresAt };
        })
      );
    },

    async consumePasswordResetToken({ tokenHash, passwordHash }) {
      requireTokenHash(tokenHash, "tokenHash");
      if (typeof passwordHash !== "string" || passwordHash.length < 64) {
        throw new TypeError("passwordHash must be an encoded password hash.");
      }
      const now = requireTimestamp(clock(), "clock");

      return withDatabase(databaseFilePath, (database) =>
        withImmediateTransaction(database, () => {
          const token = database.prepare(`
            SELECT password_reset_tokens.id, password_reset_tokens.user_id
            FROM password_reset_tokens
            INNER JOIN users ON users.id = password_reset_tokens.user_id
            WHERE password_reset_tokens.token_hash = ?
              AND password_reset_tokens.used_at IS NULL
              AND password_reset_tokens.invalidated_at IS NULL
              AND password_reset_tokens.expires_at > ?
              AND users.disabled_at IS NULL
              AND users.deletion_requested_at IS NULL
            LIMIT 1
          `).get(tokenHash, now);
          if (!token) return false;

          const claimed = database.prepare(`
            UPDATE password_reset_tokens
            SET used_at = ?
            WHERE id = ?
              AND used_at IS NULL
              AND invalidated_at IS NULL
              AND expires_at > ?
          `).run(now, token.id, now);
          if (claimed.changes !== 1) return false;

          const passwordUpdated = database.prepare(`
            UPDATE users
            SET password_hash = ?, updated_at = ?
            WHERE id = ? AND disabled_at IS NULL AND deletion_requested_at IS NULL
          `).run(passwordHash, now, token.user_id).changes;
          if (passwordUpdated !== 1) {
            throw new AuthStoreError("AUTH_STORAGE_CONSTRAINT", "Authentication data could not be stored.");
          }
          database.prepare(`
            UPDATE sessions
            SET revoked_at = ?
            WHERE user_id = ? AND revoked_at IS NULL
          `).run(now, token.user_id);
          database.prepare(`
            UPDATE password_reset_tokens
            SET invalidated_at = ?
            WHERE user_id = ?
              AND id <> ?
              AND used_at IS NULL
              AND invalidated_at IS NULL
          `).run(now, token.user_id, token.id);
          return true;
        })
      );
    },

    async findActiveSessionByTokenHash(tokenHash) {
      if (!Buffer.isBuffer(tokenHash) || tokenHash.length !== 32) {
        return null;
      }
      const now = requireTimestamp(clock(), "clock");
      return withDatabase(databaseFilePath, (database) => {
        const row = database.prepare(`
          SELECT
            sessions.id AS session_id,
            sessions.user_id AS session_user_id,
            sessions.created_at AS session_created_at,
            sessions.expires_at,
            sessions.revoked_at,
            users.id,
            users.email_original,
            users.email_normalized,
            users.password_hash,
            users.created_at,
            users.updated_at,
            users.disabled_at,
            users.deletion_requested_at,
            users.purge_after
          FROM sessions
          INNER JOIN users ON users.id = sessions.user_id
          WHERE sessions.token_hash = ?
            AND sessions.revoked_at IS NULL
            AND sessions.expires_at > ?
            AND users.disabled_at IS NULL
            AND users.deletion_requested_at IS NULL
          LIMIT 1
        `).get(tokenHash, now);

        return row ? { user: toUser(row), session: toSession(row) } : null;
      });
    },

    async rotateSession({ userId, previousTokenHash, newTokenHash, newExpiresAt }) {
      requireTokenHash(newTokenHash, "newTokenHash");
      if (previousTokenHash !== undefined && previousTokenHash !== null) {
        requireTokenHash(previousTokenHash, "previousTokenHash");
      }
      requireTimestamp(newExpiresAt, "newExpiresAt");
      const now = requireTimestamp(clock(), "clock");
      const sessionId = idGenerator("session");

      try {
        return withDatabase(databaseFilePath, (database) =>
          withImmediateTransaction(database, () => {
            if (previousTokenHash) {
              database.prepare(`
                UPDATE sessions
                SET revoked_at = ?
                WHERE token_hash = ? AND revoked_at IS NULL
              `).run(now, previousTokenHash);
            }
            database.prepare(`
              INSERT INTO sessions (
                id, user_id, token_hash, created_at, expires_at, revoked_at
              ) VALUES (?, ?, ?, ?, ?, NULL)
            `).run(sessionId, userId, newTokenHash, now, newExpiresAt);

            return {
              id: sessionId,
              userId,
              createdAt: now,
              expiresAt: newExpiresAt,
              revokedAt: null
            };
          })
        );
      } catch (error) {
        if (isSqliteConstraint(error)) {
          throw new AuthStoreError("AUTH_STORAGE_CONSTRAINT", "Authentication data could not be stored.");
        }
        throw error;
      }
    },

    async revokeSessionByTokenHash(tokenHash) {
      requireTokenHash(tokenHash, "tokenHash");
      const now = requireTimestamp(clock(), "clock");
      return withDatabase(databaseFilePath, (database) =>
        database.prepare(`
          UPDATE sessions
          SET revoked_at = ?
          WHERE token_hash = ? AND revoked_at IS NULL
        `).run(now, tokenHash).changes === 1
      );
    },

    async cleanupSessions({ expiredBefore, revokedBefore, limit = 100 }) {
      requireTimestamp(expiredBefore, "expiredBefore");
      requireTimestamp(revokedBefore, "revokedBefore");
      const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1_000);

      return withDatabase(databaseFilePath, (database) =>
        withImmediateTransaction(database, () => {
          const rows = database.prepare(`
            SELECT id
            FROM sessions
            WHERE expires_at <= ?
               OR (revoked_at IS NOT NULL AND revoked_at <= ?)
            ORDER BY expires_at, id
            LIMIT ?
          `).all(expiredBefore, revokedBefore, safeLimit);
          const remove = database.prepare("DELETE FROM sessions WHERE id = ?");
          let deleted = 0;
          for (const { id } of rows) {
            deleted += remove.run(id).changes;
          }
          return deleted;
        })
      );
    }
  };
}
