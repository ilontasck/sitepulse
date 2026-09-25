import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AuditHistoryCursorError, createAuditStore } from "../src/storage/audit-store.mjs";
import { runMigrations } from "../src/storage/migrations.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), "noqori-history-")), "db.sqlite");
  runMigrations(file);
  const db = new DatabaseSync(file);
  for (const [id, email] of [[owner, "owner@example.com"], [other, "other@example.com"]]) {
    db.prepare(`INSERT INTO users (id,email_original,email_normalized,password_hash,created_at,updated_at)
      VALUES (?,?,?,?,?,?)`).run(id, email, email, "x".repeat(64), "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
  }
  const add = (id, userId, createdAt, { expiresAt = "2026-11-01T00:00:00.000Z", deletedAt = null } = {}) => {
    const audit = { id, createdAt, normalizedUrl: `https://${id}.example.com`, domain: `${id}.example.com`, overallScore: 80,
      categories: [], recommendations: [], priorityFixes: [], improvements: [], signals: {}, scanner: { mode: "html", adapters: [], warnings: [] }, warnings: [] };
    db.prepare(`INSERT INTO audits (id,created_at,updated_at,normalized_url,domain,overall_score,scanner_mode,report_json,user_id,expires_at,deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, createdAt, createdAt, audit.normalizedUrl, audit.domain, 80, "html", JSON.stringify(audit), userId, expiresAt, deletedAt);
  };
  return { db, file, add, store: createAuditStore(file, { clock: () => "2026-09-23T12:00:00.000Z" }) };
}

describe("owner audit history storage", () => {
  it("filters by owner and visibility and orders deterministically", async () => {
    const { db, add, store } = fixture();
    add("00000000-0000-4000-8000-000000000003", owner, "2026-09-03T00:00:00.000Z");
    add("00000000-0000-4000-8000-000000000002", owner, "2026-09-03T00:00:00.000Z");
    add("00000000-0000-4000-8000-000000000001", owner, "2026-09-01T00:00:00.000Z", { expiresAt: "2026-09-20T00:00:00.000Z" });
    add("00000000-0000-4000-8000-000000000004", owner, "2026-09-04T00:00:00.000Z", { deletedAt: "2026-09-10T00:00:00.000Z" });
    add("00000000-0000-4000-8000-000000000005", other, "2026-09-05T00:00:00.000Z");
    db.close();
    const page = await store.listForUser({ userId: owner, limit: 10 });
    assert.deepEqual(page.audits.map(({ id }) => id), ["00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000002"]);
    assert.deepEqual(Object.keys(page.audits[0]).sort(), ["createdAt", "domain", "expiresAt", "id", "normalizedUrl", "overallScore", "scannerMode"]);
  });

  it("uses an opaque keyset cursor without duplicates when an item is deleted", async () => {
    const { db, add, store } = fixture();
    for (let index = 1; index <= 4; index += 1) add(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, owner, `2026-09-0${index}T00:00:00.000Z`);
    db.close();
    const first = await store.listForUser({ userId: owner, limit: 2 });
    await store.softDeleteForUser(first.audits[1].id, owner);
    const second = await store.listForUser({ userId: owner, limit: 2, cursor: first.nextCursor });
    assert.equal(first.nextCursor.includes("2026"), false);
    assert.deepEqual(first.audits.map(({ id }) => id), ["00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000003"]);
    assert.deepEqual(second.audits.map(({ id }) => id), ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001"]);
    assert.equal(new Set([...first.audits, ...second.audits].map(({ id }) => id)).size, 4);
    assert.equal(second.nextCursor, null);
    await assert.rejects(() => store.listForUser({ userId: owner, cursor: "malformed!" }), AuditHistoryCursorError);
  });

  it("returns nothing for disabled or deletion-pending owners", async () => {
    const { db, file, add, store } = fixture();
    add("00000000-0000-4000-8000-000000000001", owner, "2026-09-01T00:00:00.000Z");
    db.prepare("UPDATE users SET disabled_at='2026-09-23T00:00:00.000Z' WHERE id=?").run(owner);
    db.close();
    assert.deepEqual(await store.listForUser({ userId: owner }), { audits: [], nextCursor: null });
    const verify = new DatabaseSync(file);
    verify.prepare("UPDATE users SET disabled_at=NULL, deletion_requested_at='2026-09-23T00:00:00.000Z' WHERE id=?").run(owner);
    verify.close();
    assert.deepEqual(await store.listForUser({ userId: owner }), { audits: [], nextCursor: null });
  });
});
