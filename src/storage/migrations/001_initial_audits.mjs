const expectedColumns = [
  ["id", "TEXT", 0, 1],
  ["created_at", "TEXT", 1, 0],
  ["updated_at", "TEXT", 1, 0],
  ["normalized_url", "TEXT", 1, 0],
  ["domain", "TEXT", 1, 0],
  ["overall_score", "INTEGER", 1, 0],
  ["scanner_mode", "TEXT", 1, 0],
  ["report_json", "TEXT", 1, 0]
];

function assertCompatibleAuditsTable(database) {
  const columns = database.prepare("PRAGMA table_info(audits)").all();
  const actualColumns = columns.map(({ name, type, notnull, pk }) => [name, type.toUpperCase(), notnull, pk]);

  if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
    throw new Error("Existing audits table is incompatible with SitePulse migration 001.");
  }
}

export const migration001InitialAudits = {
  version: 1,
  name: "initial audits",
  up(database) {
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

    assertCompatibleAuditsTable(database);
  }
};
