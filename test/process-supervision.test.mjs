import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config/env.mjs";
import { createApp } from "../src/http/app.mjs";
import { createAuditJobStore } from "../src/storage/audit-job-store.mjs";
import { createAuditStore } from "../src/storage/audit-store.mjs";
import { applyProductionEnvironment } from "../src/production/process-environment.mjs";
import { runProductionService } from "../src/production/process-entrypoint.mjs";
import { verifySystemdUnits } from "../src/production/systemd-verifier.mjs";
import { runMigrations } from "../src/storage/migrations.mjs";

const deploymentFile = (name) => new URL(`../deploy/systemd/${name}`, import.meta.url);

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForResponse(url, { timeoutMs = 3_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function seedOwnedJob(databaseFilePath) {
  const database = new DatabaseSync(databaseFilePath);
  const userId = "11111111-1111-4111-8111-111111111111";
  const now = "2026-08-20T10:00:00.000Z";
  database.prepare(`
    INSERT INTO users (
      id, email_original, email_normalized, password_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, "supervisor@example.com", "supervisor@example.com", "x".repeat(64), now, now);
  database.close();

  return createAuditJobStore(databaseFilePath).enqueue({
    normalizedUrl: "https://example.com",
    userId
  });
}

function forkWorkerFixture(environment) {
  return fork(new URL("../test-support/supervised-worker.mjs", import.meta.url), [], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
}

function waitForMessage(child, type, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("message", onMessage);
      reject(new Error(`Timed out waiting for child message ${type}`));
    }, timeoutMs);
    const onMessage = (message) => {
      if (message?.type !== type) return;
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      resolve(message);
    };
    child.on("message", onMessage);
  });
}

describe("production process supervision", () => {
  it("enforces protected process settings against conflicting host configuration", () => {
    const environment = {
      HOST: "0.0.0.0",
      DATABASE_FILE_PATH: "/tmp/ephemeral.sqlite",
      MIGRATIONS_MANAGED_EXTERNALLY: "false",
      RENDERED_AUDIT_ENABLED: "false",
      RENDERED_AUDIT_MAX_CONCURRENCY: "99"
    };

    const effective = applyProductionEnvironment("worker", environment, {
      sandboxAttestation: { valid: true, vmAcceptancePassed: false }
    });

    assert.deepEqual(effective, {
      databaseFilePath: "/var/lib/noqori/sitepulse.sqlite",
      migrationsManagedExternally: true,
      renderedAuditEnabled: false,
      renderedAuditMaxConcurrency: 1
    });
    assert.equal(environment.DATABASE_FILE_PATH, "/var/lib/noqori/sitepulse.sqlite");
    assert.equal(environment.HOST, "127.0.0.1");
    assert.equal(environment.MIGRATIONS_MANAGED_EXTERNALLY, "true");
    assert.equal(environment.RENDERED_AUDIT_ENABLED, "false");
    assert.equal(environment.RENDERED_AUDIT_MAX_CONCURRENCY, "1");
    assert.equal(environment.AUDIT_RUNNER_SOCKET_PATH, "/run/noqori-audit.sock");

    assert.throws(
      () => applyProductionEnvironment("worker", { RENDERED_AUDIT_ENABLED: "true" }),
      (error) => error?.code === "AUDIT_SANDBOX_REQUIRED" && !error.message.includes("/tmp/")
    );
    assert.throws(
      () => applyProductionEnvironment("worker", { RENDERED_AUDIT_ENABLED: "true" }, {
        sandboxAttestation: { valid: true, vmAcceptancePassed: false }
      }),
      (error) => error?.code === "RENDERED_AUDIT_REQUIRES_VM_ACCEPTANCE"
    );
    const accepted = { RENDERED_AUDIT_ENABLED: "true" };
    applyProductionEnvironment("worker", accepted, {
      sandboxAttestation: { valid: true, vmAcceptancePassed: true }
    });
    assert.equal(accepted.RENDERED_AUDIT_ENABLED, "true");

    const apiEnvironment = { RENDERED_AUDIT_ENABLED: "true" };
    applyProductionEnvironment("api", apiEnvironment);
    assert.equal(apiEnvironment.RENDERED_AUDIT_ENABLED, "false");
  });

  it("loads the service only after protected settings become effective", async () => {
    const environment = {
      DATABASE_FILE_PATH: "./data/release.sqlite",
      MIGRATIONS_MANAGED_EXTERNALLY: "false",
      RENDERED_AUDIT_ENABLED: "false",
      RENDERED_AUDIT_MAX_CONCURRENCY: "8"
    };
    let observed;

    await runProductionService("api", {
      environment,
      loadService: async () => {
        observed = {
          databaseFilePath: environment.DATABASE_FILE_PATH,
          migrationsManagedExternally: environment.MIGRATIONS_MANAGED_EXTERNALLY,
          renderedAuditEnabled: environment.RENDERED_AUDIT_ENABLED,
          renderedAuditMaxConcurrency: environment.RENDERED_AUDIT_MAX_CONCURRENCY
        };
      }
    });

    assert.deepEqual(observed, {
      databaseFilePath: "/var/lib/noqori/sitepulse.sqlite",
      migrationsManagedExternally: "true",
      renderedAuditEnabled: "false",
      renderedAuditMaxConcurrency: "1"
    });
  });

  it("fails production startup safely when rendered audit is requested before STE-12", () => {
    const secretMarker = "must-not-appear-in-startup-output";
    const result = spawnSync(process.execPath, ["scripts/run-production-service.mjs", "worker"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        RENDERED_AUDIT_ENABLED: "true",
        ADMIN_API_KEY: secretMarker
      },
      encoding: "utf8"
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /AUDIT_SANDBOX_REQUIRED/);
    assert.doesNotMatch(result.stderr, new RegExp(secretMarker));
  });

  it("runs API and worker as independent restartable systemd services", async () => {
    const [api, worker, target] = await Promise.all([
      readFile(deploymentFile("noqori-api.service"), "utf8"),
      readFile(deploymentFile("noqori-worker.service"), "utf8"),
      readFile(deploymentFile("noqori.target"), "utf8")
    ]);

    assert.match(api, /^ExecStartPre=\/usr\/bin\/test -x \/usr\/bin\/node$/m);
    assert.match(worker, /^ExecStartPre=\/usr\/bin\/test -x \/usr\/bin\/node$/m);
    assert.match(api, /^ExecStart=\/usr\/bin\/node scripts\/run-production-service\.mjs api$/m);
    assert.match(worker, /^ExecStart=\/usr\/bin\/node scripts\/run-production-service\.mjs worker$/m);
    assert.match(api, /^Restart=on-failure$/m);
    assert.match(worker, /^Restart=on-failure$/m);
    assert.match(target, /^Requires=noqori-migrate\.service$/m);
    assert.match(target, /^Wants=.*noqori-api\.service.*noqori-audit-sandbox\.service.*noqori-audit-runner\.socket.*noqori-worker\.service$/m);
    assert.match(target, /^After=.*noqori-migrate\.service.*noqori-api\.service.*noqori-audit-sandbox\.service.*noqori-audit-runner\.socket.*noqori-worker\.service$/m);
    assert.doesNotMatch(api, /noqori-worker\.service/);
    assert.doesNotMatch(worker, /noqori-api\.service/);
  });

  it("keeps crash recovery enabled without a permanent systemd start-limit stop", async () => {
    const worker = await readFile(deploymentFile("noqori-worker.service"), "utf8");

    assert.match(worker, /^Restart=on-failure$/m);
    assert.match(worker, /^RestartSec=5s$/m);
    assert.match(worker, /^StartLimitIntervalSec=0$/m);
    assert.doesNotMatch(worker, /^StartLimitBurst=/m);
  });

  it("reports systemd verification unavailable off Linux and verifies all units on Linux", () => {
    let invocation;
    const unavailable = verifySystemdUnits({
      platform: "darwin",
      runCommand() {
        throw new Error("systemd-analyze must not run off Linux");
      }
    });
    const verified = verifySystemdUnits({
      platform: "linux",
      runCommand(command, args) {
        invocation = { command, args };
        return { status: 0, stdout: "", stderr: "" };
      }
    });

    assert.equal(unavailable.status, "UNAVAILABLE");
    assert.equal(verified.status, "PASS");
    assert.equal(invocation.command, "systemd-analyze");
    assert.equal(invocation.args[0], "verify");
    assert.deepEqual(
      invocation.args.slice(1).map((filePath) => filePath.split("/").at(-1)),
      [
        "noqori.target",
        "noqori-migrate.service",
        "noqori-api.service",
        "noqori-worker.service",
        "noqori-audit-sandbox.service",
        "noqori-audit-sandbox-verify.service",
        "noqori-audit-runner.socket",
        "noqori-audit-runner.service"
      ]
    );
  });

  it("serializes migrations before both services and pins SQLite to persistent host storage", async () => {
    const [api, worker, migration] = await Promise.all([
      readFile(deploymentFile("noqori-api.service"), "utf8"),
      readFile(deploymentFile("noqori-worker.service"), "utf8"),
      readFile(deploymentFile("noqori-migrate.service"), "utf8")
    ]);

    assert.match(migration, /^Type=oneshot$/m);
    assert.match(migration, /^Before=noqori-api\.service noqori-worker\.service$/m);
    assert.match(migration, /^ExecStartPre=\/usr\/bin\/test -x \/usr\/bin\/node$/m);
    assert.match(migration, /^ExecStart=\/usr\/bin\/node scripts\/run-production-service\.mjs migrate$/m);

    for (const service of [api, worker]) {
      assert.match(service, /^Requires=noqori-migrate\.service$/m);
      assert.match(service, /^After=.*noqori-migrate\.service/m);
      assert.match(service, /^ReadWritePaths=\/var\/lib\/noqori$/m);
    }
    for (const service of [api, worker, migration]) {
      assert.match(service, /^StateDirectoryMode=0750$/m);
    }
  });

  it("enables reboot startup, bounded graceful stops, and readiness-gated service starts", async () => {
    const [api, worker, migration, target] = await Promise.all([
      readFile(deploymentFile("noqori-api.service"), "utf8"),
      readFile(deploymentFile("noqori-worker.service"), "utf8"),
      readFile(deploymentFile("noqori-migrate.service"), "utf8"),
      readFile(deploymentFile("noqori.target"), "utf8")
    ]);

    assert.match(target, /^WantedBy=multi-user\.target$/m);
    assert.match(migration, /^RemainAfterExit=yes$/m);
    assert.match(migration, /^PartOf=noqori\.target$/m);
    assert.match(api, /^PartOf=noqori\.target$/m);
    assert.match(worker, /^PartOf=noqori\.target$/m);
    assert.match(api, /^KillMode=mixed$/m);
    assert.match(worker, /^KillMode=mixed$/m);
    assert.match(api, /^TimeoutStopSec=30s$/m);
    assert.match(worker, /^TimeoutStopSec=90s$/m);
    assert.match(api, /^ExecStartPost=\/usr\/bin\/node scripts\/check-service-health\.mjs api --wait$/m);
    assert.match(worker, /^ExecStartPost=\/usr\/bin\/node scripts\/check-service-health\.mjs worker --wait$/m);

    for (const unit of [api, worker, migration, target]) {
      assert.doesNotMatch(unit, /(ADMIN_API_KEY|password|secret|token)=/i);
    }
  });

  it("publishes worker readiness before entering the claim loop", async () => {
    const workerEntrypoint = await readFile(new URL("../worker.mjs", import.meta.url), "utf8");
    const initialReadiness = workerEntrypoint.indexOf("await waitForInitialWorkerReadiness()");
    const markReady = workerEntrypoint.indexOf("healthServer.markReady()");
    const readyEvent = workerEntrypoint.indexOf('status: "ready-before-claim"');
    const runLoop = workerEntrypoint.indexOf("await worker.run()");

    assert.ok(initialReadiness > 0);
    assert.ok(initialReadiness < markReady);
    assert.ok(markReady < readyEvent);
    assert.ok(readyEvent < runLoop);
  });

  it("documents a secret-free single-VM operating contract and future browser sandbox seam", async () => {
    const [environment, operations] = await Promise.all([
      readFile(deploymentFile("noqori.env.example"), "utf8"),
      readFile(new URL("../docs/PRODUCTION_PROCESS_SUPERVISION.md", import.meta.url), "utf8")
    ]);

    assert.match(environment, /^WORKER_HEALTH_HOST=127\.0\.0\.1$/m);
    assert.match(environment, /^WORKER_HEALTH_PORT=3001$/m);
    assert.doesNotMatch(
      environment,
      /^(HOST|DATABASE_FILE_PATH|MIGRATIONS_MANAGED_EXTERNALLY|RENDERED_AUDIT_ENABLED|RENDERED_AUDIT_MAX_CONCURRENCY)=/m
    );
    assert.doesNotMatch(environment, /(ADMIN_API_KEY|PASSWORD|SECRET|TOKEN)=/i);

    for (const command of [
      "systemctl enable --now noqori.target",
      "systemctl start noqori.target",
      "systemctl stop noqori.target",
      "systemctl restart noqori.target",
      "systemctl status noqori-api.service noqori-worker.service",
      "journalctl -u noqori-api.service -u noqori-worker.service"
    ]) {
      assert.match(operations, new RegExp(command.replaceAll(".", "\\.")));
    }
    assert.match(operations, /\/var\/lib\/noqori\/sitepulse\.sqlite/);
    assert.match(operations, /STE-12/);
    assert.match(operations, /network namespace|egress proxy/i);
    assert.match(operations, /systemd-analyze verify/);
    assert.match(operations, /VM boot.*crash acceptance/i);
  });

  it("lets production services delegate migrations only when explicitly configured", () => {
    const defaultConfig = loadConfig({ NODE_ENV: "test", PORT: 0 });
    const managedConfig = loadConfig({
      NODE_ENV: "test",
      PORT: 0,
      MIGRATIONS_MANAGED_EXTERNALLY: "true"
    });

    assert.equal(defaultConfig.migrationsManagedExternally, false);
    assert.equal(managedConfig.migrationsManagedExternally, true);
  });

  it("does not run web-process migrations when the migration unit owns startup", () => {
    let migrations = 0;
    const config = loadConfig({
      NODE_ENV: "test",
      PORT: 0,
      MIGRATIONS_MANAGED_EXTERNALLY: "true"
    });

    createApp(config, {
      runMigrations() {
        migrations += 1;
      },
      startSessionCleanupScheduler() {
        return { stop() {} };
      }
    });

    assert.equal(migrations, 0);
  });

  it("provides one standalone migration entrypoint for supervised startup", () => {
    const directory = mkdtempSync(join(tmpdir(), "noqori-supervisor-migrate-"));
    const databaseFilePath = join(directory, "sitepulse.sqlite");

    try {
      const result = spawnSync(process.execPath, ["scripts/migrate.mjs"], {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, DATABASE_FILE_PATH: databaseFilePath, NODE_ENV: "test", PORT: "0" },
        encoding: "utf8"
      });

      assert.equal(result.status, 0, result.stderr);
      const database = new DatabaseSync(databaseFilePath);
      const versions = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
      database.close();
      assert.deepEqual(versions.map(({ version }) => version), [1, 2, 3, 4, 5]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports API readiness separately from process liveness", async () => {
    let ready = true;
    const config = loadConfig({
      NODE_ENV: "test",
      PORT: 0,
      MIGRATIONS_MANAGED_EXTERNALLY: "true"
    });
    const app = createApp(config, {
      readinessCheck: () => ({ ready }),
      startSessionCleanupScheduler: () => ({ stop() {} })
    });

    await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${app.address().port}`;

    try {
      const health = await fetch(`${baseUrl}/api/health`);
      const available = await fetch(`${baseUrl}/api/ready`);
      ready = false;
      const unavailable = await fetch(`${baseUrl}/api/ready`);
      ready = true;
      app.markStopping();
      const draining = await fetch(`${baseUrl}/api/ready`);
      const healthWhileDraining = await fetch(`${baseUrl}/api/health`);

      assert.equal(health.status, 200);
      assert.equal(available.status, 200);
      assert.equal((await available.json()).status, "ready");
      assert.equal(unavailable.status, 503);
      assert.equal((await unavailable.json()).status, "not-ready");
      assert.equal(draining.status, 503);
      assert.equal((await draining.json()).status, "stopping");
      assert.equal(healthWhileDraining.status, 200);
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  });

  it("keeps operational probes outside the public API rate limit", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      PORT: 0,
      MIGRATIONS_MANAGED_EXTERNALLY: "true",
      RATE_LIMIT_MAX: 2,
      RATE_LIMIT_WINDOW_MS: 60_000
    });
    const app = createApp(config, {
      readinessCheck: () => ({ ready: true }),
      startSessionCleanupScheduler: () => ({ stop() {} })
    });

    await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${app.address().port}`;

    try {
      for (let index = 0; index < 65; index += 1) {
        const pathname = index % 2 === 0 ? "/api/health" : "/api/ready";
        const response = await fetch(`${baseUrl}${pathname}`);
        assert.equal(response.status, 200);
      }

      assert.equal((await fetch(`${baseUrl}/api/missing`)).status, 404);
      assert.equal((await fetch(`${baseUrl}/api/missing`)).status, 404);
      assert.equal((await fetch(`${baseUrl}/api/missing`)).status, 429);
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  });

  it("reports worker liveness, readiness, and draining state independently", async () => {
    const { createWorkerHealthServer } = await import("../src/health/worker-health-server.mjs");
    let databaseReady = true;
    const healthServer = createWorkerHealthServer({
      host: "127.0.0.1",
      port: 0,
      readinessCheck: () => ({ ready: databaseReady }),
      workerSnapshot: () => ({ activeJob: false })
    });
    const address = await healthServer.start();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      healthServer.markReady();
      const health = await fetch(`${baseUrl}/healthz`);
      const ready = await fetch(`${baseUrl}/readyz`);
      databaseReady = false;
      const unavailable = await fetch(`${baseUrl}/readyz`);
      databaseReady = true;
      healthServer.markStopping();
      const draining = await fetch(`${baseUrl}/readyz`);

      assert.equal(health.status, 200);
      assert.equal((await health.json()).status, "alive");
      assert.equal(ready.status, 200);
      assert.equal((await ready.json()).status, "ready");
      assert.equal(unavailable.status, 503);
      assert.equal(draining.status, 503);
      assert.equal((await draining.json()).status, "stopping");
    } finally {
      await healthServer.close();
    }
  });

  it("keeps the worker health listener on a configurable loopback endpoint", () => {
    const defaults = loadConfig({ NODE_ENV: "test", PORT: 0 });
    const configured = loadConfig({
      NODE_ENV: "test",
      PORT: 0,
      WORKER_HEALTH_HOST: "::1",
      WORKER_HEALTH_PORT: "3101"
    });

    assert.equal(defaults.workerHealthHost, "127.0.0.1");
    assert.equal(defaults.workerHealthPort, 3001);
    assert.equal(configured.workerHealthHost, "::1");
    assert.equal(configured.workerHealthPort, 3101);
    assert.throws(
      () => loadConfig({ NODE_ENV: "test", PORT: 0, WORKER_HEALTH_HOST: "0.0.0.0" }),
      /WORKER_HEALTH_HOST/
    );
  });

  it("starts the real worker independently and exits cleanly on SIGTERM", async () => {
    const directory = mkdtempSync(join(tmpdir(), "noqori-supervised-worker-"));
    const databaseFilePath = join(directory, "sitepulse.sqlite");
    const healthPort = await availablePort();
    runMigrations(databaseFilePath);
    const child = spawn(process.execPath, ["worker.mjs"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: "0",
        DATABASE_FILE_PATH: databaseFilePath,
        MIGRATIONS_MANAGED_EXTERNALLY: "true",
        WORKER_HEALTH_PORT: String(healthPort),
        RENDERED_AUDIT_ENABLED: "false",
        TELEMETRY_ENABLED: "false"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    try {
      const ready = await waitForResponse(`http://127.0.0.1:${healthPort}/readyz`);
      assert.equal(ready.status, 200);
      child.kill("SIGTERM");
      const [code, signal] = await once(child, "exit");
      assert.equal(code, 0);
      assert.equal(signal, null);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("drains the real API process and exits cleanly on SIGTERM", async () => {
    const directory = mkdtempSync(join(tmpdir(), "noqori-supervised-api-"));
    const databaseFilePath = join(directory, "sitepulse.sqlite");
    const port = await availablePort();
    runMigrations(databaseFilePath);
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: String(port),
        PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
        DATABASE_FILE_PATH: databaseFilePath,
        MIGRATIONS_MANAGED_EXTERNALLY: "true",
        TELEMETRY_ENABLED: "false"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    try {
      const ready = await waitForResponse(`http://127.0.0.1:${port}/api/ready`);
      assert.equal(ready.status, 200);
      child.kill("SIGTERM");
      const [code, signal] = await once(child, "exit");
      assert.equal(code, 0);
      assert.equal(signal, null);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps API available and completes a persisted job in the queue crash-recovery harness", { timeout: 10_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "noqori-supervisor-restart-"));
    const databaseFilePath = join(directory, "sitepulse.sqlite");
    const crashMarker = join(directory, "worker-crashed-once");
    const apiPort = await availablePort();
    runMigrations(databaseFilePath);
    const job = seedOwnedJob(databaseFilePath);
    const api = spawn(process.execPath, ["server.mjs"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: String(apiPort),
        PUBLIC_ORIGIN: `http://127.0.0.1:${apiPort}`,
        DATABASE_FILE_PATH: databaseFilePath,
        MIGRATIONS_MANAGED_EXTERNALLY: "true",
        TELEMETRY_ENABLED: "false"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let activeWorkers = 0;
    let maximumActiveWorkers = 0;
    let workerStarts = 0;
    let worker;

    const launchWorker = () => {
      workerStarts += 1;
      activeWorkers += 1;
      maximumActiveWorkers = Math.max(maximumActiveWorkers, activeWorkers);
      worker = forkWorkerFixture({
        DATABASE_FILE_PATH: databaseFilePath,
        NOQORI_TEST_CRASH_MARKER: crashMarker
      });
      worker.once("exit", () => {
        activeWorkers -= 1;
      });
      return worker;
    };

    try {
      assert.equal((await waitForResponse(`http://127.0.0.1:${apiPort}/api/ready`)).status, 200);

      let reportCrash;
      const crashObserved = new Promise((resolve) => {
        reportCrash = resolve;
      });
      const supervisedExit = new Promise((resolve) => {
        const start = () => {
          const child = launchWorker();
          child.once("exit", (code, signal) => {
            if (code !== 0 && signal === null && workerStarts < 3) {
              reportCrash(code);
              start();
              return;
            }
            resolve({ code, signal });
          });
        };
        start();
      });

      const crashCode = await crashObserved;
      assert.equal(crashCode, 23);
      assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/health`)).status, 200);

      const replacementExit = await supervisedExit;
      assert.deepEqual(replacementExit, { code: 0, signal: null });

      const completedJob = createAuditJobStore(databaseFilePath).findById(job.id);
      const audit = await createAuditStore(databaseFilePath).findById(completedJob.auditId);
      assert.equal(completedJob.status, "completed");
      assert.equal(completedJob.attemptCount, 2);
      assert.equal(audit.domain, "example.com");
      assert.equal(workerStarts, 2);
      assert.equal(maximumActiveWorkers, 1);
    } finally {
      if (worker && worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGKILL");
        await once(worker, "exit");
      }
      if (api.exitCode === null && api.signalCode === null) {
        api.kill("SIGTERM");
        await once(api, "exit");
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lets an active job finish before a SIGTERM worker shutdown", { timeout: 5_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "noqori-supervisor-graceful-"));
    const databaseFilePath = join(directory, "sitepulse.sqlite");
    const crashMarker = join(directory, "unused-crash-marker");
    runMigrations(databaseFilePath);
    const job = seedOwnedJob(databaseFilePath);
    const worker = forkWorkerFixture({
      DATABASE_FILE_PATH: databaseFilePath,
      NOQORI_TEST_CRASH_MARKER: crashMarker,
      NOQORI_TEST_MODE: "graceful"
    });

    try {
      await waitForMessage(worker, "active");
      worker.kill("SIGTERM");
      const [code, signal] = await once(worker, "exit");
      assert.equal(code, 0);
      assert.equal(signal, null);

      const completedJob = createAuditJobStore(databaseFilePath).findById(job.id);
      assert.equal(completedJob.status, "completed");
      assert.equal(completedJob.attemptCount, 1);
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGKILL");
        await once(worker, "exit");
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
