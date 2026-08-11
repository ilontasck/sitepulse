import { assertSafeUrl } from "../url-safety.mjs";

const browserInternalProtocols = new Set(["about:", "blob:", "data:", "chrome:", "devtools:"]);

export function createSafeRouteHandler(options = {}) {
  return async function handleRoute(route) {
    const requestUrl = new URL(route.request().url());

    if (browserInternalProtocols.has(requestUrl.protocol)) {
      return route.continue();
    }

    try {
      await assertSafeUrl(requestUrl, options);
      return route.continue();
    } catch {
      options.onBlocked?.(requestUrl.toString());
      return route.abort("addressunreachable");
    }
  };
}

export function createSafeWebSocketHandler(options = {}) {
  return async function handleWebSocket(webSocketRoute) {
    const socketUrl = new URL(webSocketRoute.url());
    socketUrl.protocol = socketUrl.protocol === "wss:" ? "https:" : "http:";

    try {
      await assertSafeUrl(socketUrl, options);
      await webSocketRoute.connectToServer();
    } catch {
      options.onBlocked?.(webSocketRoute.url());
      await webSocketRoute.close({ code: 1008, reason: "Unsafe network destination" });
    }
  };
}
