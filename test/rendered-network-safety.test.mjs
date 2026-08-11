import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSafeRouteHandler, createSafeWebSocketHandler } from "../src/audit/scanners/rendered-network-safety.mjs";

function fakeRoute(url) {
  const calls = [];

  return {
    calls,
    request: () => ({ url: () => url }),
    continue: async () => calls.push("continue"),
    abort: async (reason) => calls.push(`abort:${reason}`)
  };
}

describe("rendered browser network safety", () => {
  it("allows browser-internal and public requests", async () => {
    const handler = createSafeRouteHandler({ resolver: async () => [{ address: "93.184.216.34", family: 4 }] });
    const dataRoute = fakeRoute("data:text/plain,ok");
    const publicRoute = fakeRoute("https://example.com/app.js");

    await handler(dataRoute);
    await handler(publicRoute);

    assert.deepEqual(dataRoute.calls, ["continue"]);
    assert.deepEqual(publicRoute.calls, ["continue"]);
  });

  it("blocks private main requests, redirects, and subresources", async () => {
    let blocked = 0;
    const handler = createSafeRouteHandler({
      resolver: async () => [{ address: "127.0.0.1", family: 4 }],
      onBlocked: () => {
        blocked += 1;
      }
    });
    const route = fakeRoute("https://private.example/admin");

    await handler(route);

    assert.deepEqual(route.calls, ["abort:addressunreachable"]);
    assert.equal(blocked, 1);
  });

  it("applies the same destination policy to WebSockets", async () => {
    const calls = [];
    const handler = createSafeWebSocketHandler({ resolver: async () => [{ address: "10.0.0.8", family: 4 }] });

    await handler({
      url: () => "wss://private.example/socket",
      connectToServer: async () => calls.push("connect"),
      close: async ({ code }) => calls.push(`close:${code}`)
    });

    assert.deepEqual(calls, ["close:1008"]);
  });
});
