import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSqliteReadinessCheck } from "../src/health/sqlite-readiness.mjs";
import { runMigrations } from "../src/storage/migrations.mjs";

function createMigratedDatabase(directory, name) {
  const databaseFilePath = join(directory, name);
  runMigrations(databaseFilePath);
  return databaseFilePath;
}

function mutateDatabase(databaseFilePath, sql) {
  const database = new DatabaseSync(databaseFilePath);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

test("SQLite readiness requires the complete ordered migration ledger", () => {
  const directory = mkdtempSync(join(tmpdir(), "noqori-readiness-"));

  try {
    const complete = createMigratedDatabase(directory, "complete.sqlite");
    assert.deepEqual(createSqliteReadinessCheck(complete)(), { ready: true });

    const missing = createMigratedDatabase(directory, "missing.sqlite");
    mutateDatabase(missing, "DELETE FROM schema_migrations WHERE version = 3;");
    assert.deepEqual(createSqliteReadinessCheck(missing)(), { ready: false });

    const extra = createMigratedDatabase(directory, "extra.sqlite");
    mutateDatabase(extra, `
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (99, 'unknown migration', '2026-08-21T00:00:00.000Z');
    `);
    assert.deepEqual(createSqliteReadinessCheck(extra)(), { ready: false });

    const wrongName = createMigratedDatabase(directory, "wrong-name.sqlite");
    mutateDatabase(wrongName, "UPDATE schema_migrations SET name = 'unexpected' WHERE version = 4;");
    assert.deepEqual(createSqliteReadinessCheck(wrongName)(), { ready: false });

    const blockedParent = join(directory, "not-a-directory");
    writeFileSync(blockedParent, "blocked");
    assert.deepEqual(createSqliteReadinessCheck(join(blockedParent, "sitepulse.sqlite"))(), { ready: false });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
