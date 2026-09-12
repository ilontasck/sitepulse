import { createAuditTelemetry } from "../telemetry/audit-telemetry.mjs";
import { withLogContext } from "../telemetry/log-context.mjs";
import { createServer } from "node:net";
import { classifyAuditFailure } from "./audit-failure-classifier.mjs";
import {
  auditRunnerMaxRequestBytes,
  auditRunnerMaxResponseBytes,
  auditRunnerProtocolVersion,
  createAuditRunnerFrameReader,
  encodeAuditRunnerFrame,
  validateAuditRequest,
  validateHelloRequest
} from "./audit-runner-protocol.mjs";

function safeError(error) {
  const publicProtocolCodes = new Set([
    "AUDIT_RUNNER_INVALID_REQUEST",
    "AUDIT_RUNNER_MALFORMED_PAYLOAD",
    "AUDIT_RUNNER_PAYLOAD_TOO_LARGE",
    "AUDIT_RUNNER_PROTOCOL_MISMATCH"
  ]);
  if (publicProtocolCodes.has(error?.code)) {
    return {
      code: error.code,
      message: "The audit runner rejected an invalid request.",
      retryable: false
    };
  }
  if (error?.code === "AUDIT_RUNNER_BUSY") {
    return { code: error.code, message: "The audit runner is currently busy.", retryable: true };
  }
  if (error?.code === "RENDERED_AUDIT_NOT_ACCEPTED") {
    return {
      code: error.code,
      message: "Rendered auditing is not available on this deployment.",
      retryable: false
    };
  }
  const failure = classifyAuditFailure(error, { phase: "worker" });
  return {
    code: failure.code,
    message: failure.message,
    retryable: failure.disposition === "retry"
  };
}

export function createAuditRunnerServer({
  socketPath,
  listenFd,
  auditGenerator,
  renderedAuditAllowed = false,
  telemetry = createAuditTelemetry(),
  connectionIdleTimeoutMs = 2_000
}) {
  if (typeof auditGenerator !== "function") {
    throw new TypeError("Audit runner server requires an audit generator.");
  }

  let activeRequest = false;
  let started = false;
  const sockets = new Set();

  const server = createServer((socket) => {
    sockets.add(socket);
    let negotiated = false;
    let activeController;
    let handlingFrame = false;

    socket.setTimeout(connectionIdleTimeoutMs);
    socket.on("timeout", () => socket.destroy());
    socket.on("error", () => {
      activeController?.abort(new Error("Audit runner client connection failed."));
      socket.destroy();
    });

    const send = (message) => {
      if (!socket.destroyed) {
        socket.write(encodeAuditRunnerFrame(message, auditRunnerMaxResponseBytes));
      }
    };

    const fail = (error, requestId = null) => {
      send({
        protocolVersion: auditRunnerProtocolVersion,
        type: "error",
        requestId,
        error: safeError(error)
      });
      socket.end();
    };

    const onFrame = async (message) => {
      if (handlingFrame) {
        fail(Object.assign(new Error("multiple frames"), { code: "AUDIT_RUNNER_INVALID_REQUEST" }), message?.requestId || null);
        return;
      }
      handlingFrame = true;
      try {
        if (!negotiated) {
          validateHelloRequest(message);
          negotiated = true;
          send({
            protocolVersion: auditRunnerProtocolVersion,
            type: "hello",
            capabilities: { renderedAuditAllowed }
          });
          handlingFrame = false;
          return;
        }

        const request = validateAuditRequest(message);
        socket.setTimeout(0);
        if (request.options.renderedAuditEnabled && !renderedAuditAllowed) {
          const unavailable = new Error("Rendered audit acceptance is missing.");
          unavailable.code = "RENDERED_AUDIT_NOT_ACCEPTED";
          fail(unavailable, request.requestId);
          return;
        }
        if (activeRequest) {
          const busy = new Error("busy");
          busy.code = "AUDIT_RUNNER_BUSY";
          fail(busy, request.requestId);
          return;
        }

        activeRequest = true;
        activeController = new AbortController();
        try {
          const audit = await withLogContext({ jobId: request.requestId, requestId: request.correlation?.requestId,
            auditMode: request.options.renderedAuditEnabled ? "rendered" : "basic" }, async () => {
            const started = performance.now();
            telemetry.record("runner.started", { durationMs: 0 });
            try {
              const result = await auditGenerator(request.normalizedUrl, {
                ...request.options, telemetry, signal: activeController.signal
              });
              telemetry.record("runner.completed", { durationMs: Math.round(performance.now() - started) });
              return result;
            } catch (error) {
              telemetry.record("runner.failed", { phase: "generate", errorCode: safeError(error).code,
                durationMs: Math.round(performance.now() - started) });
              throw error;
            }
          });
          send({
            protocolVersion: auditRunnerProtocolVersion,
            type: "result",
            requestId: request.requestId,
            audit
          });
          socket.end();
        } catch (error) {
          fail(error, request.requestId);
        } finally {
          activeController = undefined;
          activeRequest = false;
        }
      } catch (error) {
        fail(error, message?.requestId || null);
      } finally {
        handlingFrame = false;
      }
    };

    const read = createAuditRunnerFrameReader({
      maximumBytes: auditRunnerMaxRequestBytes,
      onFrame,
      onError: fail
    });
    socket.on("data", read);
    const abortActiveRequest = () => {
      activeController?.abort(new Error("Audit runner client disconnected."));
    };
    socket.on("end", () => {
      read.end();
      abortActiveRequest();
    });
    socket.on("close", () => {
      sockets.delete(socket);
      abortActiveRequest();
    });
  });

  return {
    async start() {
      if (started) return;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        const options = Number.isInteger(listenFd) ? { fd: listenFd } : { path: socketPath };
        server.listen(options, () => {
          server.removeListener("error", reject);
          started = true;
          resolve();
        });
      });
    },
    async close() {
      if (!started) return;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      started = false;
    },
    snapshot() {
      return { activeRequest };
    }
  };
}
