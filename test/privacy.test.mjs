import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../src/config/env.mjs";
import { createApp } from "../src/http/app.mjs";

let server;
let baseUrl;

describe("privacy controls", () => {
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "sitepulse-privacy-"));
    const config = loadConfig({
      NODE_ENV: "test",
      PORT: 0,
      DATABASE_FILE_PATH: join(dir, "sitepulse.sqlite")
    });
    server = createApp(config, {
      auditGenerator: async () => ({
        normalizedUrl: "https://luna-cafe.com",
        domain: "luna-cafe.com",
        overallScore: 82,
        categories: [],
        recommendations: [],
        priorityFixes: [],
        improvements: [],
        signals: {},
        scanner: {
          mode: "heuristic",
          adapters: ["test"],
          checkedAt: "2026-06-30T00:00:00.000Z",
          warnings: []
        },
        warnings: []
      })
    });

    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("disables audit history endpoint when no admin key is configured", async () => {
    const response = await fetch(`${baseUrl}/api/audits`);
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.error.code, "AUDIT_HISTORY_DISABLED");
  });

  it("still allows creating a report and fetching it by its unguessable id", async () => {
    const createdResponse = await fetch(`${baseUrl}/api/audits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ websiteUrl: "luna-cafe.com" })
    });
    const createdBody = await createdResponse.json();
    const fetchedResponse = await fetch(`${baseUrl}/api/audits/${createdBody.audit.id}`);
    const fetchedBody = await fetchedResponse.json();

    assert.equal(createdResponse.status, 201);
    assert.equal(fetchedResponse.status, 200);
    assert.equal(fetchedBody.audit.id, createdBody.audit.id);
  });
});
