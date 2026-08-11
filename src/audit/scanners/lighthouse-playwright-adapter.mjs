import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import { chromium } from "playwright";
import { assertSafeUrl } from "../url-safety.mjs";
import { mapLighthouseResult } from "./lighthouse-result.mjs";
import { createSafeRouteHandler, createSafeWebSocketHandler } from "./rendered-network-safety.mjs";

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Rendered audit exceeded ${timeoutMs}ms timeout.`)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runLighthousePlaywrightAdapter(target, options = {}) {
  const timeoutMs = options.timeoutMs || 45_000;
  const chrome = await chromeLauncher.launch({
    chromePath: chromium.executablePath(),
    chromeFlags: [
      "--headless",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-dev-shm-usage",
      "--disable-sync",
      "--no-first-run",
      "--remote-debugging-address=127.0.0.1"
    ]
  });
  let browser;

  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${chrome.port}`);
    const context = browser.contexts()[0];
    const diagnostics = {
      consoleErrorCount: 0,
      pageErrorCount: 0,
      failedRequestCount: 0,
      blockedUnsafeRequestCount: 0,
      renderedDomBytes: null
    };

    const observePage = (page) => {
      const captureDomSize = async () => {
        try {
          diagnostics.renderedDomBytes = Math.max(diagnostics.renderedDomBytes || 0, Buffer.byteLength(await page.content()));
        } catch {
          // Lighthouse can close its target immediately after collection.
        }
      };

      page.on("domcontentloaded", captureDomSize);
      page.on("load", captureDomSize);
      page.on("console", (message) => {
        if (message.type() === "error") diagnostics.consoleErrorCount += 1;
      });
      page.on("pageerror", () => {
        diagnostics.pageErrorCount += 1;
      });
      page.on("requestfailed", () => {
        diagnostics.failedRequestCount += 1;
      });
    };

    const networkSafetyOptions = {
      ...options,
      onBlocked: () => {
        diagnostics.blockedUnsafeRequestCount += 1;
      }
    };

    await context.addInitScript(() => {
      if (navigator.serviceWorker?.register) {
        navigator.serviceWorker.register = () => Promise.reject(new DOMException("Service workers are disabled during SitePulse audits.", "SecurityError"));
      }
    });
    await context.route("**/*", createSafeRouteHandler(networkSafetyOptions));
    await context.routeWebSocket(/.*/, createSafeWebSocketHandler(networkSafetyOptions));
    context.pages().forEach(observePage);
    context.on("page", observePage);

    const runnerResult = await withTimeout(
      lighthouse(target.normalizedUrl, {
        port: chrome.port,
        logLevel: "error",
        output: "json",
        onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
        maxWaitForLoad: Math.min(timeoutMs, 30_000)
      }),
      timeoutMs
    );

    if (!runnerResult?.lhr) {
      throw new Error("Lighthouse did not return an audit result.");
    }

    await assertSafeUrl(runnerResult.lhr.finalDisplayedUrl || runnerResult.lhr.finalUrl, options);
    return mapLighthouseResult(runnerResult.lhr, diagnostics);
  } finally {
    await browser?.close().catch(() => {});

    try {
      chrome.kill();
    } catch {
      // Chrome may already have exited after a Lighthouse or timeout failure.
    }
  }
}
