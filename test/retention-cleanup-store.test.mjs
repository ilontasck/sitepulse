import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { createRetentionCleanupStore } from "../src/storage/retention-cleanup-store.mjs";
import { runMigrations } from "../src/storage/migrations.mjs";

const directories = [];
const now = "2026-09-20T12:00:00.000Z";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "noqori-retention-"));
  directories.push(directory);
  const databaseFilePath = join(directory, "sitepulse.sqlite");
  runMigrations(databaseFilePath);
  return { databaseFilePath, store: createRetentionCleanupStore(databaseFilePath, { clock: () => now }) };
}

function databaseState(path, callback) {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON;");
  try { return callback(database); } finally { database.close(); }
}

function insertUser(database, id, { deletionRequestedAt = null, purgeAfter = null } = {}) {
  database.prepare(`
    INSERT INTO users (id, email_original, email_normalized, password_hash, created_at, updated_at, disabled_at, deletion_requested_at, purge_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, `${id}@example.test`, `${id}@example.test`, "x".repeat(64), "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", deletionRequestedAt, deletionRequestedAt, purgeAfter);
}

function insertReport(database, id, userId, { expiresAt, deletedAt = null } = {}) {
  database.prepare(`
    INSERT INTO audits (id, created_at, updated_at, normalized_url, domain, overall_score, scanner_mode, report_json, user_id, expires_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, 80, 'html', ?, ?, ?, ?)
  `).run(id, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", `https://${id}.example.test`, `${id}.example.test`, JSON.stringify({ id }), userId, expiresAt, deletedAt);
  database.prepare(`
    INSERT INTO audit_jobs (id, status, normalized_url, audit_id, attempt_count, max_attempts, available_at, created_at, updated_at, completed_at, user_id)
    VALUES (?, 'completed', ?, ?, 1, 2, ?, ?, ?, ?, ?)
  `).run(`job-${id}`, `https://${id}.example.test`, id, now, now, now, now, userId);
}

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe("retention cleanup store", () => {
  it("deletes expired and soft-deleted reports with linked jobs while preserving active reports", () => {
    const { databaseFilePath, store } = fixture();
    databaseState(databaseFilePath, (database) => {
      insertUser(database, "owner");
      insertReport(database, "expired", "owner", { expiresAt: "2026-09-20T11:59:59.000Z" });
      insertReport(database, "deleted", "owner", { expiresAt: "2026-10-01T00:00:00.000Z", deletedAt: "2026-09-20T11:00:00.000Z" });
      insertReport(database, "active", "owner", { expiresAt: "2026-09-20T12:00:01.000Z" });
      database.prepare("INSERT INTO audit_monthly_usage (user_id, period_start, used_count) VALUES ('owner','2026-09-01T00:00:00.000Z',3)").run();
      database.prepare("UPDATE audit_jobs SET quota_period_start='2026-09-01T00:00:00.000Z', quota_charged=1 WHERE id='job-expired'").run();
    });

    assert.deepEqual(store.cleanup({ limit: 100 }), { reports: 2, pendingJobs: 0, accounts: 0, adminOperations: 0 });
    assert.deepEqual(store.cleanup({ limit: 100 }), { reports: 0, pendingJobs: 0, accounts: 0, adminOperations: 0 });
    databaseState(databaseFilePath, (database) => {
      assert.deepEqual(database.prepare("SELECT id FROM audits ORDER BY id").all().map(({ id }) => id), ["active"]);
      assert.deepEqual(database.prepare("SELECT id FROM audit_jobs ORDER BY id").all().map(({ id }) => id), ["job-active"]);
      assert.equal(database.prepare("SELECT used_count FROM audit_monthly_usage WHERE user_id='owner'").get().used_count, 3);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    });
  });

  it("uses deterministic batches", () => {
    const { databaseFilePath, store } = fixture();
    databaseState(databaseFilePath, (database) => {
      insertUser(database, "owner");
      insertReport(database, "b-report", "owner", { expiresAt: "2026-09-01T00:00:00.000Z" });
      insertReport(database, "a-report", "owner", { expiresAt: "2026-09-01T00:00:00.000Z" });
    });
    assert.equal(store.cleanup({ limit: 1 }).reports, 1);
    assert.deepEqual(databaseState(databaseFilePath, (database) => database.prepare("SELECT id FROM audits ORDER BY id").all().map(({ id }) => id)), ["b-report"]);
    assert.equal(store.cleanup({ limit: 1 }).reports, 1);
  });

  it("removes queued and running work for deletion-pending accounts without touching other users", () => {
    const { databaseFilePath, store } = fixture();
    databaseState(databaseFilePath, (database) => {
      insertUser(database, "pending", { deletionRequestedAt: "2026-09-20T11:00:00.000Z", purgeAfter: "2026-10-20T11:00:00.000Z" });
      insertUser(database, "active");
      const insert = database.prepare(`
        INSERT INTO audit_jobs (id, status, normalized_url, attempt_count, max_attempts, available_at, created_at, updated_at, user_id)
        VALUES (?, 'queued', ?, 0, 2, ?, ?, ?, ?)
      `);
      insert.run("pending-job", "https://pending.example.test", now, now, now, "pending");
      insert.run("active-job", "https://active.example.test", now, now, now, "active");
    });
    assert.equal(store.cleanup({ limit: 100 }).pendingJobs, 1);
    assert.deepEqual(databaseState(databaseFilePath, (database) => database.prepare("SELECT id FROM audit_jobs ORDER BY id").all().map(({ id }) => id)), ["active-job"]);
  });

  it("purges due accounts in FK-safe order but preserves accounts before their deadline", () => {
    const { databaseFilePath, store } = fixture();
    databaseState(databaseFilePath, (database) => {
      insertUser(database, "due", { deletionRequestedAt: "2026-08-20T12:00:00.000Z", purgeAfter: now });
      insertUser(database, "later", { deletionRequestedAt: "2026-09-20T11:00:00.000Z", purgeAfter: "2026-10-20T11:00:00.000Z" });
      insertReport(database, "due-report", "due", { expiresAt: "2026-10-01T00:00:00.000Z" });
      insertReport(database, "later-report", "later", { expiresAt: "2026-10-01T00:00:00.000Z" });
      database.prepare("INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run("session-due", "due", Buffer.alloc(32, 1), "2026-08-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
      database.prepare("INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run("reset-due", "due", Buffer.alloc(32, 2), "2026-08-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
      database.prepare("INSERT INTO audit_monthly_usage (user_id, period_start, used_count) VALUES (?, ?, ?)").run("due", "2026-09-01T00:00:00.000Z", 1);
      database.prepare("INSERT INTO audit_monthly_usage (user_id, period_start, used_count) VALUES (?, ?, ?)").run("later", "2026-09-01T00:00:00.000Z", 1);
    });

    const result = store.cleanup({ limit: 100 });
    assert.equal(result.accounts, 1);
    databaseState(databaseFilePath, (database) => {
      assert.deepEqual(database.prepare("SELECT id FROM users ORDER BY id").all().map(({ id }) => id), ["later"]);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audits WHERE user_id = 'due'").get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_jobs WHERE user_id = 'due'").get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'due'").get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM password_reset_tokens WHERE user_id = 'due'").get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_monthly_usage WHERE user_id = 'due'").get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_monthly_usage WHERE user_id = 'later'").get().count, 1);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    });
  });

  it("removes admin operations older than 30 days in batches and preserves current entries", () => {
    const { databaseFilePath, store } = fixture();
    databaseState(databaseFilePath, database => {
      const insert=database.prepare("INSERT INTO admin_operation_log VALUES (?,?,?,?,?,?,?)");
      insert.run("old","2026-08-20T11:59:59.000Z","job.retry","audit_job","job-old","accepted",null);
      insert.run("current","2026-08-21T12:00:00.000Z","job.retry","audit_job","job-current","accepted",null);
    });
    assert.equal(store.cleanup({limit:1}).adminOperations,1);
    assert.equal(store.cleanup({limit:1}).adminOperations,0);
    assert.deepEqual(databaseState(databaseFilePath,d=>d.prepare("SELECT id FROM admin_operation_log").all().map(r=>r.id)),["current"]);
  });
});
