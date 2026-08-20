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

async function measureHorizontalOverflow(page) {
  return page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const offenders = [...document.querySelectorAll("body *")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const ownOverflow = element.scrollWidth - element.clientWidth;
        return {
          selector: element.id
            ? `#${element.id}`
            : `${element.tagName.toLowerCase()}${[...element.classList].map((name) => `.${name}`).join("")}`,
          left: Math.round(rect.left * 100) / 100,
          right: Math.round(rect.right * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
          ownOverflow
        };
      })
      .filter(({ left, right, ownOverflow }) => left < -0.5 || right > viewportWidth + 0.5 || ownOverflow > 1);

    return {
      viewportWidth,
      rootScrollWidth: document.documentElement.scrollWidth,
      offenders
    };
  });
}

async function measureMeaningfulReportMetadata(page) {
  const selectors = [
    ".nqOverviewList small",
    ".nqPriorityTag",
    ".nqFindingMeta",
    ".nqFindingEvidence span",
    ".nqLabMetric em",
    ".nqLighthouseScores span",
    ".nqLighthouseScores em",
    ".nqRecommendationCard > span",
    ".nqRecommendationCard div b",
    ".nqCategoryIdentity small",
    ".nqTechnicalDetails summary small"
  ];

  return page.evaluate((testedSelectors) => testedSelectors.flatMap((selector) =>
    [...document.querySelectorAll(selector)].map((element) => ({
      selector,
      text: element.textContent.trim(),
      fontSize: parseFloat(getComputedStyle(element).fontSize)
    }))
  ), selectors);
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

test("analysis communicates each job stage with semantic step state", async ({ page }) => {
  const jobId = "44444444-4444-4444-8444-444444444444";
  let releasePost;
  let releaseReport;
  let pollCount = 0;
  const postGate = new Promise(resolve => { releasePost = resolve; });
  const reportGate = new Promise(resolve => { releaseReport = resolve; });

  await page.route("**/api/audits", async route => {
    await postGate;
    await fulfillJson(route, 202, {
      job: { id: jobId, status: "queued", createdAt: "2026-08-13T10:00:00.000Z", statusUrl: `/api/audit-jobs/${jobId}` }
    });
  });
  await page.route(`**/api/audit-jobs/${jobId}`, async route => {
    const status = ["queued", "running", "completed"][Math.min(pollCount, 2)];
    pollCount += 1;
    await fulfillJson(route, 200, {
      job: status === "completed"
        ? { id: jobId, status, createdAt: "2026-08-13T10:00:00.000Z", completedAt: "2026-08-13T10:00:03.000Z", auditId: "audit-example.com", auditUrl: "/api/audits/audit-example.com" }
        : { id: jobId, status, createdAt: "2026-08-13T10:00:00.000Z" }
    });
  });
  await page.route("**/api/audits/audit-example.com", async route => {
    await reportGate;
    await fulfillJson(route, 200, { audit: createAudit() });
  });

  await page.goto("/");
  await page.getByLabel("Website URL").fill("example.com");
  await page.getByRole("button", { name: /Run audit/ }).click();

  const analysis = page.locator("#analysisExperience");
  const steps = analysis.getByRole("list", { name: "Audit progress" }).getByRole("listitem");
  await expect(analysis).toHaveAttribute("data-analysis-state", "preparing");
  await expect(page.getByRole("heading", { name: "Preparing analysis." })).toBeVisible();
  await expect(page.locator("#analysisStatusText")).toContainText("audit service");
  await expect(steps.nth(0)).toHaveAttribute("aria-current", "step");
  await expect(page.getByRole("button", { name: "Stop waiting" })).toBeVisible();

  releasePost();
  await expect(analysis).toHaveAttribute("data-analysis-state", "queued");
  await expect(page.locator("#analysisGuidance")).toContainText("waiting for an audit worker");
  await expect(page.locator("#analysisGuidance")).toContainText("up to 90 seconds");
  await expect(page.locator("#analysisStatusText")).toContainText("queued");
  await expect(steps.nth(0)).toHaveAttribute("data-step-state", "complete");
  await expect(steps.nth(0)).toContainText("Completed");
  await expect(steps.nth(1)).toHaveAttribute("aria-current", "step");
  await expect(analysis).not.toContainText("%");

  await expect(analysis).toHaveAttribute("data-analysis-state", "running", { timeout: 4_000 });
  await expect(page.locator("#analysisGuidance")).toContainText("observable website signals");
  await expect(page.getByRole("heading", { name: "Analyzing your website." })).toBeVisible();
  await expect(steps.nth(2)).toHaveAttribute("aria-current", "step");
  await expect(page.locator(".noqoriAnalysisProgress span")).toBeVisible();

  await expect(analysis).toHaveAttribute("data-analysis-state", "building", { timeout: 4_000 });
  await expect(page.locator("#analysisGuidance")).toContainText("audit is complete");
  await expect(page.getByRole("heading", { name: "Building your report." })).toBeVisible();
  await expect(steps.nth(3)).toHaveAttribute("aria-current", "step");
  releaseReport();
  await expect(analysis).toHaveAttribute("data-analysis-state", "complete");
  await expect(page.getByRole("heading", { name: "Analysis complete." })).toBeVisible();
  await expect(page.locator("#report")).toBeVisible();
});

test("Stop waiting aborts this tab only and restores the audit form", async ({ page }) => {
  const jobId = await mockQueuedJobCreation(page);
  let postCount = 0;
  let cancelRequests = 0;
  page.on("request", request => {
    if (request.method() === "POST" && request.url().includes("/api/audits")) postCount += 1;
    if (["DELETE", "PATCH"].includes(request.method()) && request.url().includes("/api/audit-jobs/")) cancelRequests += 1;
  });
  await page.route(`**/api/audit-jobs/${jobId}`, async () => new Promise(() => {}));

  await page.goto("/");
  await page.getByLabel("Website URL").fill("example.com");
  await page.getByRole("button", { name: /Run audit/ }).click();
  await expect(page.locator("#analysisExperience")).toHaveAttribute("data-analysis-state", "queued");
  await expect(page.getByText("This stops waiting in this tab.")).toBeVisible();
  await page.getByRole("button", { name: "Stop waiting" }).click();

  await expect(page.locator("#analysisExperience")).toBeHidden();
  await expect(page.getByLabel("Website URL")).toBeFocused();
  await expect(page.getByRole("button", { name: /Run audit/ })).toBeEnabled();
  expect(postCount).toBe(1);
  expect(cancelRequests).toBe(0);
});

test("delayed and reconnecting states keep one existing audit job", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.clock.install({ time: new Date("2026-08-13T10:00:00.000Z") });
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    let simulatedNetworkFailure = false;
    window.fetch = (resource, options) => {
      if (!simulatedNetworkFailure && String(resource).includes("/api/audit-jobs/")) {
        simulatedNetworkFailure = true;
        return Promise.reject(new TypeError("Simulated offline status check"));
      }
      return originalFetch(resource, options);
    };
  });
  const jobId = await mockQueuedJobCreation(page);
  let postCount = 0;
  let pollCount = 0;
  let activePolls = 0;
  let maxActivePolls = 0;
  page.on("request", request => {
    if (request.method() === "POST" && request.url().includes("/api/audits")) postCount += 1;
  });
  await page.route(`**/api/audit-jobs/${jobId}`, async route => {
    pollCount += 1;
    activePolls += 1;
    maxActivePolls = Math.max(maxActivePolls, activePolls);
    await fulfillJson(route, 200, { job: { id: jobId, status: "queued", createdAt: "2026-08-13T10:00:00.000Z" } });
    activePolls -= 1;
  });

  await page.goto("/");
  await page.getByLabel("Website URL").fill("example.com");
  await page.getByRole("button", { name: /Run audit/ }).click();
  await page.clock.runFor(1_100);
  await expect(page.locator("#analysisExperience")).toHaveAttribute("data-analysis-state", "reconnecting");
  await expect(page.locator("#analysisGuidance")).toContainText("No new audit was started");
  await page.clock.runFor(15_000);
  await expect(page.locator("#analysisDelayMessage")).toHaveText("This is taking longer than usual.");
  await expect(page.locator("#analysisDelayMessage")).toBeVisible();
  await expect(page.locator("#analysisExperience")).toHaveAttribute("data-analysis-state", "queued");
  expect(postCount).toBe(1);
  expect(pollCount).toBe(1);
  expect(maxActivePolls).toBe(1);
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
  await expect(page.getByRole("heading", { name: "Your top 3 next actions." })).toBeVisible();
  await expect(page.locator("#report .nqPriorityFinding")).toHaveCount(3);
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
  let postCount = 0;
  page.on("request", request => {
    if (request.method() === "POST" && request.url().includes("/api/audits")) postCount += 1;
  });

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
  await expect(page.getByRole("heading", { name: "We couldn’t complete this analysis." })).toBeVisible();
  await expect(analysis.getByRole("listitem").nth(1)).toHaveAttribute("aria-current", "step");
  await expect(page.getByRole("alert")).toContainText("The website audit timed out. Please try again.");
  const retry = page.getByRole("button", { name: "Edit URL and retry" });
  await expect(retry).toBeVisible();
  await expect(retry).toBeFocused();
  await expect(page.getByText("AUDIT_TIMEOUT", { exact: true })).toBeHidden();
  await page.getByText("Technical details", { exact: true }).click();
  await expect(page.getByText("AUDIT_TIMEOUT", { exact: true })).toBeVisible();
  await page.waitForTimeout(1200);
  expect(pollCount).toBe(1);

  await retry.click();
  await expect(analysis).toBeHidden();
  await expect(page.getByRole("button", { name: /Run audit/ })).toBeVisible();
  await expect(page.getByLabel("Website URL")).toBeFocused();
  expect(postCount).toBe(1);
  await page.getByLabel("Website URL").fill("example.com");
  await page.getByRole("button", { name: /Run audit/ }).click();
  await expect.poll(() => postCount).toBe(2);
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
  await expect(page.getByRole("button", { name: "Edit URL and retry" })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Edit URL and retry" })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Edit URL and retry" })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Edit URL and retry" })).toBeVisible();
});

test("signed-out frontend exposes the temporary backend login requirement safely", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("Enter your website, e.g. luna-cafe.com").fill("example.com");
  await page.getByRole("button", { name: /Run audit/ }).click();

  await expect(page.getByRole("alert")).toContainText("Sign in to continue.");
  await expect(page.getByRole("button", { name: "Edit URL and retry" })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Edit URL and retry" })).toBeVisible();
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

test("completed HTML fallback opens a truthful report without zero Lighthouse metrics", async ({ page }) => {
  const fallbackAudit = createAudit();
  fallbackAudit.scanner = {
    mode: "fallback",
    status: "html-fallback-used",
    adapters: ["fallback"],
    warnings: ["Rendered audit was unavailable; limited HTML fallback checks were used."]
  };
  fallbackAudit.signals = {};
  await mockCompletedAuditFlow(page, { statuses: ["completed"], audit: fallbackAudit });

  await page.goto("/");
  await page.getByLabel("Website URL").fill("example.com");
  await page.getByRole("button", { name: /Run audit/ }).click();

  await expect(page.locator("#report")).toBeVisible();
  await expect(page.getByText("HTML fallback used", { exact: true }).first()).toBeVisible();
  const performance = page.locator("#real-page-performance");
  await expect(performance).toContainText("A limited HTML fallback report is available.");
  await expect(performance).toContainText("Missing Lighthouse values are not displayed as zero.");
  await expect(performance).not.toContainText("0/100");
  await expect(page.locator("#report .nqPriorityFinding")).toHaveCount(3);
});

for (const viewport of [
  { label: "mobile", width: 390, height: 844 },
  { label: "tablet", width: 768, height: 1024 },
  { label: "desktop", width: 1440, height: 900 }
]) {
  test(`report and expanded category avoid horizontal overflow on ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const lab = {
      metrics: { lcpMs: 2800, cls: 0.08, fcpMs: 1700, speedIndexMs: 3100, tbtMs: 180, inpMs: null, inpLabProxy: "TBT" },
      scores: { performance: 78, accessibility: 91, bestPractices: 96, seo: 92 },
      findings: [{ title: "Optimize oversized images", action: "Compress the images identified by Lighthouse." }]
    };
    const audit = createAudit("example.com", lab);
    audit.scanner.status = "full-rendered-completed";
    audit.scanner.mode = "rendered-lighthouse";
    await mockCompletedAuditFlow(page, {
      statuses: ["completed"],
      audit
    });
    await page.goto("/");
    await page.getByLabel("Website URL").fill("example.com");
    await page.getByRole("button", { name: /Run audit/ }).click();
    await expect(page.locator("#report")).toBeVisible();

    const reportMeasurement = await measureHorizontalOverflow(page);
    expect(
      reportMeasurement.rootScrollWidth,
      `Report overflow: ${JSON.stringify(reportMeasurement.offenders)}`
    ).toBeLessThanOrEqual(viewport.width + 1);

    if (viewport.width === 390) {
      const metadataMeasurements = await measureMeaningfulReportMetadata(page);
      const undersizedMetadata = metadataMeasurements.filter(({ fontSize }) => fontSize < 12);
      expect(undersizedMetadata, `Undersized report metadata: ${JSON.stringify(undersizedMetadata)}`).toEqual([]);
    }

    const category = page.locator(".nqCategory").first();
    await category.locator(":scope > summary").click();
    await expect(category).toHaveAttribute("open", "");
    const categoryMeasurement = await measureHorizontalOverflow(page);
    expect(
      categoryMeasurement.rootScrollWidth,
      `Expanded category overflow: ${JSON.stringify(categoryMeasurement.offenders)}`
    ).toBeLessThanOrEqual(viewport.width + 1);
  });
}

// ── Module 06: Legal pages E2E ─────────────────────────────────────────────

test("footer contains working Privacy, Impressum, and Terms links", async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", (e) => browserErrors.push(e.message));

  await page.goto("/");

  const footer = page.locator("footer.nqFooter");
  await expect(footer).toBeVisible();

  const privacyLink = footer.getByRole("link", { name: "Privacy" });
  const impressumLink = footer.getByRole("link", { name: "Impressum" });
  const termsLink = footer.getByRole("link", { name: "Terms" });

  await expect(privacyLink).toBeVisible();
  await expect(impressumLink).toBeVisible();
  await expect(termsLink).toBeVisible();

  await expect(privacyLink).toHaveAttribute("href", "/privacy");
  await expect(impressumLink).toHaveAttribute("href", "/impressum");
  await expect(termsLink).toHaveAttribute("href", "/terms");

  expect(browserErrors).toEqual([]);
});

test("Privacy page loads, shows NOQORI identity, and exposes no console errors", async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", (e) => browserErrors.push(e.message));

  await page.goto("/privacy");

  await expect(page).toHaveTitle(/Privacy Policy.*NOQORI/);
  await expect(page.getByRole("heading", { name: "Privacy Policy", level: 1 })).toBeVisible();
  await expect(page.locator(".nqLegalNotReady")).toBeVisible();
  await expect(page.locator(".nqLegalTocList")).toBeVisible();
  await expect(page.getByRole("link", { name: /Back to NOQORI/ })).toBeVisible();

  // Development warning is visible
  await expect(page.getByText("NOT READY FOR PUBLIC LAUNCH").first()).toBeVisible();

  // Footer legal nav present
  await expect(page.locator(".nqLegalFooterLinks")).toBeVisible();

  expect(browserErrors).toEqual([]);
});

test("Impressum page loads with German headings and no console errors", async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", (e) => browserErrors.push(e.message));

  await page.goto("/impressum");

  await expect(page.getByRole("heading", { name: "Impressum", level: 1 })).toBeVisible();
  await expect(page.locator(".nqLegalNotReady")).toBeVisible();
  await expect(page.locator(".nqLegalTocList")).toBeVisible();
  // Development status shown
  await expect(page.getByText(/NOT READY FOR PUBLIC LAUNCH/).first()).toBeVisible();

  expect(browserErrors).toEqual([]);
});

test("Terms page loads, shows correct headings, and exposes no console errors", async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", (e) => browserErrors.push(e.message));

  await page.goto("/terms");

  await expect(page).toHaveTitle(/Terms of Service.*NOQORI/);
  await expect(page.getByRole("heading", { name: "Terms of Service", level: 1 })).toBeVisible();
  await expect(page.locator(".nqLegalNotReady")).toBeVisible();
  await expect(page.locator(".nqLegalTocList")).toBeVisible();
  await expect(page.getByText("NOT READY FOR PUBLIC LAUNCH").first()).toBeVisible();

  expect(browserErrors).toEqual([]);
});

test("Privacy page has no horizontal overflow at desktop width", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/privacy");
  const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
  expect(bodyWidth).toBeLessThanOrEqual(1440);
});

test("Privacy page has no horizontal overflow at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/privacy");
  const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
  expect(bodyWidth).toBeLessThanOrEqual(390);
});

test("legal pages are keyboard navigable and TOC links work", async ({ page }) => {
  await page.goto("/privacy");

  // TOC links are present and the first one is functional
  const firstTocLink = page.locator(".nqLegalTocList a").first();
  await expect(firstTocLink).toBeVisible();

  const href = await firstTocLink.getAttribute("href");
  expect(href).toMatch(/^#/);

  // Clicking a TOC link scrolls to the section without error
  const browserErrors = [];
  page.on("pageerror", (e) => browserErrors.push(e.message));
  await firstTocLink.click();
  expect(browserErrors).toEqual([]);
});

test("back link on Privacy page navigates to the landing page", async ({ page }) => {
  await page.goto("/privacy");
  const backLink = page.getByRole("link", { name: /Back to NOQORI/ });
  await expect(backLink).toBeVisible();
  await expect(backLink).toHaveAttribute("href", "/");
});

test("existing audit flow is unaffected by Module 06 changes", async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", (e) => browserErrors.push(e.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  const input = page.getByPlaceholder("Enter your website, e.g. luna-cafe.com");
  await expect(input).toBeVisible();
  await expect(page.getByRole("button", { name: /Run audit/ })).toBeVisible();

  expect(browserErrors).toEqual([]);
});
