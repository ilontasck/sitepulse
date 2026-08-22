import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
  auditRunnerMaxRequestBytes,
  auditRunnerMaxResponseBytes,
  auditRunnerProtocolVersion,
  createAuditRunnerFrameReader,
  encodeAuditRunnerFrame,
  validateAuditErrorResponse,
  validateHelloResponse,
  validateAuditResponse
} from "./audit-runner-protocol.mjs";

export class AuditRunnerUnavailableError extends Error {
  constructor(code = "AUDIT_RUNNER_UNAVAILABLE", message = "The isolated audit runner is temporarily unavailable.", retryable = true) {
    super(message);
    this.name = "AuditRunnerUnavailableError";
    this.code = code;
    this.retryable = retryable;
  }
}

function exchange(socketPath, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let negotiated = false;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new AuditRunnerUnavailableError("AUDIT_RUNNER_TIMEOUT")),
      timeoutMs
    );
    timer.unref?.();

    const read = createAuditRunnerFrameReader({
      maximumBytes: auditRunnerMaxResponseBytes,
      onFrame(message) {
        if (!negotiated) {
          try {
            validateHelloResponse(message);
          } catch {
            finish(new AuditRunnerUnavailableError("AUDIT_RUNNER_PROTOCOL_MISMATCH"));
            return;
          }
          negotiated = true;
          if (!request) finish(null, {
            ready: true,
            protocolVersion: auditRunnerProtocolVersion,
            renderedAuditAllowed: message.capabilities.renderedAuditAllowed
          });
          else socket.write(encodeAuditRunnerFrame(request, auditRunnerMaxRequestBytes));
          return;
        }

        if (message?.type === "result") {
          try {
            finish(null, validateAuditResponse(message, request.requestId));
          } catch {
            finish(new AuditRunnerUnavailableError("AUDIT_RUNNER_PROTOCOL_MISMATCH"));
          }
        } else if (message?.type === "error") {
          try {
            const error = validateAuditErrorResponse(message, request.requestId);
            finish(new AuditRunnerUnavailableError(error.code, error.message, error.retryable));
          } catch {
            finish(new AuditRunnerUnavailableError("AUDIT_RUNNER_PROTOCOL_MISMATCH"));
          }
        } else {
          finish(new AuditRunnerUnavailableError("AUDIT_RUNNER_PROTOCOL_MISMATCH"));
        }
      },
      onError() {
        finish(new AuditRunnerUnavailableError("AUDIT_RUNNER_INVALID_RESPONSE"));
      }
    });

    socket.on("connect", () => {
      socket.write(encodeAuditRunnerFrame({
        protocolVersion: auditRunnerProtocolVersion,
        type: "hello"
      }, auditRunnerMaxRequestBytes));
    });
    socket.on("data", read);
    socket.on("error", () => finish(new AuditRunnerUnavailableError()));
    socket.on("close", () => {
      if (!settled) finish(new AuditRunnerUnavailableError());
    });
  });
}

export function createAuditRunnerClient({ socketPath, requestTimeoutMs = 60_000 } = {}) {
  if (!socketPath || typeof socketPath !== "string") {
    throw new TypeError("Audit runner client requires a pathname Unix socket.");
  }
  return {
    checkReadiness() {
      return exchange(socketPath, null, Math.min(requestTimeoutMs, 1_500));
    },
    generateAudit(normalizedUrl, options = {}) {
      return exchange(socketPath, {
        protocolVersion: auditRunnerProtocolVersion,
        type: "audit",
        requestId: randomUUID(),
        normalizedUrl,
        options: {
          renderedAuditEnabled: options.renderedAuditEnabled === true,
          ...(options.renderedAuditTimeoutMs ? { renderedAuditTimeoutMs: options.renderedAuditTimeoutMs } : {})
        }
      }, requestTimeoutMs);
    }
  };
}
