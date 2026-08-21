import { sitePulseMigrations } from "../storage/migrations.mjs";
import { withDatabase } from "../storage/sqlite-database.mjs";

const expectedMigrationLedger = sitePulseMigrations.map(({ version, name }) => ({ version, name }));

export function createSqliteReadinessCheck(databaseFilePath) {
  return () => {
    try {
      const appliedMigrations = withDatabase(databaseFilePath, (database) =>
        database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all()
      );
      const ready =
        appliedMigrations.length === expectedMigrationLedger.length &&
        appliedMigrations.every(({ version, name }, index) => {
          const expected = expectedMigrationLedger[index];
          return version === expected.version && name === expected.name;
        });

      return { ready };
    } catch {
      return { ready: false };
    }
  };
}
