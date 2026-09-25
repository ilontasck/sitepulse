import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startDataRetentionCleanupScheduler } from "../src/privacy/data-retention-cleanup-scheduler.mjs";
import { loadConfig } from "../src/config/env.mjs";
import { createApp } from "../src/http/app.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("data retention cleanup scheduler", () => {
  it("runs at startup, schedules a bounded interval, and stops idempotently", async () => {
    const calls = [];
    const cleared = [];
    const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
    const scheduler = startDataRetentionCleanupScheduler({
      cleanupStore: { cleanup(options) { calls.push(options); } },
      intervalMs: 21_600_000,
      batchSize: 25,
      setIntervalFn(callback, intervalMs) {
        assert.equal(typeof callback, "function");
        assert.equal(intervalMs, 21_600_000);
        return timer;
      },
      clearIntervalFn(value) { cleared.push(value); }
    });
    await flush();
    assert.deepEqual(calls, [{ limit: 25 }]);
    assert.equal(timer.unrefCalled, true);
    scheduler.stop();
    scheduler.stop();
    assert.deepEqual(cleared, [timer]);
  });

  it("contains one run failure and retries without exposing error details", async () => {
    let callback;
    let attempts = 0;
    const events = [];
    const scheduler = startDataRetentionCleanupScheduler({
      cleanupStore: { cleanup() { attempts += 1; if (attempts === 1) throw new Error("private database path"); } },
      telemetry: { record(event, fields) { events.push({ event, fields }); } },
      setIntervalFn(value) { callback = value; return { unref() {} }; },
      clearIntervalFn() {}
    });
    await flush();
    assert.deepEqual(events, [{ event: "data_retention_cleanup_failed", fields: { outcome: "failure", reason: "storage_error", errorCode: "DB_FAILURE" } }]);
    callback();
    await flush();
    assert.equal(attempts, 2);
    scheduler.stop();
  });

  it("starts with the app and stops on server close", async () => {
    const events = [];
    const config = loadConfig({
      NODE_ENV: "test", PORT: 0, AUTH_REGISTRATION_MODE: "closed",
      DATABASE_FILE_PATH: join(mkdtempSync(join(tmpdir(), "noqori-retention-app-")), "sitepulse.sqlite")
    });
    const server = createApp(config, {
      authService: {}, authStore: { cleanupSessions() {} }, store: {}, jobStore: {},
      startSessionCleanupScheduler() { return { stop() {} }; },
      startDataRetentionCleanupScheduler({ cleanupStore }) {
        assert.equal(typeof cleanupStore.cleanup, "function");
        events.push("start");
        return { stop() { events.push("stop"); } };
      }
    });
    assert.deepEqual(events, ["start"]);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(events, ["start", "stop"]);
  });

  it("keeps the server healthy when startup cleanup fails", async () => {
    const config = loadConfig({
      NODE_ENV: "test", PORT: 0, AUTH_REGISTRATION_MODE: "closed",
      DATABASE_FILE_PATH: join(mkdtempSync(join(tmpdir(), "noqori-retention-failure-")), "sitepulse.sqlite")
    });
    const server = createApp(config, {
      startSessionCleanupScheduler() { return { stop() {} }; },
      retentionCleanupStore: { cleanup() { throw new Error("database unavailable"); } },
      dataRetentionCleanupOptions: { setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {} }
    });
    await flush();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    assert.equal(response.status, 200);
    await new Promise((resolve) => server.close(resolve));
  });
});
