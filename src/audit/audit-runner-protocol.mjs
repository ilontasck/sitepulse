export const auditRunnerProtocolVersion = 1;
export const auditRunnerMaxRequestBytes = 16 * 1024;
export const auditRunnerMaxResponseBytes = 4 * 1024 * 1024;

export class AuditRunnerProtocolError extends Error {
  constructor(code, message = "The audit runner rejected an invalid request.") {
    super(message);
    this.name = "AuditRunnerProtocolError";
    this.code = code;
  }
}

export function encodeAuditRunnerFrame(value, maximumBytes) {
  const payload = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(payload) > maximumBytes) {
    throw new AuditRunnerProtocolError("AUDIT_RUNNER_PAYLOAD_TOO_LARGE");
  }
  return payload;
}

export function createAuditRunnerFrameReader({ maximumBytes, onFrame, onError }) {
  let buffer = Buffer.alloc(0);
  let failed = false;

  const read = (chunk) => {
    if (failed) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.byteLength > maximumBytes) {
      failed = true;
      onError(new AuditRunnerProtocolError("AUDIT_RUNNER_PAYLOAD_TOO_LARGE"));
      return;
    }

    while (true) {
      const delimiter = buffer.indexOf(0x0a);
      if (delimiter === -1) return;
      const frame = buffer.subarray(0, delimiter);
      buffer = buffer.subarray(delimiter + 1);
      if (frame.byteLength === 0) continue;
      try {
        onFrame(JSON.parse(frame.toString("utf8")));
      } catch {
        failed = true;
        onError(new AuditRunnerProtocolError("AUDIT_RUNNER_MALFORMED_PAYLOAD"));
        return;
      }
    }
  };
  read.end = () => {
    if (!failed && buffer.byteLength > 0) {
      failed = true;
      onError(new AuditRunnerProtocolError("AUDIT_RUNNER_MALFORMED_PAYLOAD"));
    }
  };
  return read;
}

export function validateHelloRequest(message) {
  const keys = Object.keys(message || {}).sort();
  if (
    keys.join(",") !== "protocolVersion,type" ||
    message.type !== "hello" ||
    message.protocolVersion !== auditRunnerProtocolVersion
  ) {
    throw new AuditRunnerProtocolError("AUDIT_RUNNER_PROTOCOL_MISMATCH");
  }
  return message;
}

export function validateHelloResponse(message) {
  const keys = Object.keys(message || {}).sort();
  const capabilityKeys = Object.keys(message?.capabilities || {}).sort();
  if (
    keys.join(",") !== "capabilities,protocolVersion,type" ||
    capabilityKeys.join(",") !== "renderedAuditAllowed" ||
    message.type !== "hello" ||
    message.protocolVersion !== auditRunnerProtocolVersion ||
    typeof message.capabilities.renderedAuditAllowed !== "boolean"
  ) {
    throw new AuditRunnerProtocolError("AUDIT_RUNNER_PROTOCOL_MISMATCH");
  }
  return message;
}

export function validateAuditRequest(message) {
  const keys = Object.keys(message || {}).sort();
  const optionKeys = Object.keys(message?.options || {}).sort();
  if (
    keys.join(",") !== "normalizedUrl,options,protocolVersion,requestId,type" ||
    optionKeys.some((key) => !["renderedAuditEnabled", "renderedAuditTimeoutMs"].includes(key)) ||
    message.type !== "audit" ||
    message.protocolVersion !== auditRunnerProtocolVersion ||
    typeof message.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(message.requestId) ||
    typeof message.normalizedUrl !== "string" ||
    message.normalizedUrl.length < 1 ||
    !message.options ||
    typeof message.options !== "object" ||
    Array.isArray(message.options) ||
    typeof message.options.renderedAuditEnabled !== "boolean" ||
    (message.options.renderedAuditTimeoutMs !== undefined &&
      (!Number.isSafeInteger(message.options.renderedAuditTimeoutMs) || message.options.renderedAuditTimeoutMs < 1 || message.options.renderedAuditTimeoutMs > 120_000))
  ) {
    throw new AuditRunnerProtocolError("AUDIT_RUNNER_INVALID_REQUEST");
  }
  return message;
}

export function validateAuditErrorResponse(message, requestId) {
  const keys = Object.keys(message || {}).sort().join(",");
  const errorKeys = Object.keys(message?.error || {}).sort().join(",");
  if (
    keys !== "error,protocolVersion,requestId,type" ||
    errorKeys !== "code,message,retryable" ||
    message.type !== "error" ||
    message.protocolVersion !== auditRunnerProtocolVersion ||
    message.requestId !== requestId ||
    typeof message.error.code !== "string" ||
    typeof message.error.message !== "string" ||
    typeof message.error.retryable !== "boolean"
  ) throw new AuditRunnerProtocolError("AUDIT_RUNNER_PROTOCOL_MISMATCH");
  return message.error;
}

export function validateAuditResponse(message, requestId) {
  const keys = Object.keys(message || {}).sort().join(",");
  if (
    keys !== "audit,protocolVersion,requestId,type" ||
    message.type !== "result" ||
    message.protocolVersion !== auditRunnerProtocolVersion ||
    message.requestId !== requestId ||
    !message.audit ||
    typeof message.audit !== "object" ||
    Array.isArray(message.audit)
  ) {
    throw new AuditRunnerProtocolError("AUDIT_RUNNER_PROTOCOL_MISMATCH");
  }
  return message.audit;
}
