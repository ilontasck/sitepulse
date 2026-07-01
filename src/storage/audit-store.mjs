import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

function openDatabase(databaseFilePath) {
  mkdirSync(dirname(databaseFilePath), { recursive: true });
  const database = new DatabaseSync(databaseFilePath);

  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA busy_timeout = 5000;");

  return database;
}

function initializeDatabase(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS audits (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      normalized_url TEXT NOT NULL,
      domain TEXT NOT NULL,
      overall_score INTEGER NOT NULL,
      scanner_mode TEXT NOT NULL,
      report_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audits_created_at ON audits (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audits_domain ON audits (domain);
  `);
}

function withDatabase(databaseFilePath, callback) {
  const database = openDatabase(databaseFilePath);

  try {
    initializeDatabase(database);
    return callback(database);
  } finally {
    database.close();
  }
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

export function createAuditStore(databaseFilePath) {
  return {
    async create(audit) {
      return withDatabase(databaseFilePath, (database) => {
        const now = new Date().toISOString();
        const record = {
          id: randomUUID(),
          createdAt: now,
          updatedAt: now,
          ...audit
        };
        const scannerMode = record.scanner?.mode || "unknown";

        database.prepare(`
          INSERT INTO audits (
            id,
            created_at,
            updated_at,
            normalized_url,
            domain,
            overall_score,
            scanner_mode,
            report_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.id,
          record.createdAt,
          record.updatedAt,
          record.normalizedUrl,
          record.domain,
          record.overallScore,
          scannerMode,
          JSON.stringify(record)
        );

        return record;
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
