import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchSafeHtml, isUnsafeIpAddress } from "../src/audit/url-safety.mjs";
import { HttpError } from "../src/http/http-error.mjs";

function resolver(recordsByHost) {
  return async (hostname) => {
    const records = recordsByHost[hostname];

    if (!records) {
      return [{ address: "93.184.216.34", family: 4 }];
    }

    return records.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4
    }));
  };
}

function htmlResponse(body, init = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...init.headers
    }
  });
}

describe("URL safety", () => {
  it("detects private and internal IP addresses", () => {
    assert.equal(isUnsafeIpAddress("127.0.0.1"), true);
    assert.equal(isUnsafeIpAddress("10.0.0.5"), true);
    assert.equal(isUnsafeIpAddress("172.16.0.1"), true);
    assert.equal(isUnsafeIpAddress("192.168.1.10"), true);
    assert.equal(isUnsafeIpAddress("169.254.169.254"), true);
    assert.equal(isUnsafeIpAddress("100.64.0.1"), true);
    assert.equal(isUnsafeIpAddress("192.0.2.1"), true);
    assert.equal(isUnsafeIpAddress("198.51.100.1"), true);
    assert.equal(isUnsafeIpAddress("203.0.113.1"), true);
    assert.equal(isUnsafeIpAddress("::1"), true);
    assert.equal(isUnsafeIpAddress("fc00::1"), true);
    assert.equal(isUnsafeIpAddress("fe80::1"), true);
    assert.equal(isUnsafeIpAddress("::ffff:7f00:1"), true);
    assert.equal(isUnsafeIpAddress("64:ff9b::7f00:1"), true);
    assert.equal(isUnsafeIpAddress("93.184.216.34"), false);
    assert.equal(isUnsafeIpAddress("2606:2800:220:1:248:1893:25c8:1946"), false);
  });

  it("rejects unsafe URL protocols and private hosts", async () => {
    await assert.rejects(() => fetchSafeHtml("file:///etc/passwd"), /Only http and https/);
    await assert.rejects(() => fetchSafeHtml("http://localhost:3000"), /Localhost/);
    await assert.rejects(() => fetchSafeHtml("http://api.internal"), /Localhost/);
    await assert.rejects(() => fetchSafeHtml("http://metadata.google.internal"), /Localhost/);
    await assert.rejects(
      () =>
        fetchSafeHtml("http://private.example", {
          resolver: resolver({ "private.example": ["10.0.0.8"] })
        }),
      /private or internal/
    );
  });

  it("accepts valid public HTML responses", async () => {
    const result = await fetchSafeHtml("https://example.com", {
      resolver: resolver({ "example.com": ["93.184.216.34"] }),
      fetcher: async () => htmlResponse("<!doctype html><title>Example</title>")
    });

    assert.equal(result.finalUrl, "https://example.com");
    assert.match(result.html, /Example/);
  });

  it("accepts a modern JS-heavy HTML document above the former 250 KB limit", async () => {
    const html = `<!doctype html><title>Application</title><script>${"x".repeat(300_000)}</script>`;
    const result = await fetchSafeHtml("https://app.example.com", {
      resolver: resolver({ "app.example.com": ["93.184.216.34"] }),
      fetcher: async () => htmlResponse(html)
    });

    assert.equal(result.htmlBytes, Buffer.byteLength(html));
  });

  it("handles redirects safely and rejects private redirect targets", async () => {
    await assert.rejects(
      () =>
        fetchSafeHtml("https://example.com", {
          resolver: resolver({
            "example.com": ["93.184.216.34"],
            "internal.example": ["192.168.1.5"]
          }),
          fetcher: async () =>
            new Response("", {
              status: 302,
              headers: { location: "http://internal.example/admin" }
            })
        }),
      (error) => error instanceof HttpError && error.code === "UNSAFE_URL"
    );
  });

  it("limits redirect count and HTML size", async () => {
    await assert.rejects(
      () =>
        fetchSafeHtml("https://example.com", {
          maxRedirects: 1,
          resolver: resolver({ "example.com": ["93.184.216.34"] }),
          fetcher: async () =>
            new Response("", {
              status: 302,
              headers: { location: "https://example.com/again" }
            })
        }),
      (error) => error instanceof HttpError && error.code === "TOO_MANY_REDIRECTS"
    );

    await assert.rejects(
      () =>
        fetchSafeHtml("https://example.com", {
          maxHtmlBytes: 10,
          resolver: resolver({ "example.com": ["93.184.216.34"] }),
          fetcher: async () => htmlResponse("<html>this is too large</html>")
        }),
      (error) => error instanceof HttpError && error.code === "HTML_TOO_LARGE"
    );
  });
});

// The transport exposes headers before the body completes, as native fetch does.
describe("HTML download lifecycle", () => {
  it("times out a body that stalls after headers", async () => {
    let fallback;
    try {
      await assert.rejects(fetchSafeHtml("https://example.com", {
        resolver: resolver({}),
        timeoutMs: 20,
        fetcher: async (_url, { signal }) => htmlResponse(new ReadableStream({
          start(stream) {
            signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
            // Release a broken implementation so the regression fails without hanging.
            fallback = setTimeout(() => stream.close(), 200);
          }
        }))
      }), error => error.code === "SCAN_TIMEOUT" && error.statusCode === 504);
    } finally {
      clearTimeout(fallback);
    }
  });

  it("preserves caller cancellation during body consumption", async () => {
    const caller = new AbortController();
    const reason = new Error("job cancelled");
    await assert.rejects(fetchSafeHtml("https://example.com", {
      resolver: resolver({}),
      signal: caller.signal,
      fetcher: async (_url, { signal }) => htmlResponse(new ReadableStream({
        pull(stream) {
          signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
          caller.abort(reason);
        }
      }))
    }), error => error === reason);
  });
});

describe("unfinished HTML response cleanup", () => {
  for (const [name, makeResponse, code] of [
    ["redirect without location", () => new Response("pending", { status: 302 }), "UNSAFE_REDIRECT"],
    ["redirect limit", () => new Response("pending", { status: 302, headers: { location: "/again" } }), "TOO_MANY_REDIRECTS"],
    ["non-HTML response", () => new Response("pending", { headers: { "content-type": "application/json" } }), "NON_HTML_RESPONSE"],
    ["oversized declared body", () => htmlResponse("pending", { headers: { "content-length": "100" } }), "HTML_TOO_LARGE"],
    ["oversized streamed body", () => htmlResponse("x".repeat(100)), "HTML_TOO_LARGE"]
  ]) {
    it(`aborts transport after ${name}`, async () => {
      let transportSignal;
      await assert.rejects(fetchSafeHtml("https://example.com", {
        resolver: resolver({}),
        maxRedirects: 0,
        maxHtmlBytes: 10,
        fetcher: async (_url, { signal }) => {
          transportSignal = signal;
          return makeResponse();
        }
      }), error => error.code === code);
      assert.equal(transportSignal.aborted, true);
    });
  }

  it("aborts a redirect body before fetching the next hop, preserving a completed response", async () => {
    let firstSignal;
    let finalSignal;
    const result = await fetchSafeHtml("https://example.com", {
      resolver: resolver({}),
      fetcher: async (url, { signal }) => {
        if (url.pathname === "/") {
          firstSignal = signal;
          return new Response("pending", { status: 302, headers: { location: "/final" } });
        }
        assert.equal(firstSignal.aborted, true);
        finalSignal = signal;
        return htmlResponse("<html>done</html>");
      }
    });
    assert.equal(result.html, "<html>done</html>");
    assert.equal(finalSignal.aborted, false);
  });
});

it("rejects IPv6 site-local, translation and special-use ranges", () => {
  for (const address of ["fec0::1", "64:ff9b:1::a00:1", "::127.0.0.1", "2001::1", "2001:2::1", "2001:20::1"]) {
    assert.equal(isUnsafeIpAddress(address), true, address);
  }
});
