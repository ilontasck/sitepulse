import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { it } from "node:test";
import { fetchSafeHtml } from "../src/audit/url-safety.mjs";

it("enforces the HTML body deadline with native fetch", async (t) => {
  let sentHeaders;
  const headersSent = new Promise(resolve => { sentHeaders = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.write("<!doctype html>");
    sentHeaders();
    // Deliberately never end the body.
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const caller = new AbortController();
  const watchdog = setTimeout(() => caller.abort(new Error("test watchdog expired")), 2_000);
  t.after(() => clearTimeout(watchdog));
  let responseReceived = false;
  await assert.rejects(fetchSafeHtml("https://example.com", {
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    timeoutMs: 200,
    signal: caller.signal,
    // Only transport destination changes: body and abort behavior use native fetch.
    fetcher: async (_url, options) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}`, options);
      responseReceived = true;
      return response;
    }
  }), error => error.code === "SCAN_TIMEOUT" && error.statusCode === 504);
  await headersSent;
  assert.equal(responseReceived, true, "the timeout must occur after headers arrive");
  assert.equal(caller.signal.aborted, false, "the scanner deadline must fire before the watchdog");
});

for (const [name, headers, code] of [
  ["non-HTML", { "Content-Type": "application/json" }, "NON_HTML_RESPONSE"],
  ["oversized declared", { "Content-Type": "text/html", "Content-Length": "1000000" }, "HTML_TOO_LARGE"],
  ["oversized streamed", { "Content-Type": "text/html" }, "HTML_TOO_LARGE"]
]) {
  it(`closes a native fetch connection after rejecting a ${name} body`, async (t) => {
    let connectionClosed;
    const closed = new Promise(resolve => { connectionClosed = resolve; });
    const server = createServer((_request, response) => {
      response.on("close", connectionClosed);
      response.writeHead(200, headers);
      response.write("x".repeat(100));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });
    await assert.rejects(fetchSafeHtml("https://example.com", {
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      maxHtmlBytes: 10,
      fetcher: (_url, options) => fetch(`http://127.0.0.1:${server.address().port}`, options)
    }), error => error.code === code);
    let watchdog;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          watchdog = setTimeout(() => reject(new Error("rejected response connection stayed open")), 1_000);
        })
      ]);
    } finally {
      clearTimeout(watchdog);
    }
  });
}
