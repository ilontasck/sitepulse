import { expect, test } from "@playwright/test";

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
  expect(browserErrors).toEqual([]);

  await page.getByRole("button", { name: "Analyze another" }).click();
  await expect(page.getByPlaceholder("Enter your website, e.g. luna-cafe.com")).toBeVisible();
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

test("unsafe localhost URL is blocked with a readable error", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);

  await page.goto("/");

  await page.getByPlaceholder("Enter your website, e.g. luna-cafe.com").fill("http://127.0.0.1:3000");
  await page.getByRole("button", { name: /Run audit/ }).click();

  await expect(page.getByText("Private or internal website addresses cannot be scanned.")).toBeVisible();
  await expect(page.locator("#report")).toBeHidden();
  expect(browserErrors).toEqual([]);
});
