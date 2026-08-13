export function createAuditRecord(audit, { id, now }) {
  return {
    ...audit,
    id,
    createdAt: now,
    updatedAt: now
  };
}

export function insertAuditRecord(database, record) {
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
}
