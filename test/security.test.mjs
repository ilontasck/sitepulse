import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../src/config/env.mjs";
import { createApp } from "../src/http/app.mjs";

let server;
let baseUrl;

describe("security hardening", () => {
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "sitepulse-security-"));
    const config = loadConfig({
      NODE_ENV: "test",
      AUTH_REGISTRATION_MODE: "closed",
      PORT: 0,
      DATABASE_FILE_PATH: join(dir, "sitepulse.sqlite"),
      RATE_LIMIT_MAX: 2,
      RATE_LIMIT_WINDOW_MS: 60_000
    });
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

  it("does not expose backend source files as static assets", async () => {
    const response = await fetch(`${baseUrl}/server.mjs`);
    const body = await response.text();

    assert.equal(response.status, 404);
    assert.doesNotMatch(body, /createServer/);
  });

  it("serves a fail-closed CSP without inline or eval execution", async () => {
    const response = await fetch(`${baseUrl}/`);

    assert.equal(
      response.headers.get("content-security-policy"),
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    );
  });

  it("rate limits API calls", async () => {
    await fetch(`${baseUrl}/api/not-found`, { headers: { "X-Forwarded-For": "198.51.100.1" } });
    await fetch(`${baseUrl}/api/not-found`, { headers: { "X-Forwarded-For": "198.51.100.2" } });
    const response = await fetch(`${baseUrl}/api/not-found`, { headers: { "X-Forwarded-For": "198.51.100.3" } });
    const body = await response.json();

    assert.equal(response.status, 429);
    assert.equal(body.error.code, "RATE_LIMITED");
    assert.equal(response.headers.get("ratelimit-limit"), "2");
  });
});
