import { randomUUID } from "node:crypto";
import { createAuditRecord, insertAuditRecord } from "./audit-record.mjs";
import { withDatabase } from "./sqlite-database.mjs";

export const FREE_REPORT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

function toIsoTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Audit store clock must return a valid date.");
  return date.toISOString();
}

function parseReportJson(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  return JSON.parse(value);
}

function toAuditRecord(row) {
  return parseReportJson(row.report_json);
}

function toAuditSummary(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    domain: row.domain,
    normalizedUrl: row.normalized_url,
    overallScore: row.overall_score,
    scannerMode: row.scanner_mode
  };
}

export function createAuditStore(databaseFilePath, options = {}) {
  const clock = options.clock || (() => new Date());
  const reportTtlMs = options.reportTtlMs ?? FREE_REPORT_TTL_MS;
  return {
    async create(audit) {
      return withDatabase(databaseFilePath, (database) => {
        const now = toIsoTime(clock());
        const record = createAuditRecord(audit, { id: randomUUID(), now });
        const expiresAt = new Date(new Date(now).getTime() + reportTtlMs).toISOString();
        return insertAuditRecord(database, record, { expiresAt });
      });
    },

    async list({ limit = 20 } = {}) {
      return withDatabase(databaseFilePath, (database) => {
        const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
        const rows = database.prepare(`
          SELECT
            id,
            created_at,
            normalized_url,
            domain,
            overall_score,
            scanner_mode
          FROM audits
          ORDER BY created_at DESC
          LIMIT ?
        `).all(safeLimit);

        return rows.map(toAuditSummary);
      });
    },

    async findById(id) {
      return withDatabase(databaseFilePath, (database) => {
        const row = database.prepare(`
          SELECT report_json
          FROM audits
          WHERE id = ?
          LIMIT 1
        `).get(id);

        return row ? toAuditRecord(row) : null;
      });
    },

    async findByIdForUser(id, userId) {
      const now = toIsoTime(clock());
      return withDatabase(databaseFilePath, (database) => {
        const row = database.prepare(`
          SELECT audits.report_json
          FROM audits
          INNER JOIN users ON users.id = audits.user_id
          WHERE audits.id = ? AND audits.user_id = ?
            AND audits.deleted_at IS NULL
            AND audits.expires_at > ?
            AND users.disabled_at IS NULL
            AND users.deletion_requested_at IS NULL
          LIMIT 1
        `).get(id, userId, now);

        return row ? toAuditRecord(row) : null;
      });
    },

    async softDeleteForUser(id, userId) {
      const now = toIsoTime(clock());
      return withDatabase(databaseFilePath, (database) => database.prepare(`
        UPDATE audits
        SET deleted_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
          AND deleted_at IS NULL
          AND expires_at > ?
          AND EXISTS (
            SELECT 1 FROM users
            WHERE users.id = audits.user_id
              AND users.disabled_at IS NULL
              AND users.deletion_requested_at IS NULL
          )
      `).run(now, now, id, userId, now).changes === 1);
    }
  };
}
