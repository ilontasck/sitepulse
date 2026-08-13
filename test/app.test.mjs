import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, after, describe, it } from "node:test";
import { loadConfig } from "../src/config/env.mjs";
import { createApp } from "../src/http/app.mjs";

let server;
let baseUrl;

describe("backend core", () => {
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "sitepulse-app-"));
    const config = loadConfig({ PORT: 0, NODE_ENV: "test", DATABASE_FILE_PATH: join(dir, "sitepulse.sqlite") });
    server = createApp(config);

    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("serves health endpoint", async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, "sitepulse");
  });

  it("serves the frontend shell", async () => {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(body, /SitePulse/);
  });

  it("adds security headers", async () => {
    const response = await fetch(`${baseUrl}/api/health`);

    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  });
});
