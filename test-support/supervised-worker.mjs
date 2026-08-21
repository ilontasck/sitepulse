import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createAuditJobWorker } from "../src/audit/audit-job-worker.mjs";
import { createAuditJobStore } from "../src/storage/audit-job-store.mjs";

const databaseFilePath = process.env.DATABASE_FILE_PATH;
const crashMarker = process.env.NOQORI_TEST_CRASH_MARKER;
const mode = process.env.NOQORI_TEST_MODE || "crash-once";

if (!databaseFilePath || !crashMarker) {
  throw new Error("The supervised worker fixture requires isolated test paths.");
}

let worker;
const auditGenerator = async () => {
  if (mode === "graceful") {
    await new Promise((resolve) => {
      if (typeof process.send === "function") {
        process.send({ type: "active", pid: process.pid }, resolve);
      } else {
        resolve();
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    return {
      normalizedUrl: "https://example.com",
      domain: "example.com",
      overallScore: 82,
      categories: [],
      scanner: { mode: "html-real-checks", adapters: ["supervision-fixture"] }
    };
  }

  if (!existsSync(crashMarker)) {
    writeFileSync(crashMarker, "crashed\n", { mode: 0o600 });
    await new Promise((resolve) => {
      if (typeof process.send === "function") {
        process.send({ type: "crashing", pid: process.pid }, resolve);
      } else {
        resolve();
      }
    });
    process.exit(23);
  }

  worker.stop();
  return {
    normalizedUrl: "https://example.com",
    domain: "example.com",
    overallScore: 82,
    categories: [],
    scanner: { mode: "html-real-checks", adapters: ["supervision-fixture"] }
  };
};

worker = createAuditJobWorker({
  jobStore: createAuditJobStore(databaseFilePath),
  auditGenerator,
  securityValidator: async () => true,
  renderedAuditLimiter: { run: (task) => task() },
  telemetry: { record() {} },
  workerId: randomUUID(),
  leaseMs: 300,
  heartbeatMs: 100,
  pollIntervalMs: 25
});

const requestShutdown = () => worker.stop();
process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

try {
  const result = await worker.run();
  if (typeof process.send === "function") {
    process.send({ type: "stopped", pid: process.pid, result });
  }
} finally {
  process.removeListener("SIGINT", requestShutdown);
  process.removeListener("SIGTERM", requestShutdown);
}
