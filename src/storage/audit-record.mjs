export function createAuditRecord(audit, { id, now }) {
  const { userId: _ignoredUserId, ...report } = audit;

  return {
    ...report,
    id,
    createdAt: now,
    updatedAt: now
  };
}

export function insertAuditRecord(database, record, { userId = null } = {}) {
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
      report_json,
      user_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.createdAt,
    record.updatedAt,
    record.normalizedUrl,
    record.domain,
    record.overallScore,
    scannerMode,
    JSON.stringify(record),
    userId
  );

  return record;
}
