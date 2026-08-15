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

test("NOQORI header and hero expose the real audit entry without invented navigation", async ({ page }) => {
  await page.goto("/");
  const headerNavigation = page.getByRole("navigation", { name: "Primary navigation" });

  await expect(headerNavigation.getByRole("link", { name: "NOQORI home" })).toBeVisible();
  await expect(page.getByText("WEBSITE INTELLIGENCE", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "See what others miss." })).toBeVisible();
  await expect(page.locator(".noqoriHero").getByText("Website intelligence, simplified.", { exact: true })).toBeVisible();
  await expect(headerNavigation.getByRole("link", { name: "Start audit" })).toHaveAttribute("href", "#auditForm");
  await expect(page.getByRole("button", { name: "Run audit" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Pricing|Login|Resources/ })).toHaveCount(0);

  const markLoaded = await page.locator(".heroMark").evaluate((image) => image.complete && image.naturalWidth > 0);
  expect(markLoaded).toBe(true);
  await expect(page.locator("[data-visual-asset-slot] .heroMark")).toHaveAttribute("src", "/assets/noqori/noqori-expressive-prototype.png");
});

test("NOQORI header CTA moves keyboard focus to the real audit input", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Start audit" }).click();

  await expect(page.getByLabel("Website URL")).toBeFocused();
  await expect(page).toHaveURL(/#auditForm$/);
});

test("NOQORI expressive stage uses restrained pointer motion without browser errors", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const visual = page.locator(".noqoriHeroVisual");
  await expect(visual).toHaveAttribute("data-motion-ready", "true");
  await expect(visual).toHaveAttribute("data-pointer-enabled", "true");
  await visual.hover({ position: { x: 360, y: 120 } });

  await expect.poll(async () => visual.evaluate((element) => getComputedStyle(element).getPropertyValue("--nq-pointer-x").trim())).not.toBe("0px");

  const motion = await visual.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      x: parseFloat(styles.getPropertyValue("--nq-pointer-x")),
      y: parseFloat(styles.getPropertyValue("--nq-pointer-y")),
      rotateX: parseFloat(styles.getPropertyValue("--nq-pointer-rx")),
      rotateY: parseFloat(styles.getPropertyValue("--nq-pointer-ry"))
    };
  });

  expect(Math.abs(motion.x)).toBeLessThanOrEqual(14);
  expect(Math.abs(motion.y)).toBeLessThanOrEqual(14);
  expect(Math.abs(motion.rotateX)).toBeLessThanOrEqual(4);
  expect(Math.abs(motion.rotateY)).toBeLessThanOrEqual(4);

  await page.mouse.move(40, 120);
  await expect.poll(async () => visual.evaluate((element) => {
    const value = parseFloat(getComputedStyle(element).getPropertyValue("--nq-pointer-x"));
    return Math.abs(value);
  })).toBeLessThan(0.1);

  expect(browserErrors).toEqual([]);
});

test("NOQORI audit entry stays usable without horizontal overflow across target widths", async ({ page }) => {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");

    await expect(page.getByLabel("Website URL")).toBeVisible();
    await expect(page.getByRole("button", { name: "Run audit" })).toBeVisible();
    const layout = await page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
      formWidth: document.getElementById("auditForm").getBoundingClientRect().width,
      storyMode: document.querySelector("[data-story]").dataset.storyMode
    }));

    expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.formWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.storyMode).toBe(viewport.width <= 900 ? "flow" : "sticky");
    await expect(page.locator("[data-story-step]")).toHaveCount(4);
  }
});

test("NOQORI below-fold story presents only supported product outcomes", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "A deliberate path through your website." })).toBeVisible();
  await expect(page.locator("[data-story-step=discover]")).toContainText("Public page response");
  await expect(page.locator("[data-story-step=analyze]")).toContainText("Eight audit categories");
  await expect(page.locator("[data-story-step=reveal]")).toContainText("Priority fixes");
  await expect(page.locator("[data-story-step=improve]")).toContainText("Prioritized recommendations");
  await expect(page.getByRole("heading", { name: "A useful answer, not another dashboard." })).toBeVisible();
  await expect(page.getByText("SAMPLE REPORT STRUCTURE", { exact: true })).toBeVisible();
  await expect(page.getByRole("contentinfo")).toBeVisible();

  await expect(page.getByText("$19/mo", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Improvement service", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/continuous monitoring/i)).toHaveCount(0);
  await expect(page.getByText(/trusted by/i)).toHaveCount(0);
});

test("NOQORI desktop story advances visual state through native scrolling", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const story = page.locator("[data-story]");
  const visual = page.locator("[data-story-visual]");
  await expect(story).toHaveAttribute("data-story-ready", "true");
  await expect(story).toHaveAttribute("data-story-mode", "sticky");

  for (const state of ["discover", "analyze", "reveal", "improve"]) {
    await page.locator(`[data-story-step=${state}]`).evaluate(element => {
      element.scrollIntoView({ block: "center", behavior: "instant" });
    });
    await expect(story).toHaveAttribute("data-story-active", state);
    await expect(visual).toHaveAttribute("data-active", state);
  }

  expect(browserErrors).toEqual([]);
});

test("NOQORI final CTA returns focus to the one real audit form", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("link", { name: "Start your audit" }).click();

  await expect(page.getByLabel("Website URL")).toBeFocused();
  await expect(page).toHaveURL(/#auditForm$/);
  await expect(page.locator("form#auditForm")).toHaveCount(1);
});

test("NOQORI mobile story uses a readable flow and honors reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const story = page.locator("[data-story]");
  await expect(story).toHaveAttribute("data-story-mode", "flow");
  await expect(page.locator(".nqStoryVisualColumn")).toBeHidden();
  await expect(page.locator(".nqStoryMobileVisual")).toHaveCount(4);
  await expect(page.locator(".nqStoryMobileVisual").first()).toBeVisible();

  const motion = await page.locator("[data-story-step=discover]").evaluate(element => {
    const styles = getComputedStyle(element);
    return {
      transitionDuration: styles.transitionDuration,
      transform: styles.transform
    };
  });
  expect(parseFloat(motion.transitionDuration)).toBeLessThanOrEqual(0.001);
  expect(motion.transform).toBe("none");
});

test("NOQORI controls keep visible keyboard focus and reduce motion when requested", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.keyboard.press("Tab");

  const focusedControl = await page.evaluate(() => {
    const styles = getComputedStyle(document.activeElement);
    return {
      name: document.activeElement.getAttribute("aria-label"),
      outlineStyle: styles.outlineStyle,
      outlineWidth: styles.outlineWidth
    };
  });
  const motionDuration = await page.locator(".noqoriHeaderCta").evaluate((control) => getComputedStyle(control).transitionDuration);
  const visualMotion = await page.locator(".noqoriHeroVisual").evaluate((visual) => ({
    pointerEnabled: visual.dataset.pointerEnabled,
    stageAnimation: getComputedStyle(visual.querySelector(".noqoriMotionFloat")).animationName
  }));

  expect(focusedControl.name).toBe("NOQORI home");
  expect(focusedControl.outlineStyle).toBe("solid");
  expect(parseFloat(focusedControl.outlineWidth)).toBeGreaterThanOrEqual(2);
  expect(parseFloat(motionDuration)).toBeLessThanOrEqual(0.001);
  expect(visualMotion.pointerEnabled).toBe("false");
  expect(visualMotion.stageAnimation).toBe("none");
});

test("NOQORI analysis remains truthful and usable with reduced motion", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockCompletedAuditFlow(page);
  await page.goto("/");

  await page.getByLabel("Website URL").fill("https://example.com/path/");
  await page.getByRole("button", { name: /Run audit/ }).click();

  const analysis = page.locator("#analysisExperience");
  await expect(analysis).toBeVisible();
  await expect(page.locator("#analysisTarget")).toHaveText("example.com/path");
  const reducedState = await analysis.evaluate((element) => ({
    partAnimation: getComputedStyle(element.querySelector(".noqoriAnalysisMarkPart")).animationName,
    signalAnimation: getComputedStyle(element.querySelector(".noqoriAnalysisEmberSignal")).animationName,
    progressAnimation: getComputedStyle(element.querySelector(".noqoriAnalysisProgress span")).animationName
  }));

  expect(reducedState).toEqual({
    partAnimation: "none",
    signalAnimation: "none",
    progressAnimation: "none"
  });
  await expect(page.locator("#report")).toBeVisible();
  expect(browserErrors).toEqual([]);
});

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

  await expect(page.getByRole("heading", { level: 1, name: "See what others miss." })).toBeVisible();
  await expect(page.getByPlaceholder("Enter your website, e.g. luna-cafe.com")).toBeVisible();

  await page.getByPlaceholder("Enter your website, e.g. luna-cafe.com").fill("example.com");
  await page.getByRole("button", { name: /Run audit/ }).click();

  const analysis = page.locator("#analysisExperience");
  await expect(analysis).toBeVisible();
  await expect(page.locator("#analysisTarget")).toHaveText("example.com");
  await expect(analysis).toHaveAttribute("data-analysis-state", "queued");
  await expect(analysis).toHaveAttribute("data-analysis-state", "running");
  await expect(analysis).toHaveAttribute("data-analysis-state", "complete");

  await expect(page.locator("#report")).toBeVisible();
  await expect(analysis).toBeHidden();
  await expect(page.locator("#report").getByText("Audit report", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "example.com" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How did this site do?" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Start with these findings." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recommendations by priority" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Go deeper when you need to." })).toBeVisible();
  await expect(page.getByRole("button", { name: /Print report/ })).toBeVisible();
  await expect(page.locator(".nqCategory").filter({ hasText: "SEO basics" })).toHaveCount(1);
  await expect(page.locator(".nqCategory").filter({ hasText: "Design quality" })).toHaveCount(1);
  await expect(page.getByText("HTML audit completed", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("HTML real checks").first()).toBeVisible();
  await page.locator(".nqTechnicalDetails summary").click();
  await expect(page.getByText("http-html").first()).toBeVisible();
  await expect(page.getByText("seo", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("accessibility", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("performance-hints").first()).toBeVisible();
  await expect(page.getByText("security-headers").first()).toBeVisible();
  await expect(page.locator("#report .nqPriorityTag[data-priority=high]")).not.toHaveCount(0);
  await expect(page.locator("#report .nqEvidenceRow")).not.toHaveCount(0);
  await expect(page.locator("#report .nqCategory")).not.toHaveCount(0);

  expect(auditRequests.length).toBeGreaterThan(0);
  await page.waitForTimeout(1200);
  expect(flow.counts()).toEqual({ pollCount: 3, auditFetchCount: 1 });
  expect(browserErrors).toEqual([]);

  await page.locator(".nqReportActions button").filter({ hasText: "Analyze another" }).click();
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
  await input.evaluate((element) => {
    element.value = "new.example.com";
    element.form.requestSubmit();
  });

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

  const analysis = page.locator("#analysisExperience");
  await expect(analysis).toHaveAttribute("data-analysis-state", "error");
  await expect(page.getByRole("alert")).toContainText("The website audit timed out. Please try again.");
  await expect(page.getByText("AUDIT_TIMEOUT", { exact: true })).toBeHidden();
  await page.getByText("Technical details", { exact: true }).click();
  await expect(page.getByText("AUDIT_TIMEOUT", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.waitForTimeout(1200);
  expect(pollCount).toBe(1);

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(analysis).toBeHidden();
  await expect(page.getByRole("button", { name: /Run audit/ })).toBeVisible();
  await expect(page.getByLabel("Website URL")).toBeFocused();
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
  await expect(page.locator("#analysisExperience")).toHaveAttribute("data-analysis-state", "queued");
  await page.clock.runFor(1000);
  await expect.poll(() => pollCount).toBe(1);
  await page.clock.fastForward(90_000);

  await expect(page.getByRole("alert")).toContainText("The audit is taking longer than expected. Please try again shortly.");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
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

  await expect(page.getByRole("alert")).toContainText("NOQORI received an invalid audit status. Please try again.");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
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

  await expect(page.getByRole("alert")).toContainText("NOQORI could not check the audit status. Please try again.");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
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

  await expect(page.getByRole("alert")).toContainText("The audit finished, but the report could not be loaded. Please try again.");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("signed-out frontend exposes the temporary backend login requirement safely", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("Enter your website, e.g. luna-cafe.com").fill("example.com");
  await page.getByRole("button", { name: /Run audit/ }).click();

  await expect(page.getByRole("alert")).toContainText("Sign in to continue.");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.locator("#report")).toBeHidden();
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

  await expect(page.getByRole("alert")).toContainText(
    "The NOQORI audit service is unavailable. Please try again shortly."
  );
  await expect(page.getByRole("alert")).not.toContainText("Load failed");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
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

  const section = page.locator("#real-page-performance");
  await expect(section).toBeVisible();
  await expect(page.getByText("Partial audit completed", { exact: true }).first()).toBeVisible();
  await expect(section.getByText("Needs improvement", { exact: true }).first()).toBeVisible();
  await expect(section.getByText("Main content", { exact: true })).toBeVisible();
  await expect(section.getByText("4.2s", { exact: true })).toBeVisible();
  await expect(section.getByText("Optimize oversized images")).toBeVisible();
  const box = await section.boundingBox();
  expect(box.width).toBeLessThanOrEqual(390);
});
