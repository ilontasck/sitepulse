import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { createAuditStore } from "../src/storage/audit-store.mjs";

describe("audit store", () => {
  it("creates SQLite audit records, lists summaries, and finds full reports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sitepulse-store-"));
    const databasePath = join(dir, "sitepulse.sqlite");
    const store = createAuditStore(databasePath);

    const created = await store.create({
      domain: "luna-cafe.com",
      normalizedUrl: "https://luna-cafe.com",
      overallScore: 82,
      categories: [],
      priorityFixes: [],
      improvements: [],
      signals: {},
      scanner: {
        mode: "heuristic",
        adapters: ["test"],
        checkedAt: "2026-06-30T00:00:00.000Z",
        warnings: []
      }
    });

    assert.match(created.id, /^[0-9a-f-]{36}$/);
    assert.equal(created.domain, "luna-cafe.com");

    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, created.id);
    assert.equal(list[0].scannerMode, "heuristic");
    assert.equal(list[0].categories, undefined);
    assert.equal(list[0].priorityFixes, undefined);

    const found = await store.findById(created.id);
    assert.equal(found.id, created.id);
    assert.deepEqual(found.categories, []);

    const database = new DatabaseSync(databasePath);
    const row = database.prepare("SELECT scanner_mode, report_json FROM audits WHERE id = ?").get(created.id);
    database.close();

    assert.equal(row.scanner_mode, "heuristic");
    assert.match(row.report_json, /"domain":"luna-cafe.com"/);
  });

  it("returns null for unknown IDs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sitepulse-store-"));
    const store = createAuditStore(join(dir, "sitepulse.sqlite"));

    assert.equal(await store.findById("missing"), null);
  });
});
