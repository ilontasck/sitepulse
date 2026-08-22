import { randomUUID } from "node:crypto";
import { chmodSync, chownSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createAuditJobStore } from "../src/storage/audit-job-store.mjs";
import { withDatabase } from "../src/storage/sqlite-database.mjs";
import { loadBrowserSandboxAttestation } from "../src/production/browser-sandbox-attestation.mjs";
import { browserSandboxAttestationPath } from "../src/production/browser-sandbox-policy.mjs";

const databasePath = "/var/lib/noqori/sitepulse.sqlite";
const resultPath = "/var/lib/noqori/browser-sandbox-queue-result.json";
const slowUrl = process.env.NOQORI_SLOW_HTML_URL;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function systemctl(...args) {
  const result = spawnSync("systemctl", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error("VM_ACCEPTANCE_SYSTEMD_FAILED");
  return result.stdout.trim();
}
async function waitFor(read, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (accept(value)) return value;
    await delay(250);
  }
  throw new Error("VM_ACCEPTANCE_TIMEOUT");
}
function writeRootResult(value) {
  const temporary = `${resultPath}.${process.pid}.${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o440 });
  chownSync(temporary, 0, 0);
  chmodSync(temporary, 0o440);
  renameSync(temporary, resultPath);
}

if (process.platform !== "linux" || process.getuid?.() !== 0 || !slowUrl) {
  console.error("WORKER_CRASH_ACCEPTANCE_REQUIRES_ROOT_LINUX_AND_SLOW_URL");
  process.exitCode = 2;
} else {
  try {
    const attestation = loadBrowserSandboxAttestation();
    if (!attestation.valid) throw new Error("VM_ACCEPTANCE_ATTESTATION_INVALID");
    const namespaceInodeBefore = attestation.namespaceInode;
    const activeJobs = withDatabase(databasePath, (database) => database.prepare(
      "SELECT count(*) AS count FROM audit_jobs WHERE status IN ('queued', 'running')"
    ).get().count);
    if (activeJobs !== 0) throw new Error("VM_ACCEPTANCE_QUEUE_NOT_IDLE");
    const apiBefore = await fetch("http://127.0.0.1:3000/api/ready");
    if (!apiBefore.ok) throw new Error("VM_ACCEPTANCE_API_NOT_READY");

    systemctl("stop", "noqori-worker.service");
    const userId = randomUUID();
    const now = new Date().toISOString();
    withDatabase(databasePath, (database) => database.prepare(`
      INSERT INTO users (id, email_original, email_normalized, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, `acceptance-${userId}@example.invalid`, `acceptance-${userId}@example.invalid`, "x".repeat(64), now, now));
    const jobStore = createAuditJobStore(databasePath);
    const job = jobStore.enqueue({ normalizedUrl: slowUrl, userId });

    systemctl("start", "noqori-worker.service");
    const firstAttempt = await waitFor(
      () => jobStore.findById(job.id),
      (candidate) => candidate?.status === "running" && candidate.attemptCount === 1,
      30_000
    );
    const firstWorkerId = firstAttempt.workerId;
    const firstPid = Number(systemctl("show", "noqori-worker.service", "--property=MainPID", "--value"));
    if (!Number.isSafeInteger(firstPid) || firstPid <= 1) throw new Error("VM_ACCEPTANCE_WORKER_PID_INVALID");
    systemctl("kill", "--kill-whom=main", "--signal=SIGKILL", "noqori-worker.service");
    const replacementPid = await waitFor(
      () => Number(systemctl("show", "noqori-worker.service", "--property=MainPID", "--value")),
      (pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== firstPid,
      30_000
    );
    const completed = await waitFor(
      () => jobStore.findById(job.id),
      (candidate) => candidate?.status === "completed",
      150_000
    );
    if (completed.attemptCount !== 2 || !completed.auditId) throw new Error("VM_ACCEPTANCE_RECOVERY_INVALID");
    const persisted = withDatabase(databasePath, (database) => database.prepare(`
      SELECT count(*) AS count
      FROM audits
      WHERE id = ? AND user_id = ?
    `).get(completed.auditId, userId).count);
    if (persisted !== 1) throw new Error("VM_ACCEPTANCE_FENCING_INVALID");
    if (systemctl("is-active", "noqori-worker.service") !== "active") throw new Error("VM_ACCEPTANCE_WORKER_INACTIVE");
    const workerControlGroup = systemctl("show", "noqori-worker.service", "--property=ControlGroup", "--value");
    const workerProcessCount = readFileSync(`/sys/fs/cgroup${workerControlGroup}/cgroup.procs`, "utf8").trim().split("\n").filter(Boolean).length;
    if (workerProcessCount !== 1) throw new Error("VM_ACCEPTANCE_MULTIPLE_WORKERS");
    const apiAfter = await fetch("http://127.0.0.1:3000/api/ready");
    if (!apiAfter.ok) throw new Error("VM_ACCEPTANCE_API_STOPPED");
    const attestationAfter = loadBrowserSandboxAttestation();
    if (!attestationAfter.valid || attestationAfter.namespaceInode !== namespaceInodeBefore) {
      throw new Error("VM_ACCEPTANCE_SANDBOX_CHANGED_DURING_WORKER_RESTART");
    }
    const current = JSON.parse(readFileSync(browserSandboxAttestationPath, "utf8"));
    writeRootResult({
      schemaVersion: 1,
      configHash: current.configHash,
      bundleHash: current.bundleHash,
      platformHash: current.platformHash,
      bootId: current.bootId,
      jobId: job.id,
      firstWorkerId,
      replacementPid,
      workerProcessCount,
      namespaceInode: namespaceInodeBefore,
      attemptCount: completed.attemptCount,
      auditId: completed.auditId,
      completedAt: new Date().toISOString()
    });
    console.log("WORKER CRASH/LEASE/FENCING VM ACCEPTANCE: PASS");
  } catch (error) {
    console.error(error?.message?.startsWith("VM_ACCEPTANCE_") ? error.message : "WORKER_CRASH_ACCEPTANCE_FAILED");
    process.exitCode = 1;
  }
}
