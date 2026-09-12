import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { evaluateAlerts, summarizeJournal } from "../src/telemetry/alert-conditions.mjs";

const run = promisify(execFile);
function port(value, fallback) {
  const number = Number(value || fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error("Invalid health port");
  return number;
}
async function read(url, headers = {}) {
  try {
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(6_000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

try {
  const api = `http://127.0.0.1:${port(process.env.PORT, 3000)}`;
  const workerHost = process.env.WORKER_HEALTH_HOST === "::1" ? "[::1]" : "127.0.0.1";
  const worker = `http://${workerHost}:${port(process.env.WORKER_HEALTH_PORT, 3001)}`;
  const [operations, apiHealth, workerHealth, journal] = await Promise.all([
    process.env.ADMIN_API_KEY ? read(`${api}/api/operations`, { "X-Admin-Key": process.env.ADMIN_API_KEY }) : null,
    read(`${api}/api/ready`), read(`${worker}/readyz`),
    run("journalctl", ["-u", "noqori-api.service", "-u", "noqori-worker.service", "--since", "15 minutes ago", "--output=cat", "--no-pager"],
      { timeout: 6_000, maxBuffer: 8 * 1024 * 1024 }).then(({ stdout }) => summarizeJournal(stdout)).catch(() => null)
  ]);
  const alerts = evaluateAlerts({ operations, apiReady: apiHealth?.ok === true, workerReady: workerHealth?.ok === true, journal });
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: alerts.length ? "error" : "info", event: "operations.alert_check", alerts }));
  process.exitCode = alerts.length ? 1 : 0;
} catch {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", event: "operations.alert_check", alerts: ["ALERT_CHECK_FAILED"] }));
  process.exitCode = 2;
}
