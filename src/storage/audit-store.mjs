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

function encodeHistoryCursor(row) {
  return Buffer.from(JSON.stringify({ v: 1, createdAt: row.created_at, id: row.id }), "utf8").toString("base64url");
}

function decodeHistoryCursor(cursor) {
  if (cursor == null) return null;
  if (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw new AuditHistoryCursorError();
  }
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const createdAt = new Date(payload?.createdAt);
    if (payload?.v !== 1 || typeof payload.id !== "string" || payload.id.length < 1 || payload.id.length > 128 ||
        !/^[0-9A-Za-z-]+$/u.test(payload.id) || Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== payload.createdAt) {
      throw new Error("invalid");
    }
    return { createdAt: payload.createdAt, id: payload.id };
  } catch {
    throw new AuditHistoryCursorError();
  }
}

function toHistorySummary(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    domain: row.domain,
    normalizedUrl: row.normalized_url,
    overallScore: row.overall_score,
    scannerMode: row.scanner_mode,
    expiresAt: row.expires_at
  };
}

export class AuditHistoryCursorError extends Error {
  constructor() {
    super("Audit history cursor is invalid.");
    this.name = "AuditHistoryCursorError";
  }
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

    async listForUser({ userId, limit = 10, cursor = null }) {
      const now = toIsoTime(clock());
      const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
      const position = decodeHistoryCursor(cursor);
      return withDatabase(databaseFilePath, (database) => {
        const rows = database.prepare(`
          SELECT audits.id, audits.created_at, audits.normalized_url, audits.domain,
                 audits.overall_score, audits.scanner_mode, audits.expires_at
          FROM audits
          INNER JOIN users ON users.id = audits.user_id
          WHERE audits.user_id = ?
            AND audits.deleted_at IS NULL
            AND audits.expires_at > ?
            AND users.disabled_at IS NULL
            AND users.deletion_requested_at IS NULL
            AND (? IS NULL OR audits.created_at < ? OR (audits.created_at = ? AND audits.id < ?))
          ORDER BY audits.created_at DESC, audits.id DESC
          LIMIT ?
        `).all(userId, now, position?.createdAt ?? null, position?.createdAt ?? null,
          position?.createdAt ?? null, position?.id ?? null, safeLimit + 1);
        const hasNextPage = rows.length > safeLimit;
        const pageRows = rows.slice(0, safeLimit);
        return {
          audits: pageRows.map(toHistorySummary),
          nextCursor: hasNextPage ? encodeHistoryCursor(pageRows.at(-1)) : null
        };
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
