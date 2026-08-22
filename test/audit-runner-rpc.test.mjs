import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer as createNetServer } from "node:net";
import { describe, it } from "node:test";
import { createAuditRunnerClient } from "../src/audit/audit-runner-client.mjs";
import { createAuditRunnerServer } from "../src/audit/audit-runner-server.mjs";
import { auditRunnerMaxRequestBytes } from "../src/audit/audit-runner-protocol.mjs";

describe("audit runner Unix RPC", () => {
  it("negotiates protocol v1 and returns the audit for the same request ID", async () => {
    const directory = mkdtempSync(join(tmpdir(), "noqori-runner-rpc-"));
    const socketPath = join(directory, "audit.sock");
    const server = createAuditRunnerServer({
      socketPath,
      auditGenerator: async (normalizedUrl) => ({
        id: "runner-audit",
        normalizedUrl,
        overallScore: 91
      })
    });

    try {
      await server.start();
      const client = createAuditRunnerClient({ socketPath, requestTimeoutMs: 1_000 });

      assert.deepEqual(await client.checkReadiness(), {
        ready: true,
        protocolVersion: 1,
        renderedAuditAllowed: false
      });

      const result = await client.generateAudit("https://example.com", {
        renderedAuditEnabled: false
      });

      assert.equal(result.normalizedUrl, "https://example.com");
      assert.equal(result.overallScore, 91);
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a malformed audit envelope without reflecting untrusted data", async () => {
    const directory = mkdtempSync(join(tmpdir(), "noqori-runner-rpc-"));
    const socketPath = join(directory, "audit.sock");
    const server = createAuditRunnerServer({ socketPath, auditGenerator: async () => ({ ok: true }) });

    try {
      await server.start();
      const response = await new Promise((resolve, reject) => {
        const socket = createConnection({ path: socketPath });
        let buffer = "";
        socket.on("connect", () => socket.write('{"protocolVersion":1,"type":"hello"}\n'));
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          const frames = buffer.trim().split("\n").map((line) => JSON.parse(line));
          if (frames.length === 1) {
            socket.write('{"protocolVersion":1,"type":"audit","requestId":"request-1","normalizedUrl":"https://example.com","options":{},"secret":"do-not-reflect"}\n');
          } else {
            resolve(frames[1]);
            socket.destroy();
          }
        });
        socket.on("error", reject);
      });

      assert.equal(response.type, "error");
      assert.equal(response.requestId, "request-1");
      assert.equal(response.error.code, "AUDIT_RUNNER_INVALID_REQUEST");
      assert.doesNotMatch(JSON.stringify(response), /do-not-reflect/);
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a result envelope containing unapproved internal fields", async () => {
    const directory = mkdtempSync(join(tmpdir(), "noqori-runner-rpc-"));
    const socketPath = join(directory, "audit.sock");
    const fakeRunner = createNetServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines.filter(Boolean)) {
          const request = JSON.parse(line);
          if (request.type === "hello") {
          socket.write('{"protocolVersion":1,"type":"hello","capabilities":{"renderedAuditAllowed":false}}\n');
          } else {
            socket.write(`${JSON.stringify({
              protocolVersion: 1,
              type: "result",
              requestId: request.requestId,
              audit: {},
              workerId: "must-not-cross-boundary"
            })}\n`);
          }
        }
      });
    });

    try {
      await new Promise((resolve, reject) => {
        fakeRunner.once("error", reject);
        fakeRunner.listen(socketPath, resolve);
      });
      const client = createAuditRunnerClient({
        socketPath,
        requestTimeoutMs: 1_000
      });

      await assert.rejects(
        client.generateAudit("https://example.com"),
        (error) => error?.code === "AUDIT_RUNNER_PROTOCOL_MISMATCH" && !error.message.includes("workerId")
      );
    } finally {
      await new Promise((resolve) => fakeRunner.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("cancels the active audit when the worker request times out", async () => {
    const directory = mkdtempSync(join(tmpdir(), "noqori-runner-rpc-"));
    const socketPath = join(directory, "audit.sock");
    let aborted = false;
    const server = createAuditRunnerServer({
      socketPath,
      auditGenerator: async (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      })
    });

    try {
      await server.start();
      const client = createAuditRunnerClient({ socketPath, requestTimeoutMs: 25 });

      await assert.rejects(
        client.generateAudit("https://example.com"),
        (error) => error?.code === "AUDIT_RUNNER_TIMEOUT"
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.equal(aborted, true);
      assert.deepEqual(server.snapshot(), { activeRequest: false });
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("cancels the active audit when the client half-closes its connection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "noqori-runner-rpc-"));
    const socketPath = join(directory, "audit.sock");
    let markAborted;
    const aborted = new Promise((resolve) => { markAborted = resolve; });
    const server = createAuditRunnerServer({
      socketPath,
      auditGenerator: async (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          markAborted();
          reject(signal.reason);
        }, { once: true });
      })
    });

    try {
      await server.start();
      const socket = createConnection({ path: socketPath });
      let buffer = "";
      await new Promise((resolve, reject) => {
        socket.on("connect", () => socket.write('{"protocolVersion":1,"type":"hello"}\n'));
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          if (!buffer.includes("\n")) return;
          socket.end('{"protocolVersion":1,"type":"audit","requestId":"00000000-0000-4000-8000-000000000001","normalizedUrl":"https://example.com","options":{"renderedAuditEnabled":false}}\n');
          resolve();
        });
        socket.on("error", reject);
      });

      await Promise.race([
        aborted,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Audit was not cancelled.")), 250))
      ]);
      while (server.snapshot().activeRequest) await new Promise((resolve) => setTimeout(resolve, 1));
      assert.deepEqual(server.snapshot(), { activeRequest: false });
      socket.destroy();
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serves at most one audit and rejects excess work without a queue", async () => {
    const directory = mkdtempSync(join(tmpdir(), "noqori-runner-rpc-"));
    const socketPath = join(directory, "audit.sock");
    let releaseFirst;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const server = createAuditRunnerServer({
      socketPath,
      auditGenerator: async () => {
        calls += 1;
        if (calls === 1) await firstBlocked;
        return { id: `audit-${calls}` };
      }
    });

    try {
      await server.start();
      const client = createAuditRunnerClient({ socketPath, requestTimeoutMs: 1_000 });
      const first = client.generateAudit("https://example.com");
      while (!server.snapshot().activeRequest) await new Promise((resolve) => setTimeout(resolve, 1));

      await assert.rejects(
        client.generateAudit("https://example.org"),
        (error) => error?.code === "AUDIT_RUNNER_BUSY"
      );
      assert.equal(calls, 1);

      releaseFirst();
      assert.equal((await first).id, "audit-1");
    } finally {
      releaseFirst?.();
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a truncated frame without taking the runner out of service", async () => {
    const directory = mkdtempSync(join(tmpdir(), "noqori-runner-rpc-"));
    const socketPath = join(directory, "audit.sock");
    const server = createAuditRunnerServer({ socketPath, auditGenerator: async () => ({ ok: true }) });

    try {
      await server.start();
      const response = await new Promise((resolve, reject) => {
        const socket = createConnection({ path: socketPath, allowHalfOpen: true });
        const timer = setTimeout(() => reject(new Error("Runner did not reject the truncated frame.")), 250);
        let payload = "";
        socket.on("connect", () => socket.end('{"protocolVersion":1,"type":"hello"'));
        socket.on("data", (chunk) => { payload += chunk.toString("utf8"); });
        socket.on("end", () => {
          clearTimeout(timer);
          resolve(JSON.parse(payload.trim()));
        });
        socket.on("error", reject);
      });

      assert.equal(response.type, "error");
      assert.equal(response.error.code, "AUDIT_RUNNER_MALFORMED_PAYLOAD");
      assert.equal((await createAuditRunnerClient({ socketPath }).checkReadiness()).ready, true);
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds oversized request payloads and does not execute them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "noqori-runner-rpc-"));
    const socketPath = join(directory, "audit.sock");
    let calls = 0;
    const server = createAuditRunnerServer({ socketPath, auditGenerator: async () => { calls += 1; return {}; } });
    try {
      await server.start();
      const response = await new Promise((resolve, reject) => {
        const socket = createConnection({ path: socketPath });
        let payload = "";
        socket.on("connect", () => socket.write("x".repeat(auditRunnerMaxRequestBytes + 1)));
        socket.on("data", (chunk) => { payload += chunk.toString("utf8"); });
        socket.on("end", () => resolve(JSON.parse(payload.trim())));
        socket.on("error", reject);
      });
      assert.equal(response.error.code, "AUDIT_RUNNER_PAYLOAD_TOO_LARGE");
      assert.equal(calls, 0);
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects rendered work at the runner boundary until VM acceptance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "noqori-runner-rpc-"));
    const socketPath = join(directory, "audit.sock");
    let calls = 0;
    const server = createAuditRunnerServer({
      socketPath,
      renderedAuditAllowed: false,
      auditGenerator: async () => { calls += 1; return {}; }
    });
    try {
      await server.start();
      const client = createAuditRunnerClient({ socketPath, requestTimeoutMs: 1_000 });
      await assert.rejects(
        client.generateAudit("https://example.com", { renderedAuditEnabled: true }),
        (error) => error?.code === "RENDERED_AUDIT_NOT_ACCEPTED" && error.retryable === false
      );
      assert.equal(calls, 0);
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves safe terminal and retryable classifications across RPC", async () => {
    const directory = mkdtempSync(join(tmpdir(), "noqori-runner-rpc-"));
    const socketPath = join(directory, "audit.sock");
    let failure = Object.assign(new Error("secret internal destination"), { code: "UNSAFE_REDIRECT" });
    const server = createAuditRunnerServer({
      socketPath,
      auditGenerator: async () => { throw failure; }
    });
    try {
      await server.start();
      const client = createAuditRunnerClient({ socketPath, requestTimeoutMs: 1_000 });
      await assert.rejects(
        client.generateAudit("https://example.com"),
        (error) => error?.code === "UNSAFE_REDIRECT" &&
          error.retryable === false &&
          !error.message.includes("secret")
      );
      failure = Object.assign(new Error("secret upstream details"), { code: "ETIMEDOUT" });
      await assert.rejects(
        client.generateAudit("https://example.com"),
        (error) => error?.code === "ETIMEDOUT" && error.retryable === true && !error.message.includes("secret")
      );
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("strictly validates hello responses and closes idle handshakes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "noqori-runner-rpc-"));
    const socketPath = join(directory, "audit.sock");
    const fakeRunner = createNetServer((socket) => {
      socket.once("data", () => socket.end('{"protocolVersion":1,"type":"hello","capabilities":{"renderedAuditAllowed":false},"extra":true}\n'));
    });
    try {
      await new Promise((resolve, reject) => {
        fakeRunner.once("error", reject);
        fakeRunner.listen(socketPath, resolve);
      });
      await assert.rejects(
        createAuditRunnerClient({ socketPath, requestTimeoutMs: 250 }).checkReadiness(),
        (error) => error?.code === "AUDIT_RUNNER_PROTOCOL_MISMATCH"
      );
    } finally {
      await new Promise((resolve) => fakeRunner.close(resolve));
    }

    const serverSocketPath = join(directory, "idle.sock");
    const server = createAuditRunnerServer({
      socketPath: serverSocketPath,
      connectionIdleTimeoutMs: 25,
      auditGenerator: async () => ({ ok: true })
    });
    try {
      await server.start();
      await new Promise((resolve, reject) => {
        const socket = createConnection({ path: serverSocketPath });
        const timer = setTimeout(() => reject(new Error("Idle runner connection remained open.")), 250);
        socket.on("close", () => { clearTimeout(timer); resolve(); });
        socket.on("error", reject);
      });
      assert.equal((await createAuditRunnerClient({ socketPath: serverSocketPath }).checkReadiness()).ready, true);
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
