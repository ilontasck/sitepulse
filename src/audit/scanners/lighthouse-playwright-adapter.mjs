import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import { connect as connectPuppeteer } from "puppeteer-core";
import { PipeTransport } from "puppeteer-core/internal/node/PipeTransport.js";
import { chromium } from "playwright";
import { assertSafeUrl } from "../url-safety.mjs";
import { mapLighthouseResult } from "./lighthouse-result.mjs";

function withTimeout(promise, timeoutMs, signal) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Rendered audit exceeded ${timeoutMs}ms timeout.`)), timeoutMs);
  });

  const cancelled = signal
    ? new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason || new Error("Audit cancelled.")), { once: true }))
    : new Promise(() => {});
  return Promise.race([promise, timeout, cancelled]).finally(() => clearTimeout(timer));
}

export function browserChildEnvironment(environment = process.env) {
  const allowed = ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "PLAYWRIGHT_BROWSERS_PATH"];
  return Object.fromEntries(allowed.filter((key) => environment[key] !== undefined).map((key) => [key, environment[key]]));
}

export async function runLighthousePlaywrightAdapter(target, options = {}) {
  const timeoutMs = options.timeoutMs || 45_000;
  const chrome = await chromeLauncher.launch({
    handleSIGINT: false,
    envVars: browserChildEnvironment(),
    chromePath: chromium.executablePath(),
    chromeFlags: [
      "--headless",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-quic",
      "--disable-dev-shm-usage",
      "--disable-sync",
      "--no-first-run",
      "--remote-debugging-pipe"
    ]
  });
  let browser;
  let transport;

  try {
    if (!chrome.remoteDebuggingPipes) {
      throw Object.assign(new Error("Chrome did not provide a debugging pipe."), { code: "BROWSER_CRASH" });
    }
    transport = new PipeTransport(
      chrome.remoteDebuggingPipes.outgoing,
      chrome.remoteDebuggingPipes.incoming
    );
    browser = await connectPuppeteer({ transport, defaultViewport: null, protocol: "cdp" });
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    const diagnostics = {
      consoleErrorCount: 0,
      pageErrorCount: 0,
      failedRequestCount: 0,
      blockedUnsafeRequestCount: 0,
      renderedDomBytes: null
    };

    const observePage = async (pageToObserve) => {
      const captureDomSize = async () => {
        try {
          diagnostics.renderedDomBytes = Math.max(diagnostics.renderedDomBytes || 0, Buffer.byteLength(await pageToObserve.content()));
        } catch {
          // Lighthouse can close its target immediately after collection.
        }
      };

      pageToObserve.on("domcontentloaded", captureDomSize);
      pageToObserve.on("load", captureDomSize);
      pageToObserve.on("console", (message) => {
        if (message.type() === "error") diagnostics.consoleErrorCount += 1;
      });
      pageToObserve.on("pageerror", () => {
        diagnostics.pageErrorCount += 1;
      });
      pageToObserve.on("requestfailed", () => {
        diagnostics.failedRequestCount += 1;
      });
      await pageToObserve.evaluateOnNewDocument(() => {
        if (navigator.serviceWorker?.register) {
          navigator.serviceWorker.register = () => Promise.reject(new DOMException("Service workers are disabled during NOQORI audits.", "SecurityError"));
        }
      });
      await pageToObserve.setRequestInterception(true);
      pageToObserve.on("request", async (request) => {
        try {
          const requestUrl = request.url();
          if (!requestUrl.startsWith("data:") && !requestUrl.startsWith("blob:") && requestUrl !== "about:blank") {
            await assertSafeUrl(requestUrl, options);
          }
          await request.continue();
        } catch {
          diagnostics.blockedUnsafeRequestCount += 1;
          await request.abort("blockedbyclient").catch(() => {});
        }
      });
    };
    await observePage(page);

    const runnerResult = await withTimeout(
      lighthouse(target.normalizedUrl, {
        logLevel: "error",
        output: "json",
        onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
        maxWaitForLoad: Math.min(timeoutMs, 30_000)
      }, undefined, page),
      timeoutMs,
      options.signal
    );

    if (!runnerResult?.lhr) {
      throw new Error("Lighthouse did not return an audit result.");
    }

    await assertSafeUrl(runnerResult.lhr.finalDisplayedUrl || runnerResult.lhr.finalUrl, options);
    return mapLighthouseResult(runnerResult.lhr, diagnostics);
  } finally {
    try {
      await chrome.kill();
    } catch {
      // Chrome may already have exited after a Lighthouse or timeout failure.
    }
    await browser?.disconnect().catch(() => {});
    transport?.close();
  }
}
