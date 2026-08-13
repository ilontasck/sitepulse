import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { createAuditStore } from "../src/storage/audit-store.mjs";
import { runMigrations, sitePulseMigrations } from "../src/storage/migrations.mjs";

const temporaryDirectories = [];

async function temporaryDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "sitepulse-migrations-"));
  temporaryDirectories.push(directory);
  return join(directory, "sitepulse.sqlite");
}

function inspectDatabase(databaseFilePath, callback) {
  const database = new DatabaseSync(databaseFilePath);

  try {
    database.exec("PRAGMA foreign_keys = ON;");
    return callback(database);
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SQLite migrations", () => {
  it("migrates a clean database through audits and audit jobs", async () => {
    const databaseFilePath = await temporaryDatabase();

    runMigrations(databaseFilePath);

    const schema = inspectDatabase(databaseFilePath, (database) => ({
      versions: database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all().map(({ version, name }) => ({ version, name })),
      tables: database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    }));

    assert.deepEqual(schema.versions, [
      { version: 1, name: "initial audits" },
      { version: 2, name: "audit jobs" }
    ]);
    assert.equal(schema.tables.some(({ name }) => name === "audits"), true);
    assert.equal(schema.tables.some(({ name }) => name === "audit_jobs"), true);
  });

  it("adopts a legacy audits database without losing readable records", async () => {
    const databaseFilePath = await temporaryDatabase();
    const legacyAudit = {
      id: "b927cfb0-e4f7-4d6b-bc17-80af9f86b4bf",
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
      normalizedUrl: "https://legacy.example.com",
      domain: "legacy.example.com",
      overallScore: 81,
      categories: [],
      scanner: { mode: "html-real-checks" }
    };

    inspectDatabase(databaseFilePath, (database) => {
      database.exec(`
        CREATE TABLE audits (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          normalized_url TEXT NOT NULL,
          domain TEXT NOT NULL,
          overall_score INTEGER NOT NULL,
          scanner_mode TEXT NOT NULL,
          report_json TEXT NOT NULL
        );
      `);
      database.prepare(`
        INSERT INTO audits (
          id, created_at, updated_at, normalized_url, domain,
          overall_score, scanner_mode, report_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        legacyAudit.id,
        legacyAudit.createdAt,
        legacyAudit.updatedAt,
        legacyAudit.normalizedUrl,
        legacyAudit.domain,
        legacyAudit.overallScore,
        legacyAudit.scanner.mode,
        JSON.stringify(legacyAudit)
      );
    });

    runMigrations(databaseFilePath);

    const storedAudit = await createAuditStore(databaseFilePath).findById(legacyAudit.id);
    const count = inspectDatabase(databaseFilePath, (database) => database.prepare("SELECT COUNT(*) AS count FROM audits").get().count);

    assert.deepEqual(storedAudit, legacyAudit);
    assert.equal(count, 1);
  });

  it("is idempotent after all migrations are applied", async () => {
    const databaseFilePath = await temporaryDatabase();

    runMigrations(databaseFilePath, { now: () => "2026-08-13T10:00:00.000Z" });
    runMigrations(databaseFilePath, { now: () => "2026-08-13T11:00:00.000Z" });

    const migrations = inspectDatabase(databaseFilePath, (database) =>
      database.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version").all()
    );

    assert.deepEqual(
      migrations.map(({ version, applied_at: appliedAt }) => ({ version, appliedAt })),
      [
        { version: 1, appliedAt: "2026-08-13T10:00:00.000Z" },
        { version: 2, appliedAt: "2026-08-13T10:00:00.000Z" }
      ]
    );
  });

  it("enforces audit job indexes, foreign keys, statuses, attempts, and state consistency", async () => {
    const databaseFilePath = await temporaryDatabase();
    runMigrations(databaseFilePath);

    inspectDatabase(databaseFilePath, (database) => {
      const indexes = database.prepare("PRAGMA index_list(audit_jobs)").all().map(({ name }) => name);
      const insertJob = (values) =>
        database.prepare(`
          INSERT INTO audit_jobs (
            id, status, normalized_url, audit_id, attempt_count, max_attempts,
            available_at, lease_expires_at, worker_id, lease_token,
            created_at, updated_at, completed_at, failed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(...values);
      const base = [
        "job-1",
        "queued",
        "https://example.com",
        null,
        0,
        2,
        "2026-08-13T10:00:00.000Z",
        null,
        null,
        null,
        "2026-08-13T10:00:00.000Z",
        "2026-08-13T10:00:00.000Z",
        null,
        null
      ];

      assert.equal(indexes.includes("idx_audit_jobs_claim"), true);
      assert.equal(indexes.includes("idx_audit_jobs_expired_lease"), true);
      assert.equal(indexes.includes("idx_audit_jobs_audit_id"), true);
      assert.doesNotThrow(() => insertJob(base));
      assert.throws(() => insertJob(["bad-status", "cancelled", ...base.slice(2)]), /constraint/i);
      assert.throws(() => insertJob(["bad-attempts", "queued", base[2], null, 0, 3, ...base.slice(6)]), /constraint/i);
      assert.throws(
        () => insertJob(["bad-running", "running", base[2], null, 1, 2, base[6], null, null, null, base[10], base[11], null, null]),
        /constraint/i
      );
      assert.throws(
        () => insertJob(["missing-audit", "completed", base[2], "missing-audit-id", 1, 2, base[6], null, null, null, base[10], base[11], base[11], null]),
        /foreign key constraint/i
      );
      database.prepare(`
        INSERT INTO audits (
          id, created_at, updated_at, normalized_url, domain,
          overall_score, scanner_mode, report_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("audit-1", base[10], base[11], base[2], "example.com", 80, "html-real-checks", "{}");
      assert.doesNotThrow(() =>
        insertJob(["completed-1", "completed", base[2], "audit-1", 1, 2, base[6], null, null, null, base[10], base[11], base[11], null])
      );
      assert.throws(
        () => insertJob(["completed-2", "completed", base[2], "audit-1", 1, 2, base[6], null, null, null, base[10], base[11], base[11], null]),
        /unique constraint/i
      );
    });
  });

  it("rolls back a failed migration without recording its version", async () => {
    const databaseFilePath = await temporaryDatabase();
    runMigrations(databaseFilePath);
    const failingMigration = {
      version: 3,
      name: "intentional failure",
      up(database) {
        database.exec("CREATE TABLE must_rollback (id TEXT PRIMARY KEY);");
        throw new Error("migration failed intentionally");
      }
    };

    assert.throws(
      () => runMigrations(databaseFilePath, { migrations: [...sitePulseMigrations, failingMigration] }),
      /migration failed intentionally/
    );

    const state = inspectDatabase(databaseFilePath, (database) => ({
      version3: database.prepare("SELECT version FROM schema_migrations WHERE version = 3").get(),
      rolledBackTable: database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'must_rollback'").get()
    }));

    assert.equal(state.version3, undefined);
    assert.equal(state.rolledBackTable, undefined);
  });

  it("rolls back every pending migration when a fresh migration run fails", async () => {
    const databaseFilePath = await temporaryDatabase();
    const failingSecondMigration = {
      version: 2,
      name: "failing second migration",
      up(database) {
        database.exec("CREATE TABLE must_rollback (id TEXT PRIMARY KEY);");
        throw new Error("second migration failed intentionally");
      }
    };

    assert.throws(
      () => runMigrations(databaseFilePath, { migrations: [sitePulseMigrations[0], failingSecondMigration] }),
      /second migration failed intentionally/
    );

    const remainingTables = inspectDatabase(databaseFilePath, (database) =>
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    );

    assert.deepEqual(remainingTables.map(({ name }) => name), []);
  });
});
