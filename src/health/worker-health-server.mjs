import { createServer } from "node:http";

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

export function createWorkerHealthServer({
  host = "127.0.0.1",
  port = 3001,
  readinessCheck,
  workerSnapshot = () => ({ activeJob: false })
} = {}) {
  if (typeof readinessCheck !== "function") {
    throw new TypeError("Worker health server requires a readiness check.");
  }

  let ready = false;
  let stopping = false;
  let started = false;

  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;

    if (request.method !== "GET") {
      return sendJson(response, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });
    }

    if (pathname === "/healthz") {
      return sendJson(response, 200, {
        ok: true,
        service: "noqori-worker",
        status: stopping ? "stopping" : "alive"
      });
    }

    if (pathname === "/readyz") {
      let databaseReady = false;
      if (ready && !stopping) {
        try {
          databaseReady = (await readinessCheck())?.ready === true;
        } catch {
          databaseReady = false;
        }
      }

      const available = ready && !stopping && databaseReady;
      const status = stopping ? "stopping" : available ? "ready" : "not-ready";
      return sendJson(response, available ? 200 : 503, {
        ok: available,
        service: "noqori-worker",
        status,
        activeJob: workerSnapshot()?.activeJob === true
      });
    }

    return sendJson(response, 404, { ok: false, code: "NOT_FOUND" });
  });

  return {
    async start() {
      if (started) return server.address();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      started = true;
      return server.address();
    },
    markReady() {
      ready = true;
    },
    markStopping() {
      stopping = true;
      ready = false;
    },
    async close() {
      if (!started) return;
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      started = false;
    }
  };
}
