import { expect, test } from "@playwright/test";

function createAudit(domain = "example.com", lab = null) {
  const categories = [
    ["design", "Design quality", 84],
    ["mobile", "Mobile experience", 76],
    ["performance", "Performance", 69],
    ["seo", "SEO basics", 88],
    ["trust", "Trust & security", 81],
    ["conversion", "Conversion", 72],
    ["content", "Content clarity", 79],
    ["accessibility", "Accessibility", 86]
  ].map(([id, label, score]) => ({
    id,
    label,
    score,
    status: score >= 78 ? "Strong" : "Needs work",
    explanation: `${label} evidence from the controlled browser fixture.`,
    recommendations: [`Improve ${label.toLowerCase()}.`],
    recommendationDetails: [{ priority: score < 74 ? "high" : "medium" }],
    checks: [{ label: `${label} check`, passed: score >= 78, priority: "medium", details: "Fixture evidence" }],
    impact: score < 74 ? "High" : "Medium"
  }));

  return {
    id: `audit-${domain}`,
    normalizedUrl: `https://${domain}`,
    domain,
    overallScore: 79,
    categories,
    recommendations: categories.map((category) => ({
      category: category.label,
      text: category.recommendations[0],
      priority: category.recommendationDetails[0].priority
    })),
    priorityFixes: [],
    improvements: [],
    signals: lab ? { lab } : {},
    scanner: {
      mode: "html-real-checks",
      status: lab ? "partial-audit-completed" : "html-audit-completed",
      adapters: ["http-html", "seo", "accessibility", "performance-hints", "security-headers"],
      warnings: []
    },
    warnings: []
  };
}

async function fulfillJson(route, status, payload, headers = {}) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(payload)
  });
}

async function mockQueuedJobCreation(page, jobId = "33333333-3333-4333-8333-333333333333") {
  await page.route("**/api/audits", async (route) => {
    await fulfillJson(route, 202, {
      job: {
        id: jobId,
        status: "queued",
        createdAt: "2026-08-13T10:00:00.000Z",
        statusUrl: `/api/audit-jobs/${jobId}`
      }
    });
  });

  return jobId;
}

async function mockCompletedAuditFlow(page, { domain = "example.com", statuses = ["queued", "running", "completed"], audit = createAudit(domain) } = {}) {
  let pollCount = 0;
  let auditFetchCount = 0;

  await page.route("**/api/audits", async (route) => {
    await fulfillJson(route, 202, {
      job: {
        id: "11111111-1111-4111-8111-111111111111",
        status: "queued",
        createdAt: "2026-08-13T10:00:00.000Z",
        statusUrl: "/api/audit-jobs/11111111-1111-4111-8111-111111111111"
      }
    }, { Location: "/api/audit-jobs/11111111-1111-4111-8111-111111111111", "Retry-After": "1" });
  });
  await page.route("**/api/audit-jobs/11111111-1111-4111-8111-111111111111", async (route) => {
    const status = statuses[Math.min(pollCount, statuses.length - 1)];
    pollCount += 1;
    await fulfillJson(route, 200, {
      job: status === "completed"
        ? {
            id: "11111111-1111-4111-8111-111111111111",
            status,
            createdAt: "2026-08-13T10:00:00.000Z",
            completedAt: "2026-08-13T10:00:03.000Z",
            auditId: audit.id,
            auditUrl: `/api/audits/${audit.id}`
          }
        : {
            id: "11111111-1111-4111-8111-111111111111",
            status,
            createdAt: "2026-08-13T10:00:00.000Z",
            ...(status === "running" ? { startedAt: "2026-08-13T10:00:01.000Z" } : {})
          }
    });
  });
  await page.route(`**/api/audits/${audit.id}`, async (route) => {
    auditFetchCount += 1;
    await fulfillJson(route, 200, { audit });
  });

  return {
    counts() {
      return { pollCount, auditFetchCount };
    }
  };
}

function collectBrowserErrors(page) {
  const errors = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });

  return errors;
}

test("main audit flow renders report and resets", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  const auditRequests = [];
  const flow = await mockCompletedAuditFlow(page);

  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/audits")) {
      auditRequests.push(request);
    }
  });

  await page.goto("/");

  await expect(page.getByText("Turn any small-business website into a sharper sales engine.")).toBeVisible();
  await expect(page.getByPlaceholder("Enter your website, e.g. luna-cafe.com")).toBeVisible();

  await page.getByPlaceholder("Enter your website, e.g. luna-cafe.com").fill("example.com");
  await page.getByRole("button", { name: /Run audit/ }).click();

  await expect(page.locator("#loading")).toContainText("Your audit is queued…");
  await expect(page.locator("#loading")).toContainText("Analyzing your website…");

  await expect(page.locator("#report")).toBeVisible();
  await expect(page.locator("#report").getByText("Audit report", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "example.com" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Priority fixes" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Before / after potential" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recommendations by priority" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download report" })).toBeVisible();
  await expect(page.locator("details").filter({ hasText: "SEO basics" })).toHaveCount(1);
  await expect(page.locator("details").filter({ hasText: "Design quality" })).toHaveCount(1);
  await expect(page.getByText(/Scanner:/)).toBeVisible();
  await expect(page.getByText("HTML audit completed", { exact: true })).toBeVisible();
  await expect(page.getByText("html-real-checks")).toBeVisible();
  await expect(page.getByText("http-html")).toBeVisible();
  await expect(page.getByText("seo", { exact: true })).toBeVisible();
  await expect(page.getByText("accessibility", { exact: true })).toBeVisible();
  await expect(page.getByText("performance-hints")).toBeVisible();
  await expect(page.getByText("security-headers")).toBeVisible();
  await expect(page.locator("#report .priorityBadge.high")).not.toHaveCount(0);
  await expect(page.locator("#report").getByText("Live checks")).not.toHaveCount(0);
  await expect(page.locator("#report .checkItem")).not.toHaveCount(0);

  expect(auditRequests.length).toBeGreaterThan(0);
  await page.waitForTimeout(1200);
  expect(flow.counts()).toEqual({ pollCount: 3, auditFetchCount: 1 });
  expect(browserErrors).toEqual([]);

  await page.getByRole("button", { name: "Analyze another" }).click();
  await expect(page.getByPlaceholder("Enter your website, e.g. luna-cafe.com")).toBeVisible();
});

test("a new submit invalidates a stale completion from the previous job", async ({ page }) => {
  const oldJobId = "11111111-1111-4111-8111-111111111111";
  const newJobId = "22222222-2222-4222-8222-222222222222";
  let postCount = 0;
  let oldPollCount = 0;

  await page.route("**/api/audits", async (route) => {
    postCount += 1;
    const jobId = postCount === 1 ? oldJobId : newJobId;
    await fulfillJson(route, 202, {
      job: {
        id: jobId,
        status: "queued",
        createdAt: "2026-08-13T10:00:00.000Z",
        statusUrl: `/api/audit-jobs/${jobId}`
      }
    });
  });
  await page.route(`**/api/audit-jobs/${oldJobId}`, async (route) => {
    oldPollCount += 1;
    await new Promise(resolve => setTimeout(resolve, 2000));
    await fulfillJson(route, 200, {
      job: {
        id: oldJobId,
        status: "completed",
        createdAt: "2026-08-13T10:00:00.000Z",
        completedAt: "2026-08-13T10:00:03.000Z",
        auditId: "audit-old.example.com",
        auditUrl: "/api/audits/audit-old.example.com"
      }
    });
  });
  await page.route(`**/api/audit-jobs/${newJobId}`, async (route) => {
    await fulfillJson(route, 200, {
      job: {
        id: newJobId,
        status: "completed",
        createdAt: "2026-08-13T10:00:01.000Z",
        completedAt: "2026-08-13T10:00:02.000Z",
        auditId: "audit-new.example.com",
        auditUrl: "/api/audits/audit-new.example.com"
      }
    });
  });
  await page.route("**/api/audits/audit-old.example.com", async (route) => {
    await fulfillJson(route, 200, { audit: createAudit("old.example.com") });
  });
  await page.route("**/api/audits/audit-new.example.com", async (route) => {
    await fulfillJson(route, 200, { audit: createAudit("new.example.com") });
  });

  await page.goto("/");
  const input = page.getByPlaceholder("Enter your website, e.g. luna-cafe.com");
  await input.fill("old.example.com");
  await page.getByRole("button", { name: /Run audit/ }).click();
  await page.waitForTimeout(1100);
  await input.fill("new.example.com");
  await page.locator("#auditForm").evaluate(form => form.requestSubmit());

  await expect(page.getByRole("heading", { name: "new.example.com" })).toBeVisible();
  await page.waitForTimeout(2200);
  await expect(page.getByRole("heading", { name: "new.example.com" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "old.example.com" })).toHaveCount(0);
  expect(oldPollCount).toBe(1);
});

test("a failed job shows its safe error and stops polling", async ({ page }) => {
  const jobId = await mockQueuedJobCreation(page);
  let pollCount = 0;

  await page.route(`**/api/audit-jobs/${jobId}`, async (route) => {
    pollCount += 1;
    await fulfillJson(route, 200, {
      job: {
        id: jobId,
        status: "failed",
        createdAt: "2026-08-13T10:00:00.000Z",
        failedAt: "2026-08-13T10:00:01.000Z",
        error: {
          code: "AUDIT_TIMEOUT",
          message: "The website audit timed out. Please try again."
        }
      }
    });
  });

  await page.goto("/");
  await page.getByPlaceholder("Enter your website, e.g. luna-cafe.com").fill("example.com");
  await page.getByRole("button", { name: /Run audit/ }).click();

  await expect(page.getByRole("alert")).toHaveText("The website audit timed out. Please try again.");
  await expect(page.getByRole("button", { name: /Run audit/ })).toBeEnabled();
  await page.waitForTimeout(1200);
  expect(pollCount).toBe(1);
});

test("client polling timeout restores the form without failing the server job", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-08-13T10:00:00.000Z") });
  const jobId = await mockQueuedJobCreation(page);
  let pollCount = 0;

  await page.route(`**/api/audit-jobs/${jobId}`, async (route) => {
    pollCount += 1;
    await new Promise(() => {});
  });

  await page.goto("/");
  await page.getByPlaceholder("Enter your website, e.g. luna-cafe.com").fill("example.com");
  await page.getByRole("button", { name: /Run audit/ }).click();
  await expect(page.locator("#loading")).toContainText("Your audit is queued…");
  await page.clock.runFor(1000);
  await expect.poll(() => pollCount).toBe(1);
  await page.clock.fastForward(90_000);

  await expect(page.getByRole("alert")).toHaveText("The audit is taking longer than expected. Please try again shortly.");
  await expect(page.getByRole("button", { name: /Run audit/ })).toBeEnabled();
  await expect(page.locator("#loading")).toBeHidden();
  expect(pollCount).toBe(1);
});

test("a malformed polling response fails safely without crashing the UI", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  const jobId = await mockQueuedJobCreation(page);

  await page.route(`**/api/audit-jobs/${jobId}`, async (route) => {
    await fulfillJson(route, 200, { job: { id: jobId, status: "unexpected-internal-state" } });
  });

  await page.goto("/");
  await page.getByPlaceholder("Enter your website, e.g. luna-cafe.com").fill("example.com");
  await page.getByRole("button", { name: /Run audit/ }).click();

  await expect(page.getByRole("alert")).toHaveText("SitePulse received an invalid audit status. Please try again.");
  await expect(page.getByRole("button", { name: /Run audit/ })).toBeEnabled();
  expect(browserErrors).toEqual([]);
});

test("a polling network failure shows a status-specific safe error", async ({ page }) => {
  const jobId = await mockQueuedJobCreation(page);
  let pollCount = 0;
  await page.route(`**/api/audit-jobs/${jobId}`, route => {
    pollCount += 1;
    return route.abort("connectionrefused");
  });

  await page.goto("/");
  await page.getByPlaceholder("Enter your website, e.g. luna-cafe.com").fill("example.com");
  await page.getByRole("button", { name: /Run audit/ }).click();

  await expect(page.getByRole("alert")).toHaveText("SitePulse could not check the audit status. Please try again.");
  await expect(page.getByRole("button", { name: /Run audit/ })).toBeEnabled();
  expect(pollCount).toBe(3);
});

test("an audit fetch failure does not expose a browser error", async ({ page }) => {
  const jobId = await mockQueuedJobCreation(page);
  await page.route(`**/api/audit-jobs/${jobId}`, async (route) => {
    await fulfillJson(route, 200, {
      job: {
        id: jobId,
        status: "completed",
        createdAt: "2026-08-13T10:00:00.000Z",
        completedAt: "2026-08-13T10:00:01.000Z",
        auditId: "audit-unavailable",
        auditUrl: "/api/audits/audit-unavailable"
      }
    });
  });
  await page.route("**/api/audits/audit-unavailable", route => route.abort("connectionrefused"));

  await page.goto("/");
  await page.getByPlaceholder("Enter your website, e.g. luna-cafe.com").fill("example.com");
  await page.getByRole("button", { name: /Run audit/ }).click();

  await expect(page.getByRole("alert")).toHaveText("The audit finished, but the report could not be loaded. Please try again.");
  await expect(page.getByRole("button", { name: /Run audit/ })).toBeEnabled();
});

test("validation errors are visible and do not break the page", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);

  await page.goto("/");

  await page.getByRole("button", { name: /Run audit/ }).click();
  await expect(page.getByText("Website URL is required.")).toBeVisible();
  await expect(page.getByPlaceholder("Enter your website, e.g. luna-cafe.com")).toBeEnabled();

  await page.getByPlaceholder("Enter your website, e.g. luna-cafe.com").fill("not a website");
  await page.getByRole("button", { name: /Run audit/ }).click();
  await expect(page.getByText("Use a public website domain, like example.com.")).toBeVisible();

  expect(browserErrors).toEqual([]);
});

test("an unavailable audit API shows a useful message instead of the browser Load failed text", async ({ page }) => {
  await page.route("**/api/audits", (route) => route.abort("connectionrefused"));
  await page.goto("/");

  await page.getByPlaceholder("Enter your website, e.g. luna-cafe.com").fill("example.com");
  await page.getByRole("button", { name: /Run audit/ }).click();

  await expect(page.getByRole("alert")).toHaveText(
    "SitePulse audit service is unavailable. Start the SitePulse server and try again."
  );
  await expect(page.getByRole("alert")).not.toContainText("Load failed");
  await expect(page.getByRole("button", { name: /Run audit/ })).toBeEnabled();
});

test("unsafe localhost URL is blocked with a readable error", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);

  await page.goto("/");

  await page.getByPlaceholder("Enter your website, e.g. luna-cafe.com").fill("http://127.0.0.1:3000");
  await page.getByRole("button", { name: /Run audit/ }).click();

  await expect(page.getByText("Private or internal website addresses cannot be scanned.")).toBeVisible();
  await expect(page.locator("#report")).toBeHidden();
  expect(browserErrors).toEqual([]);
});

test("real page performance stays understandable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const lab = {
    metrics: { lcpMs: 4200, cls: 0.12, fcpMs: 2100, speedIndexMs: 3900, tbtMs: 240, inpMs: null, inpLabProxy: "TBT" },
    scores: { performance: 63, accessibility: 91, bestPractices: 96, seo: 92 },
    findings: [{ title: "Optimize oversized images", action: "Compress the images identified by Lighthouse." }]
  };
  await mockCompletedAuditFlow(page, { statuses: ["completed"], audit: createAudit("example.com", lab) });

  await page.goto("/");
  await page.getByPlaceholder("Enter your website, e.g. luna-cafe.com").fill("example.com");
  await page.getByRole("button", { name: /Run audit/ }).click();

  const section = page.getByRole("heading", { name: "Real Page Performance" }).locator("..");
  await expect(section).toBeVisible();
  await expect(page.getByText("Partial audit completed", { exact: true })).toBeVisible();
  await expect(section.getByText("Needs improvement", { exact: true }).first()).toBeVisible();
  await expect(section.getByText(/Main content · 4.2s/)).toBeVisible();
  await expect(section.getByText("Optimize oversized images")).toBeVisible();
  const box = await section.boundingBox();
  expect(box.width).toBeLessThanOrEqual(390);
});
