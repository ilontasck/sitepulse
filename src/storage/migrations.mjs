import { withDatabase, withImmediateTransaction } from "./sqlite-database.mjs";
import { migration001InitialAudits } from "./migrations/001_initial_audits.mjs";
import { migration002AuditJobs } from "./migrations/002_audit_jobs.mjs";

export const sitePulseMigrations = [migration001InitialAudits, migration002AuditJobs];

function validateMigrations(migrations) {
  let previousVersion = 0;

  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previousVersion) {
      throw new Error("SQLite migrations must have unique, strictly increasing integer versions.");
    }

    if (!migration.name || typeof migration.up !== "function") {
      throw new Error(`SQLite migration ${migration.version} is invalid.`);
    }

    previousVersion = migration.version;
  }
}

export function runMigrations(databaseFilePath, options = {}) {
  const migrations = options.migrations || sitePulseMigrations;
  const now = options.now || (() => new Date().toISOString());
  validateMigrations(migrations);

  return withDatabase(databaseFilePath, (database) =>
    withImmediateTransaction(database, () => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);

      const appliedVersions = new Set(database.prepare("SELECT version FROM schema_migrations").all().map(({ version }) => version));
      const insertVersion = database.prepare(`
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (?, ?, ?)
      `);

      for (const migration of migrations) {
        if (appliedVersions.has(migration.version)) {
          continue;
        }

        migration.up(database);
        insertVersion.run(migration.version, migration.name, now());
      }

      return database.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all();
    })
  );
}
