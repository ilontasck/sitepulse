import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startSessionCleanupScheduler } from "../src/auth/session-cleanup-scheduler.mjs";
import { loadConfig } from "../src/config/env.mjs";
import { createApp } from "../src/http/app.mjs";

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("session cleanup scheduler", () => {
  it("runs one bounded cleanup at startup and schedules the next hourly run", async () => {
    const cleanupCalls = [];
    const scheduled = [];
    const cleared = [];
    const timer = {
      unrefCalled: false,
      unref() {
        this.unrefCalled = true;
      }
    };
    const now = new Date("2026-08-14T12:00:00.000Z");

    const scheduler = startSessionCleanupScheduler({
      authStore: {
        async cleanupSessions(options) {
          cleanupCalls.push(options);
          return 3;
        }
      },
      clock: () => now,
      intervalMs: 3_600_000,
      revokedRetentionMs: 86_400_000,
      batchSize: 25,
      setIntervalFn(callback, intervalMs) {
        scheduled.push({ callback, intervalMs });
        return timer;
      },
      clearIntervalFn(value) {
        cleared.push(value);
      }
    });

    await flushPromises();

    assert.deepEqual(cleanupCalls, [{
      expiredBefore: "2026-08-14T12:00:00.000Z",
      revokedBefore: "2026-08-13T12:00:00.000Z",
      limit: 25
    }]);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].intervalMs, 3_600_000);
    assert.equal(timer.unrefCalled, true);

    scheduler.stop();
    assert.deepEqual(cleared, [timer]);
  });

  it("runs cleanup from the hourly timer without overlapping active work", async () => {
    let timerCallback;
    let cleanupCalls = 0;
    let releaseCleanup;
    const activeCleanup = new Promise((resolve) => {
      releaseCleanup = resolve;
    });

    const scheduler = startSessionCleanupScheduler({
      authStore: {
        async cleanupSessions() {
          cleanupCalls += 1;
          if (cleanupCalls === 1) {
            await activeCleanup;
          }
        }
      },
      setIntervalFn(callback) {
        timerCallback = callback;
        return { unref() {} };
      },
      clearIntervalFn() {}
    });

    timerCallback();
    timerCallback();
    await flushPromises();
    assert.equal(cleanupCalls, 1);

    releaseCleanup();
    await flushPromises();
    timerCallback();
    await flushPromises();
    assert.equal(cleanupCalls, 2);

    scheduler.stop();
  });

  it("contains cleanup failures and retries on the next scheduled run", async () => {
    let timerCallback;
    let cleanupCalls = 0;
    const telemetryEntries = [];
    const scheduler = startSessionCleanupScheduler({
      authStore: {
        async cleanupSessions() {
          cleanupCalls += 1;
          if (cleanupCalls === 1) {
            throw new Error("sensitive storage details must not escape");
          }
        }
      },
      telemetry: {
        record(event, fields) {
          telemetryEntries.push({ event, fields });
        }
      },
      setIntervalFn(callback) {
        timerCallback = callback;
        return { unref() {} };
      },
      clearIntervalFn() {}
    });

    await flushPromises();
    assert.equal(cleanupCalls, 1);
    assert.deepEqual(telemetryEntries, [{
      event: "auth_session_cleanup_failed",
      fields: { outcome: "failure", reason: "storage_error" }
    }]);

    timerCallback();
    await flushPromises();
    assert.equal(cleanupCalls, 2);
    scheduler.stop();
  });

  it("wires cleanup after migrations and never triggers it from requests", async () => {
    const events = [];
    const cleared = [];
    const timer = { unref() {} };
    const config = loadConfig({
      NODE_ENV: "test",
      AUTH_REGISTRATION_MODE: "closed",
      PORT: 0,
      DATABASE_FILE_PATH: join(mkdtempSync(join(tmpdir(), "sitepulse-cleanup-app-")), "sitepulse.sqlite")
    });
    const server = createApp(config, {
      runMigrations() {
        events.push("migrations");
      },
      authStore: {
        async cleanupSessions() {
          events.push("cleanup");
          throw new Error("temporary cleanup failure");
        }
      },
      authService: {},
      store: {},
      jobStore: {},
      sessionCleanupOptions: {
        setIntervalFn() {
          return timer;
        },
        clearIntervalFn(value) {
          cleared.push(value);
        }
      }
    });

    await flushPromises();
    assert.deepEqual(events, ["migrations", "cleanup"]);

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    await fetch(`http://127.0.0.1:${address.port}/api/health`);
    await fetch(`http://127.0.0.1:${address.port}/api/health`);
    await flushPromises();
    assert.deepEqual(events, ["migrations", "cleanup"]);

    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(cleared, [timer]);
  });
});
