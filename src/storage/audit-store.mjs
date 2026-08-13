import { randomUUID } from "node:crypto";
import { createAuditRecord, insertAuditRecord } from "./audit-record.mjs";
import { withDatabase } from "./sqlite-database.mjs";

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

export function createAuditStore(databaseFilePath) {
  return {
    async create(audit) {
      return withDatabase(databaseFilePath, (database) => {
        const now = new Date().toISOString();
        const record = createAuditRecord(audit, { id: randomUUID(), now });
        return insertAuditRecord(database, record);
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
    }
  };
}
