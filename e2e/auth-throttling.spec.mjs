import { expect, test as base } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/env.mjs";
import { createApp } from "../src/http/app.mjs";

// Each scenario gets real authentication with independent default rate-limit buckets.
const test = base.extend({
  authBaseURL: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "noqori-auth-browser-"));
    const config = loadConfig({
      HOST: "127.0.0.1", PORT: 0, NODE_ENV: "test",
      AUTH_REGISTRATION_MODE: "public",
      DATABASE_FILE_PATH: join(directory, "auth.sqlite")
    });
    const server = createApp(config);
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const baseURL = `http://127.0.0.1:${server.address().port}`;
      // Port 0 is assigned by the OS; fix the trusted origin before any request.
      config.publicOrigin = baseURL;
      await use(baseURL);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  }
});

function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

async function fulfillJson(route, status, payload, headers = {}) {
  await route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(payload) });
}

for (const action of ["login", "register"]) {
  test(`${action} throttling keeps audits gated and permits a successful retry`, async ({ page, request, authBaseURL }) => {
    const email = uniqueEmail(`throttled-${action}`);
    const password = "correct horse battery staple";
    if (action === "login") {
      const registration = await request.post(`${authBaseURL}/api/auth/register`, {
        headers: { Origin: authBaseURL },
        data: { email, password }
      });
      expect(registration.status()).toBe(201);
    }
    let attempts = 0;
    await page.route(`**/api/auth/${action}`, async route => {
      attempts += 1;
      if (attempts === 1) {
        // Exercise the browser's 429 response state; retry uses real auth/storage.
        return fulfillJson(route, 429, {
          error: { code: "RATE_LIMITED", message: "private limiter implementation detail" }
        }, { "Retry-After": "1" });
      }
      return route.continue();
    });
    await page.goto(authBaseURL);
    const emailInput = page.getByLabel(action === "login" ? "Login email" : "Registration email");
    const passwordInput = page.getByLabel(action === "login" ? "Password" : "Create password", { exact: true });
    const submit = page.getByRole("button", {
      name: action === "login" ? "Sign in" : "Create account", exact: true
    });
    await emailInput.fill(email);
    await passwordInput.fill(password);
    await submit.click();
    await expect(page.locator("#authError")).toHaveText("Too many attempts. Please wait before trying again.");
    await expect(page.getByRole("button", { name: /Run audit/ })).toBeHidden();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeHidden();
    await expect(page.getByText("private limiter implementation detail")).toHaveCount(0);
    await expect(emailInput).toBeEnabled();
    await expect(passwordInput).toBeEnabled();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByText(email, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Run audit/ })).toBeVisible();
    await expect(page.locator("#authError")).toBeHidden();
    expect(attempts).toBe(2);
    await page.reload();
    await expect(page.getByText(email, { exact: true })).toBeVisible();
  });
}

